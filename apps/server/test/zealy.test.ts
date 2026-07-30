import { describe, expect, it } from 'vitest';
import { parseZealyCheck, parseZealyProfileId, ZEALY_GOALS, zealyPayloadKeys, zealyStats, zealyUserIdFromBody, zealyVerdict, zealyWalletFromBody, type ZealyGame, type ZealyStats } from '../src/zealy.js';

// The sprint's API quests are auto-approved from these rules alone, with real
// money at the end — every filter here IS a prize-integrity rule.

const W = '0x743bb002b6f925442be7f6ae0a3f9d56ed15cd7b';
const TODAY = '2026-07-27';

function game(over: Partial<ZealyGame>): ZealyGame {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    opponent: over.opponent ?? '0xopp1',
    won: over.won ?? true,
    reason: over.reason ?? 'finish',
    endedAt: over.endedAt ?? `${TODAY}T10:00:00.000Z`,
    isHouseBot: over.isHouseBot ?? false,
  };
}

describe('zealyWalletFromBody — the wallet Zealy sends', () => {
  it('reads accounts.wallet and lowercases it', () => {
    expect(zealyWalletFromBody({ accounts: { wallet: W.toUpperCase().replace('0X', '0x') } })).toBe(W);
  });

  it('falls back to a top-level wallet', () => {
    expect(zealyWalletFromBody({ wallet: W })).toBe(W);
  });

  it('rejects anything that is not a 0x address (no wallet linked)', () => {
    expect(zealyWalletFromBody({ accounts: { wallet: 'bacta.eth' } })).toBeNull();
    expect(zealyWalletFromBody({ accounts: {} })).toBeNull();
    expect(zealyWalletFromBody(null)).toBeNull();
    expect(zealyWalletFromBody('0x123')).toBeNull();
  });
});

describe('parseZealyCheck', () => {
  it('accepts exactly the six known checks', () => {
    for (const c of ['mint', 'games1', 'games4', 'daily4', 'win3', 'marathon25']) expect(parseZealyCheck(c)).toBe(c);
  });
  it('rejects unknowns', () => {
    expect(parseZealyCheck('drain-the-pool')).toBeNull();
    expect(parseZealyCheck(null)).toBeNull();
  });
});

describe('zealyStats — the filters ARE the sprint rules', () => {
  it('counts only genuine finishes: abandons are not completed games', () => {
    const s = zealyStats(
      [game({}), game({ reason: 'resign' }), game({ reason: 'timeout-forfeit' })],
      TODAY,
      new Set(),
    );
    expect(s.finished).toBe(1);
  });

  it('a house-bot game COUNTS for the player — the fill bot is a real staked opponent', () => {
    // Operator decision at sprint launch: a solo player matched with the
    // liquidity fill must not see "0/4" after 4 real games. The bot itself
    // earns nothing (no Zealy account), and farming it is bounded by the
    // per-pair daily cap + the house runway it costs.
    const s = zealyStats([game({ isHouseBot: true, won: true })], TODAY, new Set());
    expect(s.finished).toBe(1);
    expect(s.winsToday).toBe(1);
  });

  it('the bot is only ever ONE distinct opponent (marathon still needs humans)', () => {
    const s = zealyStats(
      [game({ opponent: '0xbot', isHouseBot: true }), game({ opponent: '0xbot', isHouseBot: true }), game({ opponent: '0xhuman' })],
      TODAY,
      new Set(),
    );
    expect(s.opponents).toBe(2);
  });

  it('a game the anti-farm audit voided never happened', () => {
    const s = zealyStats([game({ id: 'farmed' })], TODAY, new Set(['farmed']));
    expect(s.finished).toBe(0);
  });

  it('splits today (UTC) from the sprint total, wins included', () => {
    const s = zealyStats(
      [
        game({ endedAt: '2026-07-26T23:59:00.000Z', won: true }), // yesterday
        game({ endedAt: `${TODAY}T00:01:00.000Z`, won: true }),
        game({ endedAt: `${TODAY}T12:00:00.000Z`, won: false }),
      ],
      TODAY,
      new Set(),
    );
    expect(s.finished).toBe(3);
    expect(s.finishedToday).toBe(2);
    expect(s.winsToday).toBe(1);
  });

  it('counts DISTINCT opponents (the marathon anti-pair rule)', () => {
    const s = zealyStats(
      [game({ opponent: '0xa' }), game({ opponent: '0xa' }), game({ opponent: '0xb' })],
      TODAY,
      new Set(),
    );
    expect(s.opponents).toBe(2);
  });
});

describe('zealyVerdict — what the player is told', () => {
  const base: ZealyStats = { minted: true, finished: 0, finishedToday: 0, winsToday: 0, opponents: 0 };

  it('every game check demands the Race Pass first', () => {
    for (const check of ['games1', 'games4', 'daily4', 'win3', 'marathon25'] as const) {
      const v = zealyVerdict(check, { ...base, minted: false, finished: 99, finishedToday: 9, winsToday: 9, opponents: 9 });
      expect(v.ok).toBe(false);
      expect(v.message).toContain('Race Pass');
    }
  });

  it('mint rejections echo the wallet Zealy sent — the mismatch must be visible', () => {
    const W = '0x743bb002b6f925442be7f6ae0a3f9d56ed15cd7b';
    const v = zealyVerdict('mint', { ...base, minted: false }, W);
    expect(v.message).toContain('0x743b');
    expect(v.message).toContain('cd7b');
    const gate = zealyVerdict('daily4', { ...base, minted: false }, W);
    expect(gate.message).toContain('0x743b');
    // no wallet → graceful generic wording, never "undefined"
    expect(zealyVerdict('mint', { ...base, minted: false }).message).toContain('your linked wallet');
  });

  it('mint: pass/fail on the grant registry', () => {
    expect(zealyVerdict('mint', base).ok).toBe(true);
    expect(zealyVerdict('mint', { ...base, minted: false }).ok).toBe(false);
  });

  it('games1 (activation): ONE finished game is the whole bar', () => {
    // The rung that catches a player right after the mint — if this ever needs
    // more than one game it has stopped being an activation quest.
    expect(ZEALY_GOALS.games1).toBe(1);
    expect(zealyVerdict('games1', { ...base, finished: 1 }).ok).toBe(true);
    const none = zealyVerdict('games1', base);
    expect(none.ok).toBe(false);
    // The rejection must POINT somewhere (Race tab) and set the expectation
    // (3 minutes) — "0/1" alone tells a brand-new player nothing.
    expect(none.message).toContain('Race tab');
    expect(none.message).toContain('3 minutes');
  });

  it('games1 rejections echo the wallet, like every other gate', () => {
    const W = '0x743bb002b6f925442be7f6ae0a3f9d56ed15cd7b';
    expect(zealyVerdict('games1', base, W).message).toContain('0x743b');
  });

  it('games4 & daily4 & win3: thresholds from ZEALY_GOALS', () => {
    expect(zealyVerdict('games4', { ...base, finished: ZEALY_GOALS.games4 }).ok).toBe(true);
    expect(zealyVerdict('games4', { ...base, finished: ZEALY_GOALS.games4 - 1 }).ok).toBe(false);
    expect(zealyVerdict('daily4', { ...base, finishedToday: ZEALY_GOALS.daily4 }).ok).toBe(true);
    expect(zealyVerdict('daily4', { ...base, finishedToday: ZEALY_GOALS.daily4 - 1 }).ok).toBe(false);
    expect(zealyVerdict('win3', { ...base, winsToday: ZEALY_GOALS.win3 }).ok).toBe(true);
    expect(zealyVerdict('win3', { ...base, winsToday: ZEALY_GOALS.win3 - 1 }).ok).toBe(false);
  });

  it('marathon25 needs BOTH the volume and the distinct opponents', () => {
    expect(zealyVerdict('marathon25', { ...base, finished: 25, opponents: 3 }).ok).toBe(true);
    expect(zealyVerdict('marathon25', { ...base, finished: 25, opponents: 2 }).ok).toBe(false);
    expect(zealyVerdict('marathon25', { ...base, finished: 24, opponents: 5 }).ok).toBe(false);
  });

  it('rejections carry the progress, not a bare no', () => {
    const v = zealyVerdict('daily4', { ...base, finishedToday: 2 });
    expect(v.message).toContain('2/4');
  });
});

describe('Zealy Connect — the burner path to API quests', () => {
  const UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  it('parseZealyProfileId: accepts the pasted profile LINK, raw id, query/hash noise', () => {
    expect(parseZealyProfileId(`https://zealy.io/cw/ludoarena/users/${UUID}`)).toBe(UUID);
    expect(parseZealyProfileId(`https://zealy.io/cw/ludoarena/users/${UUID}?ref=abc#top`)).toBe(UUID);
    expect(parseZealyProfileId(UUID.toUpperCase())).toBe(UUID);
    expect(parseZealyProfileId('  my_handle-42  ')).toBe('my_handle-42');
  });

  it('parseZealyProfileId: rejects junk — too short, spaces, bare community URLs', () => {
    expect(parseZealyProfileId('abc')).toBeNull();
    expect(parseZealyProfileId('hello world')).toBeNull();
    expect(parseZealyProfileId('https://zealy.io/cw/')).toBeNull();
    expect(parseZealyProfileId(null)).toBeNull();
  });

  it('zealyUserIdFromBody: tolerant to the payload shapes Zealy has used', () => {
    expect(zealyUserIdFromBody({ accounts: { 'zealy-connect': UUID } })).toBe(UUID);
    expect(zealyUserIdFromBody({ accounts: { zealyConnect: UUID } })).toBe(UUID);
    expect(zealyUserIdFromBody({ userId: UUID })).toBe(UUID);
    expect(zealyUserIdFromBody({ id: UUID.toUpperCase() })).toBe(UUID);
    expect(zealyUserIdFromBody({ user: { id: UUID } })).toBe(UUID);
    expect(zealyUserIdFromBody({ accounts: { wallet: '0xabc' } })).toBeNull();
    expect(zealyUserIdFromBody(null)).toBeNull();
  });

  it('zealyPayloadKeys: key NAMES only, never values (safe for logs)', () => {
    const probe = zealyPayloadKeys({ requestId: 'secret-value', accounts: { email: 'x@y.z' } });
    expect(probe).toContain('requestId');
    expect(probe).toContain('accounts:[email]');
    expect(probe).not.toContain('secret-value');
    expect(probe).not.toContain('x@y.z');
    expect(zealyPayloadKeys(null)).toBe('(none)');
  });
});
