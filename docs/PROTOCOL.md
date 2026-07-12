# WebSocket protocol

Source of truth for types: `packages/shared/src/protocol.ts`. All messages are JSON `{ t: string, ... }`.

## Client → Server

| t | Payload | Description |
|---|---|---|
| `hello` | `{ wallet?, sessionToken?, entropyCommit?, entropy?, fingerprint?, consent? }` | First frame. New clients send `entropyCommit` = sha256 of their 32-hex-byte entropy and reveal the raw value later via `game.entropy` (anti-grinding: the server commits its seed knowing only the hashes). `entropy` (raw) is legacy-only. `sessionToken` to resume an in-progress game. `consent` = `{ tosVersion, age18 }` — the 18+/ToS acceptance recorded client-side; the server persists it (per player) and requires `tosVersion === TOS_VERSION` for staked play. |
| `wallet.prove` | `{ signature }` | Wallet ownership proof (SIWE): signs the `walletNonce` from `hello.ok` (message = `walletProofMessage(nonce)`). The server recovers the address and, on a match, marks the session's wallet proven — required for wallet-backed staked play so RG limits / self-exclusion can't be dodged with a different address. |
| `game.entropy` | `{ entropy }` | Reveals this session's raw entropy after `match.found`; verified against the hello commit. The game's dice are finalized (and the Room created) only once both players revealed. |
| `queue.join` | `{ stake, freeroll? }` | Joins the queue (stake in dollar cents: 0, 10, 25, 50, 100, 200). `freeroll: true` joins the ticket-gated freeroll queue instead (stake forced to 0; entry = 1 ticket, spent at match time; winner takes 3). |
| `queue.leave` | `{}` | Leaves the queue. |
| `queue.join4` | `{}` | Joins the 4-player online Sit&Go queue. Ticket-gated: entry = 1 freeroll ticket, spent at join (refunded on `queue.leave`/disconnect while still waiting); winner takes 3. Fills empty seats with bots after a short wait if fewer than 4 humans queue. In-game it shares `game.roll`/`game.move`/`game.resign`. |
| `table.create` | `{ stake }` | Creates a private table (E4.4); server replies `table.created` with a shareable code. |
| `table.join` | `{ code }` | Joins a private table by its 6-char code; pairs with the host or returns `error TABLE_NOT_FOUND`. |
| `game.roll` | `{}` | Requests the roll (if it is their turn and phase is `awaiting-roll`). |
| `game.move` | `{ token }` | Plays token `token` (0 or 1). |
| `game.resign` | `{}` | Deliberately forfeits the current match — the opponent wins and the normal `game.over`/settlement path runs. |
| `game.rematch` | `{}` | Offers a same-stake rematch. |
| `ping` | `{}` | Keepalive (every 20 s). |

## Server → Client

| t | Payload | Description |
|---|---|---|
| `hello.ok` | `{ sessionToken, elo, resumed?, challenge?, streak?, league?, limits?, ownedSkins?, stakingBlocked?, walletNonce?, walletProven?, consentTosVersion? }` | Session established. If a game is in progress, `resumed` = `{ gameId, seat, state, stakeCents, potCents, opponent, fairnessCommit }` — everything needed to rebuild the game screen after a reconnection or a server restart. `challenge` = daily-challenge state (E4.1); `streak` = login-streak state (E4.2); `league` = weekly-league standings + top-5 board (E4.3). `walletNonce` = string to sign via `wallet.prove` when a wallet is unproven; `walletProven` reflects proof state; `consentTosVersion` = the accepted ToS version on record. |
| `queue.ok` | `{ position }` | Queued. |
| `table.created` | `{ code, stakeCents }` | Private table created (E4.4); share `code` with a friend. |
| `match.found` | `{ gameId, seat, opponent: { name, elo, flag }, stakeCents, potCents, fairnessCommit }` | Match found. `fairnessCommit` = hash of the server seed, to display. |
| `game.state` | `{ state }` | Full state (resync, game start). `state` = engine `GameState`. |
| `game.dice` | `{ value, index, seat }` | Roll result (index = roll number, verifiable). |
| `game.moved` | `{ seat, token, capture, finished, extraTurn, state }` | Move applied. |
| `game.turn` | `{ seat, deadlineTs }` | Whose turn + clock deadline (auto-move afterwards). |
| `game.over` | `{ winner, reason, payoutCents, rakeCents, eloDelta, fairnessReveal, txHash? }` | End. `fairnessReveal` = server seed + entropies (verification). `reason` ∈ `finish` \| `timeout-forfeit` \| `resign`. |
| `game.settled` | `{ gameId, txHash, winner }` | On-chain payout confirmed (E3.3). Sent after `game.over` once the arbiter's `settle()` tx is mined; decoupled so `game.over` is never blocked on chain latency. |
| `game.refunded` | `{ gameId, txHash }` | Stake refunded on-chain (E3.4): the opponent never joined within the 120 s escrow timeout, so the lone staker got their stake back via `refundExpired`. |
| `match.found4` | `{ gameId, seat, players: [{ name, flag, bot }], entryTickets, prizeTickets, fairnessCommit }` | 4-player Sit&Go match found. `seat` = 0–3; `players` is indexed by seat (bot seats have `bot: true`). `fairnessCommit` = hash of the server seed, revealed at `game.over4`. |
| `game.state4` | `{ state }` | Full 4-player state (game start). `state` = engine `Game4`. |
| `game.dice4` | `{ value, index, seat }` | 4-player roll result (index = roll number, verifiable). |
| `game.moved4` | `{ seat, token, capture, state }` | 4-player move applied (`state` = `Game4`). |
| `game.turn4` | `{ seat, deadlineTs }` | 4-player turn + clock deadline (auto-move / bot-play afterwards). |
| `game.over4` | `{ winner, prizeTickets, fairnessReveal: { serverSeed, seeds } }` | 4-player end. `winner` (0–3) is granted `prizeTickets` (via `tickets.grant` reason `freeroll-win`). `fairnessReveal` = server seed + per-seat seeds. NOTE: verifiable but, like the 2-player legacy path, not fully grinding-resistant — acceptable for ticket games (no on-chain money). |
| `challenge.update` | `{ challenge: { progress, target, completed, tickets } }` | Daily-challenge progress after a capture (E4.1); on completion `completed` flips and `tickets` increments. |
| `league.update` | `{ league: { division, points, rank, size, top[] } }` | Weekly-league standings after a win (E4.3), sent to the winner. |
| `tickets.grant` | `{ granted, total, reason }` | Freeroll tickets granted. `reason` ∈ `anti-tilt` (3 consecutive staked losses, E4.5) \| `freeroll-win` (freeroll prize). Also sent with `granted: 0` to sync the total after a freeroll entry is spent. |
| `error` | `{ code, message }` | Codes: `BAD_STATE`, `NOT_YOUR_TURN`, `ILLEGAL_MOVE`, `LIMIT_REACHED`, `INSUFFICIENT_ESCROW`… |
| `pong` | `{}` | Keepalive reply. |

## Typical sequence (staked game)

```
C→S hello{entropy}                    S→C hello.ok{sessionToken}
C→S queue.join{stake:25}              S→C queue.ok
                                      S→C match.found{fairnessCommit,...}
   [on-chain] both clients call LudoEscrow.join(gameId) with the stake
                                      S→C game.state / game.turn
C→S game.roll                         S→C game.dice{value:6,index:1}
C→S game.move{token:0}                S→C game.moved{...} / game.turn
   ...                                ...
                                      S→C game.over{winner, fairnessReveal, txHash}
   [on-chain] settle() already submitted by the arbiter → instant payout
```

## Server validation rules

- Any out-of-turn / out-of-phase intent → `error NOT_YOUR_TURN` / `BAD_STATE`, state re-sent.
- `game.move` with a token not listed in `legalMoves` → `ILLEGAL_MOVE`.
- Clock: 15,000 ms per decision in Blitz. On expiry: auto-move (best legal move); 3 consecutive auto-moves = forfeit (`timeout-forfeit`).
- Max inbound frame size: 1 KB. Beyond that: connection closed.
- Rate limiting: token bucket per connection (burst 100, sustained 30 msg/s); flooded messages are silently dropped. Three drained periods → 5 min IP ban (`error LIMIT_REACHED`, connection closed; new connections from the IP are rejected while banned).
