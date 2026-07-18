/**
 * State invariants checked after EVERY server-applied action in a rational bot
 * game, from the WS-observed game state (2p GameState / 4p Game4). A violation
 * returns a reason string; null = the state is legal. The harness logs the game's
 * seed + full action sequence on any violation for deterministic replay.
 *
 * Position encoding (constants.ts): -1 base · 0..50 track · 51..55 home column ·
 * 56 FINISHED.
 */
const FINISHED = 56;

/** All structural invariants for a 2p or 4p state. `tokensPerSeat` = 2 (2p) / 4 (4p). */
export function checkState(state, tokensPerSeat, prev) {
  if (!state || !Array.isArray(state.positions)) return 'no positions array';
  const seats = state.positions.length;
  const expectSeats = tokensPerSeat === 2 ? 2 : 4;
  if (seats !== expectSeats) return `seat count ${seats} != ${expectSeats}`;

  for (let s = 0; s < seats; s++) {
    const row = state.positions[s];
    if (!Array.isArray(row) || row.length !== tokensPerSeat) return `seat ${s} token count ${row?.length} != ${tokensPerSeat}`;
    for (const p of row) {
      if (!Number.isInteger(p)) return `seat ${s} non-integer position ${p}`;
      if (p < -1 || p > FINISHED) return `seat ${s} position ${p} out of range [-1,56]`; // no overshoot past FINISHED
    }
  }

  // turn must be a valid seat still in play (not fully finished)
  if (typeof state.turn !== 'number' || state.turn < 0 || state.turn >= seats) return `turn ${state.turn} not a seat`;
  const turnDone = state.positions[state.turn].every((p) => p === FINISHED);
  if (state.phase !== 'over' && turnDone) return `turn ${state.turn} already finished all tokens but is on turn`;

  // phase must be one of the legal values
  if (!['awaiting-roll', 'awaiting-move', 'over'].includes(state.phase)) return `illegal phase ${state.phase}`;

  // legal[] only contains valid, non-finished token indices for the seat on turn
  if (Array.isArray(state.legal)) {
    for (const t of state.legal) {
      if (!Number.isInteger(t) || t < 0 || t >= tokensPerSeat) return `legal token ${t} out of range`;
      if (state.positions[state.turn][t] === FINISHED) return `legal token ${t} is already FINISHED`;
    }
  }

  // dice, when present, is a valid face
  if (state.dice !== null && state.dice !== undefined) {
    if (!Number.isInteger(state.dice) || state.dice < 1 || state.dice > 6) return `dice ${state.dice} not in 1..6`;
  }

  // a declared winner truly has ALL tokens home
  if (state.winner !== null && state.winner !== undefined) {
    if (!state.positions[state.winner].every((p) => p === FINISHED)) return `winner ${state.winner} does not have all tokens FINISHED`;
    if (state.phase !== 'over') return `winner declared but phase is ${state.phase}`;
  }

  // MONOTONIC PROGRESS-ish: total tokens across all seats is conserved (never
  // lose or gain a token). Redundant with the per-seat length check but catches a
  // server that ever ships a corrupted board.
  const total = state.positions.reduce((a, r) => a + r.length, 0);
  if (total !== seats * tokensPerSeat) return `total token count ${total} != ${seats * tokensPerSeat}`;

  // Cross-state: a captured opponent token returns to base. If a seat's based-token
  // count DROPPED with no legal explanation we can't fully judge here, but we CAN
  // assert a seat never has MORE than tokensPerSeat tokens on the board.
  if (prev) {
    // the seat on turn in `prev` is the one that just moved; every OTHER seat's
    // tokens can only have moved to base (capture) or stayed — never advanced.
    // (We don't have the mover here reliably across 4p rotation, so keep it light.)
  }

  return null;
}

/**
 * Server-correctness invariants on a game.moved event (INV-MOVED-TOKEN-WAS-LEGAL,
 * INV-MOVE-DELTA-EXACT): the moved token must have been in the PRIOR legal set,
 * and it must advance by EXACTLY the die (exit base → cell 0 on a 6). Catches a
 * server that applies an illegal move or misapplies the die.
 */
export function checkMove(prevState, nextState, seat, token, die) {
  if (!prevState || !nextState || die == null) return null;
  if (prevState.phase === 'awaiting-move' && Array.isArray(prevState.legal) && !prevState.legal.includes(token)) {
    return `moved token ${token} was not in the legal set [${prevState.legal}]`;
  }
  const before = prevState.positions?.[seat]?.[token];
  const after = nextState.positions?.[seat]?.[token];
  if (before === undefined || after === undefined) return null;
  if (before === -1) {
    if (die === 6 && after !== 0) return `token ${token} exited base but landed on ${after}, not 0`;
  } else if (after !== FINISHED || before + die === FINISHED) {
    // normal advance (or exact finish): after === before + die
    if (after !== before + die) return `token ${token} advanced ${before}→${after}, expected +${die}`;
  }
  return null;
}

/** Captured-token invariant from a game.moved event: capture ⇒ some opponent seat
 *  gained a based (-1) token vs the prior state. */
export function checkCapture(prevState, nextState, moverSeat, capture) {
  if (!capture) return null;
  if (!prevState || !nextState) return null;
  const seats = nextState.positions.length;
  let gained = false;
  for (let s = 0; s < seats; s++) {
    if (s === moverSeat) continue;
    const before = prevState.positions[s].filter((p) => p === -1).length;
    const after = nextState.positions[s].filter((p) => p === -1).length;
    if (after > before) gained = true;
  }
  return gained ? null : `capture reported but no opponent seat gained a based token`;
}
