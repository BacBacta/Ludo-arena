/**
 * Regression guard for the local-bot "frozen die". Drives the REAL LocalBotSession
 * (apps/web/src/lib/session.ts), wires its events through a faithful copy of the store
 * reducer transitions (App.tsx makeEvents) and the EXACT GameScreen derivations, then
 * plays as the human. A "freeze" = the engine is waiting for seat 0 but the UI shows
 * nothing the human can do (die hidden/disabled AND no tappable token), all timers drained.
 *
 * This guards the STATE-MACHINE freeze that shipped once: LocalBotSession must publish
 * game.state (onState) whenever a roll passes the turn (multi-choice pick AND no-legal-move
 * handback), mirroring the server. Historically 316/400 random games froze without it.
 * (The separate base-slot rendering freeze is a Board concern, not exercised here.)
 */
import { vi, describe, it, expect } from 'vitest';

// Shim browser globals BEFORE importing the session's module graph.
vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  g.sessionStorage = g.localStorage;
  if (!g.navigator) g.navigator = { userAgent: 'node', language: 'en', hardwareConcurrency: 4 };
});

import { LocalBotSession, type SessionEvents } from '../src/lib/session';
import type { GameState } from '@ludo/game-engine';

// ---- scripted dice: when the queue is non-empty, force LocalBotSession.die() -> that value ----
let diceQueue: number[] = [];
const realCrypto = globalThis.crypto;
vi.stubGlobal('crypto', {
  ...realCrypto,
  getRandomValues<T extends ArrayBufferView | null>(arr: T): T {
    if (arr instanceof Uint32Array && arr.length === 1 && diceQueue.length > 0) {
      arr[0] = (diceQueue.shift()! - 1) >>> 0; // die = 1 + (buf[0] % 6)
      return arr;
    }
    return realCrypto.getRandomValues(arr as unknown as Uint32Array) as unknown as T;
  },
});

interface UiState {
  game: GameState | null;
  activeTurn: number;
  lastDice: { value: number; index: number; seat: number } | null;
  over: boolean;
}

interface Derived {
  myTurn: boolean;
  canRoll: boolean;
  needPick: boolean;
  movableCount: number;
  handoff: boolean;
  dieVisible: boolean;
}

/** Faithful copy of the GameScreen derivations (mySeat = 0 for bot games), steady-state
 *  (myRolling has lapsed once timers are drained, so dieVisible = myTurn && !handoff). */
function derive(ui: UiState): Derived {
  const g = ui.game!;
  const myTurn = ui.activeTurn === 0;
  const canRoll = myTurn && g.turn === 0 && g.phase === 'awaiting-roll';
  const needPick = myTurn && g.turn === 0 && g.phase === 'awaiting-move' && g.legal.length > 1;
  const movableCount = g.turn === 0 && g.phase === 'awaiting-move' ? g.legal.length : 0;
  const handoff = myTurn && g.turn !== 0;
  const dieVisible = myTurn && !handoff;
  return { myTurn, canRoll, needPick, movableCount, handoff, dieVisible };
}

interface RunResult {
  frozen: boolean;
  reason: string;
  diceHistory: Array<{ seat: number; value: number }>;
  finalEngine?: { turn: number; phase: string; legal: number[] };
  finalUi?: UiState;
  finalDerived?: Derived;
  steps: number;
}

/** Play one full bot game driving the real session. `scriptDie` supplies the human's dice
 *  (and the bot's — die() is shared); return undefined for a random roll. */
function playGame(nextDie: (() => number | undefined) | null): RunResult {
  vi.useFakeTimers();
  const ui: UiState = { game: null, activeTurn: -1, lastDice: null, over: false };
  const diceHistory: Array<{ seat: number; value: number }> = [];

  const handlers: Partial<SessionEvents> = {
    onMatchFound: () => {
      /* seat 0, nothing else needed */
    },
    onState: (g) => {
      ui.game = g;
    },
    onDice: (value, index, seat) => {
      ui.lastDice = { value, index, seat };
      diceHistory.push({ seat, value });
    },
    onMoved: (g) => {
      ui.game = g;
    },
    onTurn: (seat) => {
      ui.activeTurn = seat;
    },
    onOver: () => {
      ui.over = true;
    },
  };
  const ev = new Proxy(handlers, {
    get: (t, p) => (p in t ? (t as Record<string | symbol, unknown>)[p] : () => {}),
  }) as unknown as SessionEvents;

  const flush = (): void => {
    let guard = 0;
    while (vi.getTimerCount() > 0 && guard++ < 5000) vi.advanceTimersByTime(200);
  };

  const session = new LocalBotSession(ev, 0);
  flush(); // match-found (1400ms) + initial onState/onTurn(0)

  let steps = 0;
  let result: RunResult = { frozen: false, reason: 'game over / step cap', diceHistory, steps: 0 };

  for (; steps < 400; steps++) {
    if (ui.over) {
      result = { frozen: false, reason: 'game over', diceHistory, steps };
      break;
    }
    if (!ui.game) {
      result = { frozen: true, reason: 'no game state ever delivered', diceHistory, steps };
      break;
    }
    const s = (session as unknown as { state: GameState }).state; // engine truth
    const d = derive(ui);

    const snapshot = (reason: string): RunResult => ({
      frozen: true,
      reason,
      diceHistory,
      steps,
      finalEngine: { turn: s.turn, phase: s.phase, legal: [...s.legal] },
      finalUi: { ...ui, game: ui.game },
      finalDerived: d,
    });

    if (s.turn === 0 && s.phase === 'awaiting-roll') {
      // Engine wants the human to ROLL.
      if (!d.canRoll || !d.dieVisible) {
        result = snapshot('engine awaits seat-0 ROLL but UI cannot roll (die hidden/disabled)');
        break;
      }
      if (nextDie) {
        const v = nextDie();
        if (v !== undefined) diceQueue.push(v);
      }
      session.roll();
      flush();
    } else if (s.turn === 0 && s.phase === 'awaiting-move') {
      // Engine wants the human to MOVE (multi-choice; a single legal move auto-plays via timer,
      // so a settled awaiting-move here means a real pick is required).
      if (d.movableCount === 0) {
        result = snapshot('engine awaits seat-0 MOVE but UI shows no tappable token');
        break;
      }
      session.move(s.legal[0]!);
      flush();
    } else {
      // Engine turn is the bot (1) or over, yet timers are drained → the bot should have moved.
      if (s.turn === 1) {
        result = snapshot('bot turn stalled: timers drained but bot never acted');
        break;
      }
      result = { frozen: false, reason: `settled at turn=${s.turn} phase=${s.phase}`, diceHistory, steps };
      break;
    }
  }

  session.dispose();
  vi.useRealTimers();
  diceQueue = [];
  return result;
}

function fmt(r: RunResult): string {
  const dice = r.diceHistory.map((d) => `${d.seat === 0 ? 'H' : 'B'}${d.value}`).join(' ');
  return [
    `reason: ${r.reason}`,
    `steps: ${r.steps}`,
    r.finalEngine ? `engine: turn=${r.finalEngine.turn} phase=${r.finalEngine.phase} legal=[${r.finalEngine.legal}]` : '',
    r.finalUi ? `ui: game.turn=${r.finalUi.game?.turn} game.phase=${r.finalUi.game?.phase} activeTurn=${r.finalUi.activeTurn} lastDice=${r.finalUi.lastDice ? `${r.finalUi.lastDice.seat}:${r.finalUi.lastDice.value}` : 'none'}` : '',
    r.finalDerived ? `derived: canRoll=${r.finalDerived.canRoll} handoff=${r.finalDerived.handoff} dieVisible=${r.finalDerived.dieVisible} movable=${r.finalDerived.movableCount}` : '',
    `dice(H=human,B=bot): ${dice}`,
  ].filter(Boolean).join('\n  ');
}

describe('LocalBotSession freeze detector (drives the REAL session)', () => {
  it('fuzz: no random bot game ever freezes the human', () => {
    const freezes: RunResult[] = [];
    for (let i = 0; i < 400; i++) {
      const r = playGame(null); // random dice
      if (r.frozen) freezes.push(r);
    }
    if (freezes.length) {
      const shown = freezes.slice(0, 5).map((r, i) => `FREEZE #${i + 1}\n  ${fmt(r)}`).join('\n\n');
      throw new Error(`${freezes.length}/400 games froze.\n\n${shown}`);
    }
    expect(freezes.length).toBe(0);
  });

  it('scripted: human rolls a 6 (extra turn) and keeps control', () => {
    // Human: 6 (out) -> 6 (2nd out) -> 6 (move, extra) -> 2 ... ; bot gets non-6s (no move / minimal).
    const script = [6, 6, 6, 2, 3, 4, 5, 2, 3, 4, 5, 6, 2, 3, 4, 5];
    let k = 0;
    const r = playGame(() => script[k++ % script.length]);
    if (r.frozen) throw new Error(`Scripted 6-run froze:\n  ${fmt(r)}`);
    expect(r.frozen).toBe(false);
  });
});
