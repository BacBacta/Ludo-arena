/**
 * Anti-abuse policy — every threshold in ONE place, read from the environment.
 *
 * WHY. These numbers decide who may play whom on a real-money event, and they
 * need retuning from operations (a market where shared devices are normal, a
 * test session with two handsets, a farming wave) WITHOUT a code change and a
 * deploy. Half of them were already env-tunable and half were hard-coded, with
 * no way to tell which from the outside.
 *
 * PARSING IS DELIBERATELY STRICT. The previous idiom was
 * `Number(process.env.X ?? '3')`, which turns a typo into `NaN` — and every
 * guard here is a `>=` comparison, so `NaN` reads as FALSE and the protection
 * disappears silently. A mistyped Fly secret must never be able to switch an
 * anti-farm gate off; an unparseable value keeps the shipped default and says
 * so on stderr.
 *
 * Pure and env-injected so the semantics are unit-tested (same shape as geo.ts
 * and clientIp.ts).
 */

export type Env = Record<string, string | undefined>;

/**
 * An integer setting. Falls back to `fallback` when absent, blank, or not a
 * finite number — never to NaN. `min` floors the result so a hostile 0 or a
 * negative cannot disable a guard that expects a positive bound.
 */
export function envInt(env: Env, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[policy] ${name}="${raw}" is not a number — keeping the default ${fallback}.`);
    return fallback;
  }
  return Math.max(min, Math.trunc(n));
}

/**
 * A boolean setting. ONLY the explicit words below flip it; anything else keeps
 * the default and warns. A guard must not be turned off by a stray value.
 */
export function envBool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  console.warn(`[policy] ${name}="${raw}" is not a boolean — keeping the default ${fallback}.`);
  return fallback;
}

export interface RacePolicy {
  /** Anti-spam window shared by race.seed and race.claim (both send a tx). */
  readonly actionWindowMs: number;
  /** A lone Race seeker waits this long before the house bot may fill in. */
  readonly botFallbackMs: number;
  /** Past this, the bot fills in even with a human queued (stuck-peer valve). */
  readonly botHardFallbackMs: number;
  /** Games today between the same two Race wallets before the seeker is routed
   *  to the bot instead. 0 disables the intercept. */
  readonly collusionPairCap: number;
  /** Same as above for two players on ONE network — tighter, never zero-tolerance:
   *  carrier-grade NAT puts thousands of unrelated mobile players behind one
   *  address. 0 disables the tightening (they then use collusionPairCap). */
  readonly collusionSameIpPairCap: number;
  /** Staked games per day against the SAME opponent before the pairing is refused. */
  readonly maxDailyVsSame: number;
  /** Refuse a staked pairing between two sessions with the same device
   *  fingerprint. Operators testing with two profiles on one handset turn this
   *  off; it must stay ON in production. */
  readonly blockSameDevice: boolean;
  /** Refuse a staked pairing between two sessions on the same IP. Off is
   *  reasonable in CGNAT-heavy markets, where "same IP" says very little. */
  readonly blockSameNetwork: boolean;
}

export const RACE_POLICY_DEFAULTS: RacePolicy = {
  actionWindowMs: 3_000,
  botFallbackMs: 12_000,
  botHardFallbackMs: 90_000,
  collusionPairCap: 3,
  collusionSameIpPairCap: 2,
  maxDailyVsSame: 3,
  blockSameDevice: true,
  blockSameNetwork: true,
};

export function racePolicy(env: Env, defaults: RacePolicy = RACE_POLICY_DEFAULTS): RacePolicy {
  return {
    // Floors of 1 where 0 would mean "no window at all" (a tx per keystroke).
    actionWindowMs: envInt(env, 'RACE_ACTION_WINDOW_MS', defaults.actionWindowMs, 0),
    botFallbackMs: envInt(env, 'RACE_BOT_FALLBACK_MS', defaults.botFallbackMs, 0),
    botHardFallbackMs: envInt(env, 'RACE_BOT_HARD_FALLBACK_MS', defaults.botHardFallbackMs, 0),
    collusionPairCap: envInt(env, 'RACE_COLLUSION_PAIR_CAP', defaults.collusionPairCap, 0),
    collusionSameIpPairCap: envInt(env, 'RACE_COLLUSION_SAME_IP_PAIR_CAP', defaults.collusionSameIpPairCap, 0),
    maxDailyVsSame: envInt(env, 'RACE_MAX_DAILY_VS_SAME', defaults.maxDailyVsSame, 1),
    blockSameDevice: envBool(env, 'STAKE_BLOCK_SAME_DEVICE', defaults.blockSameDevice),
    blockSameNetwork: envBool(env, 'STAKE_BLOCK_SAME_NETWORK', defaults.blockSameNetwork),
  };
}

/** One line per RELAXED guard, for the boot log. Silence means "all defaults" —
 *  an operator reading the logs after an incident must be able to see at a
 *  glance that a protection was loosened, not have to diff the secrets. */
export function relaxationWarnings(p: RacePolicy, defaults: RacePolicy = RACE_POLICY_DEFAULTS): string[] {
  const out: string[] = [];
  if (!p.blockSameDevice) out.push('STAKE_BLOCK_SAME_DEVICE=false — two sessions on ONE device may stake against each other.');
  if (!p.blockSameNetwork) out.push('STAKE_BLOCK_SAME_NETWORK=false — two sessions on ONE network may stake against each other.');
  if (p.collusionPairCap === 0) out.push('RACE_COLLUSION_PAIR_CAP=0 — the repeated-opponent intercept is OFF.');
  if (p.maxDailyVsSame > defaults.maxDailyVsSame) out.push(`RACE_MAX_DAILY_VS_SAME=${p.maxDailyVsSame} (default ${defaults.maxDailyVsSame}) — more staked games allowed against one opponent.`);
  if (p.collusionPairCap > defaults.collusionPairCap) out.push(`RACE_COLLUSION_PAIR_CAP=${p.collusionPairCap} (default ${defaults.collusionPairCap}).`);
  return out;
}
