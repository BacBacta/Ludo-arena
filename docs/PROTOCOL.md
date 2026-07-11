# WebSocket protocol

Source of truth for types: `packages/shared/src/protocol.ts`. All messages are JSON `{ t: string, ... }`.

## Client → Server

| t | Payload | Description |
|---|---|---|
| `hello` | `{ wallet?, sessionToken?, entropy }` | First frame. `entropy` = 32 random hex bytes (client share of commit-reveal). `sessionToken` to resume an in-progress game. |
| `queue.join` | `{ stake }` | Joins the queue (stake in dollar cents: 0, 10, 25, 50, 100, 200). |
| `queue.leave` | `{}` | Leaves the queue. |
| `table.create` | `{ stake }` | Creates a private table (E4.4); server replies `table.created` with a shareable code. |
| `table.join` | `{ code }` | Joins a private table by its 6-char code; pairs with the host or returns `error TABLE_NOT_FOUND`. |
| `game.roll` | `{}` | Requests the roll (if it is their turn and phase is `awaiting-roll`). |
| `game.move` | `{ token }` | Plays token `token` (0 or 1). |
| `game.rematch` | `{}` | Offers a same-stake rematch. |
| `ping` | `{}` | Keepalive (every 20 s). |

## Server → Client

| t | Payload | Description |
|---|---|---|
| `hello.ok` | `{ sessionToken, elo, resumed?, challenge?, streak?, league? }` | Session established. If a game is in progress, `resumed` = `{ gameId, seat, state, stakeCents, potCents, opponent, fairnessCommit }` — everything needed to rebuild the game screen after a reconnection or a server restart. `challenge` = daily-challenge state (E4.1); `streak` = login-streak state (E4.2); `league` = weekly-league standings + top-5 board (E4.3). |
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
| `challenge.update` | `{ challenge: { progress, target, completed, tickets } }` | Daily-challenge progress after a capture (E4.1); on completion `completed` flips and `tickets` increments. |
| `league.update` | `{ league: { division, points, rank, size, top[] } }` | Weekly-league standings after a win (E4.3), sent to the winner. |
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
