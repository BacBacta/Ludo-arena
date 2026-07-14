/**
 * Ludo Arena — game-engine simulation & invariant harness.
 *
 * Plays a large number of 2-player and 4-player games with mixed strategies and
 * random dice, and after EVERY transition asserts a battery of structural + rule
 * invariants. It also injects ADVERSARIAL inputs (illegal moves, wrong phase,
 * invalid dice, out-of-turn) and asserts the engine rejects them without
 * corrupting state. Deterministic (seeded) so every finding is reproducible.
 *
 * Run: npx tsx sim/engine.ts [--games=20000] [--seed=1]
 * Exit code 1 if any invariant is violated (CI-friendly).
 */
import {
  newGame, applyRoll, applyMove, legalMoves, pickAutoMove, absCell, otherSeat,
  FINISHED, SAFE_CELLS, TRACK_LEN, LAST_TRACK_REL,
  newGame4, applyRoll4, applyMove4, legalMoves4, pickAutoMove4,
  SEATS4, TOKENS4, SEAT_START4,
  type GameState, type Game4,
} from '../packages/game-engine/src/index.js';

// ----------------------------------------------------------------- rng (seeded)
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const die = (rng: () => number): number => 1 + Math.floor(rng() * 6);

// ----------------------------------------------------------------- findings
interface Finding { mode: string; kind: string; detail: string; seed: number; rolls: number }
const findings: Finding[] = [];
const seen = new Set<string>();
function report(mode: string, kind: string, detail: string, seed: number, rolls: number): void {
  const key = `${mode}|${kind}|${detail}`;
  if (seen.has(key)) return; // dedupe identical violations (keep the report readable)
  seen.add(key);
  findings.push({ mode, kind, detail, seed, rolls });
}
function assert(cond: boolean, mode: string, kind: string, detail: string, seed: number, rolls: number): void {
  if (!cond) report(mode, kind, detail, seed, rolls);
}
function expectThrow(fn: () => unknown, mode: string, kind: string, detail: string, seed: number, rolls: number): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) report(mode, kind, detail, seed, rolls);
}

// ================================================================= 2-PLAYER
const TOKENS2 = 2;

/** Deep structural + rule invariants on a 2p state (checked every transition). */
function inv2(g: GameState, seed: number): void {
  const R = g.rollCount;
  // structural
  assert(g.positions.length === 2, '2p', 'STRUCT', `seat count ${g.positions.length}`, seed, R);
  for (let s = 0; s < 2; s++) {
    const row = g.positions[s]!;
    assert(row.length === TOKENS2, '2p', 'STRUCT', `token count seat ${s}=${row.length}`, seed, R);
    for (const p of row) {
      assert(p === -1 || (p >= 0 && p <= FINISHED), '2p', 'RANGE', `pos ${p} out of [-1,${FINISHED}]`, seed, R);
      assert(Number.isInteger(p), '2p', 'RANGE', `pos ${p} not integer`, seed, R);
    }
  }
  assert(g.turn === 0 || g.turn === 1, '2p', 'STRUCT', `turn ${g.turn}`, seed, R);
  // legal set must exactly equal a fresh recomputation while awaiting-move
  if (g.phase === 'awaiting-move') {
    assert(g.dice !== null, '2p', 'STATE', 'awaiting-move with null dice', seed, R);
    const fresh = legalMoves(g, g.turn, g.dice!).slice().sort();
    const cur = g.legal.slice().sort();
    assert(JSON.stringify(fresh) === JSON.stringify(cur), '2p', 'LEGAL', `legal ${JSON.stringify(cur)} != recompute ${JSON.stringify(fresh)}`, seed, R);
    assert(g.legal.length > 0, '2p', 'LEGAL', 'awaiting-move with empty legal', seed, R);
  }
  if (g.phase === 'awaiting-roll') {
    assert(g.dice === null && g.legal.length === 0, '2p', 'STATE', 'awaiting-roll with dice/legal set', seed, R);
  }
  // win consistency
  if (g.phase === 'over') {
    assert(g.winner === 0 || g.winner === 1, '2p', 'WIN', `over with winner ${g.winner}`, seed, R);
    assert(g.positions[g.winner!]!.every((p) => p === FINISHED), '2p', 'WIN', 'winner not all-finished', seed, R);
  } else {
    assert(g.winner === null, '2p', 'WIN', `non-over winner ${g.winner}`, seed, R);
    // nobody may be all-finished while the game is not over
    for (let s = 0; s < 2; s++) {
      assert(!g.positions[s]!.every((p) => p === FINISHED), '2p', 'WIN', `seat ${s} all-finished but not over`, seed, R);
    }
  }
  // sixStreak sane
  assert(g.sixStreak >= 0 && g.sixStreak <= 2, '2p', 'SIX', `sixStreak ${g.sixStreak} (should reset at 3)`, seed, R);
}

/** Adversarial probes on a 2p state — the engine MUST reject these. */
function adversarial2(g: GameState, seed: number): void {
  const R = g.rollCount;
  if (g.phase === 'awaiting-roll') {
    expectThrow(() => applyMove(g, 0), '2p', 'ADV', 'applyMove accepted in awaiting-roll', seed, R);
    for (const bad of [0, 7, -1, 1.5, NaN]) {
      expectThrow(() => applyRoll(g, bad as number), '2p', 'ADV', `applyRoll accepted invalid die ${bad}`, seed, R);
    }
  }
  if (g.phase === 'awaiting-move') {
    expectThrow(() => applyRoll(g, 6), '2p', 'ADV', 'applyRoll accepted in awaiting-move', seed, R);
    // any token NOT in legal must be rejected (illegal-move guard)
    for (let t = 0; t < TOKENS2; t++) {
      if (!g.legal.includes(t)) expectThrow(() => applyMove(g, t), '2p', 'ADV', `applyMove accepted illegal token ${t}`, seed, R);
    }
    expectThrow(() => applyMove(g, 99), '2p', 'ADV', 'applyMove accepted out-of-range token 99', seed, R);
  }
  if (g.phase === 'over') {
    expectThrow(() => applyRoll(g, 6), '2p', 'ADV', 'applyRoll accepted after game over', seed, R);
  }
}

function play2(seed: number, strategy: 'random' | 'auto' | 'mixed'): void {
  const rng = mulberry32(seed);
  let g = newGame();
  inv2(g, seed);
  const MAX = 5000;
  let capturesSeen = false, finishSeen = false;
  while (g.phase !== 'over') {
    if (g.rollCount > MAX) { report('2p', 'TERMINATION', `not finished in ${MAX} rolls`, seed, g.rollCount); return; }
    adversarial2(g, seed);
    const before = g.turn;
    const d = die(rng);
    const rolled = applyRoll(g, d);
    inv2(rolled, seed);
    // roll-phase transition invariants
    if (rolled.phase === 'awaiting-roll') {
      // no legal move OR 3-sixes burn → turn must have passed to the other seat
      assert(rolled.turn === otherSeat(before), '2p', 'TURN', `no-move roll kept the turn`, seed, rolled.rollCount);
    }
    g = rolled;
    if (g.phase === 'awaiting-move') {
      let token: number;
      if (strategy === 'random') token = g.legal[Math.floor(rng() * g.legal.length)]!;
      else if (strategy === 'auto') token = pickAutoMove(g, g.turn, g.dice!) ?? g.legal[0]!;
      else token = rng() < 0.5 ? g.legal[Math.floor(rng() * g.legal.length)]! : (pickAutoMove(g, g.turn, g.dice!) ?? g.legal[0]!);
      const posBefore = g.positions.map((r) => [...r]);
      const seat = g.turn;
      const dice = g.dice!;
      const res = applyMove(g, token);
      inv2(res.state, seed);
      // ---- move-result invariants
      const ev = res.events;
      capturesSeen ||= ev.capture; finishSeen ||= ev.finished;
      // exact-finish: no overshoot
      const np = res.state.positions[seat]![token]!;
      assert(np <= FINISHED, '2p', 'MOVE', `token overshot FINISHED to ${np}`, seed, res.state.rollCount);
      // extraTurn rule: (6 || capture || finish) && !won  <=>  turn unchanged
      const keptTurn = res.state.turn === seat && res.state.phase !== 'over';
      const shouldKeep = !ev.won && (dice === 6 || ev.capture || ev.finished);
      assert(keptTurn === shouldKeep, '2p', 'EXTRA', `extraTurn mismatch: kept=${keptTurn} should=${shouldKeep} (die=${dice},cap=${ev.capture},fin=${ev.finished})`, seed, res.state.rollCount);
      // capture: exactly the lone opponent token that shared the destination cell went home
      if (ev.capture) {
        const opp = otherSeat(seat);
        const cell = absCell(seat, np);
        assert(cell !== null && !SAFE_CELLS.has(cell), '2p', 'CAPTURE', `capture on null/safe cell ${cell}`, seed, res.state.rollCount);
        const oppHomeCount = res.state.positions[opp]!.filter((p) => p === -1).length;
        const oppHomeBefore = posBefore[opp]!.filter((p) => p === -1).length;
        assert(oppHomeCount === oppHomeBefore + 1, '2p', 'CAPTURE', `capture did not send exactly one token to base`, seed, res.state.rollCount);
      }
      // conservation: no token vanished/duplicated
      for (let s = 0; s < 2; s++) assert(res.state.positions[s]!.length === TOKENS2, '2p', 'CONSERVE', `seat ${s} token count changed`, seed, res.state.rollCount);
      g = res.state;
    }
  }
  // determinism: replay same seed → identical final state
}

// ================================================================= 4-PLAYER
function absCell4(seat: number, rel: number): number | null {
  if (rel < 0 || rel > LAST_TRACK_REL) return null;
  return ((SEAT_START4[seat] ?? 0) + rel) % TRACK_LEN;
}
function inv4(g: Game4, seed: number): void {
  const R = g.rollCount ?? 0;
  assert(g.positions.length === SEATS4, '4p', 'STRUCT', `seat count ${g.positions.length}`, seed, R);
  for (let s = 0; s < SEATS4; s++) {
    const row = g.positions[s]!;
    assert(row.length === TOKENS4, '4p', 'STRUCT', `token count seat ${s}=${row.length}`, seed, R);
    for (const p of row) assert(p === -1 || (Number.isInteger(p) && p >= 0 && p <= FINISHED), '4p', 'RANGE', `pos ${p}`, seed, R);
  }
  assert(g.turn >= 0 && g.turn < SEATS4, '4p', 'STRUCT', `turn ${g.turn}`, seed, R);
  // a seat listed in `done` must actually be all-finished, and the turn must never rest on a done seat
  for (const s of g.done) assert(g.positions[s]!.every((p) => p === FINISHED), '4p', 'DONE', `seat ${s} in done but not all-finished`, seed, R);
  if (g.phase !== 'over') assert(!g.done.includes(g.turn), '4p', 'DONE', `turn on finished seat ${g.turn}`, seed, R);
  if (g.phase === 'awaiting-move') {
    const fresh = legalMoves4(g, g.turn, g.dice!).slice().sort();
    assert(JSON.stringify(fresh) === JSON.stringify(g.legal.slice().sort()), '4p', 'LEGAL', `legal mismatch`, seed, R);
    assert(g.legal.length > 0, '4p', 'LEGAL', 'awaiting-move empty legal', seed, R);
  }
  if (g.phase === 'over') {
    assert(g.winner !== null && g.positions[g.winner]!.every((p) => p === FINISHED), '4p', 'WIN', `bad winner ${g.winner}`, seed, R);
    // winner should be the FIRST to finish (arrival order)
    assert(g.done.length === 0 || g.done[0] === g.winner, '4p', 'WIN', `winner ${g.winner} != first done ${g.done[0]}`, seed, R);
  }
  assert((g.sixStreak ?? 0) >= 0 && (g.sixStreak ?? 0) <= 2, '4p', 'SIX', `sixStreak ${g.sixStreak}`, seed, R);
}
function adversarial4(g: Game4, seed: number): void {
  const R = g.rollCount ?? 0;
  if (g.phase === 'awaiting-roll') {
    expectThrow(() => applyMove4(g, 0), '4p', 'ADV', 'applyMove4 accepted in awaiting-roll', seed, R);
    for (const bad of [0, 7, -1, 2.5]) expectThrow(() => applyRoll4(g, bad as number), '4p', 'ADV', `applyRoll4 accepted die ${bad}`, seed, R);
  }
  if (g.phase === 'awaiting-move') {
    for (let t = 0; t < TOKENS4; t++) if (!g.legal.includes(t)) expectThrow(() => applyMove4(g, t), '4p', 'ADV', `applyMove4 accepted illegal token ${t}`, seed, R);
  }
  if (g.phase === 'over') expectThrow(() => applyRoll4(g, 6), '4p', 'ADV', 'applyRoll4 accepted after over', seed, R);
}
function play4(seed: number, strategy: 'random' | 'auto' | 'mixed'): void {
  const rng = mulberry32(seed);
  let g = newGame4();
  inv4(g, seed);
  const MAX = 12000;
  while (g.phase !== 'over') {
    if ((g.rollCount ?? 0) > MAX) { report('4p', 'TERMINATION', `not finished in ${MAX} rolls`, seed, g.rollCount ?? 0); return; }
    adversarial4(g, seed);
    const d = die(rng);
    g = applyRoll4(g, d);
    inv4(g, seed);
    if (g.phase === 'awaiting-move') {
      let token: number;
      if (strategy === 'random') token = g.legal[Math.floor(rng() * g.legal.length)]!;
      else if (strategy === 'auto') token = pickAutoMove4(g, g.turn, g.dice!) ?? g.legal[0]!;
      else token = rng() < 0.5 ? g.legal[Math.floor(rng() * g.legal.length)]! : (pickAutoMove4(g, g.turn, g.dice!) ?? g.legal[0]!);
      const seat = g.turn;
      const posBefore = g.positions.map((r) => [...r]);
      const res = applyMove4(g, token);
      inv4(res.state, seed);
      const ev = res.events as { capture: boolean; finished: boolean; extraTurn?: boolean; won?: boolean; seatDone?: boolean };
      const np = res.state.positions[seat]![token]!;
      assert(np <= FINISHED, '4p', 'MOVE', `overshoot to ${np}`, seed, res.state.rollCount ?? 0);
      {
        // Capture invariant (bidirectional): opponent base-count rises IFF a
        // capture happened. In 4p a single move may capture a LONE token from
        // EACH opponent seat, so the delta is 1..3 (multi-capture is legal).
        let baseBefore = 0, baseAfter = 0;
        for (let s = 0; s < SEATS4; s++) if (s !== seat) { baseBefore += posBefore[s]!.filter((p) => p === -1).length; baseAfter += res.state.positions[s]!.filter((p) => p === -1).length; }
        const delta = baseAfter - baseBefore;
        assert((delta > 0) === ev.capture, '4p', 'CAPTURE', `capture flag=${ev.capture} but opp-base delta=${delta}`, seed, res.state.rollCount ?? 0);
        assert(delta >= 0 && delta <= 3, '4p', 'CAPTURE', `opp-base delta ${delta} out of [0,3]`, seed, res.state.rollCount ?? 0);
        if (ev.capture) {
          const cell = absCell4(seat, np);
          assert(cell !== null && !SAFE_CELLS.has(cell), '4p', 'CAPTURE', `capture on safe/null cell ${cell}`, seed, res.state.rollCount ?? 0);
        }
      }
      g = res.state;
    }
  }
}

// ================================================================= determinism
function determinism2(seed: number): void {
  const trace = (): string => {
    const rng = mulberry32(seed); let g = newGame(); const log: number[] = [];
    while (g.phase !== 'over' && g.rollCount < 5000) {
      const d = die(rng); g = applyRoll(g, d); log.push(d);
      if (g.phase === 'awaiting-move') { const t = g.legal[Math.floor(mulberry32(seed + g.rollCount)() * g.legal.length)]!; log.push(t); g = applyMove(g, t).state; }
    }
    return JSON.stringify({ log, w: g.winner, r: g.rollCount });
  };
  if (trace() !== trace()) report('2p', 'DETERMINISM', `same seed produced different games`, seed, 0);
}

// ================================================================= run
const arg = (k: string, def: number): number => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? Number(m.split('=')[1]) : def;
};
const GAMES = arg('games', 20000);
const BASE = arg('seed', 1);
const strategies: Array<'random' | 'auto' | 'mixed'> = ['random', 'auto', 'mixed'];

console.log(`\n🎲 Engine simulation — ${GAMES} games/mode × ${strategies.length} strategies, base seed ${BASE}\n`);
const t0 = Date.now();
const stats = { g2: 0, g4: 0 };
for (let i = 0; i < GAMES; i++) {
  const s = BASE + i;
  play2(s, strategies[i % 3]!); stats.g2++;
  play4(s * 7 + 3, strategies[i % 3]!); stats.g4++;
  if (i < 200) determinism2(s);
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);

// ----------------------------------------------------------------- report
console.log(`Played ${stats.g2} × 2p + ${stats.g4} × 4p games in ${secs}s.\n`);
if (findings.length === 0) {
  console.log('✅ NO INVARIANT VIOLATIONS — engine held under all scenarios + adversarial inputs.');
  process.exit(0);
}
console.log(`❌ ${findings.length} distinct finding(s):\n`);
const byKind = new Map<string, Finding[]>();
for (const f of findings) { const k = `${f.mode} · ${f.kind}`; (byKind.get(k) ?? byKind.set(k, []).get(k)!).push(f); }
for (const [k, fs] of byKind) {
  console.log(`  [${k}] ×${fs.length}`);
  for (const f of fs.slice(0, 6)) console.log(`     - ${f.detail}  (seed ${f.seed}, roll ${f.rolls})`);
  if (fs.length > 6) console.log(`     … +${fs.length - 6} more`);
}
process.exit(1);
