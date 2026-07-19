# WebSocket protocol

Source of truth for types: `packages/shared/src/protocol.ts`. All messages are JSON `{ t: string, ... }`.

## Client → Server

| t | Payload | Description |
|---|---|---|
| `hello` | `{ wallet?, sessionToken?, entropyCommit?, entropy?, fingerprint?, consent?, name?, flag?, avatar?, frame?, tokenSkin?, entranceFx?, miniPay? }` | First frame. New clients send `entropyCommit` = sha256 of their 32-hex-byte entropy and reveal the raw value later via `game.entropy` (anti-grinding: the server commits its seed knowing only the hashes). `entropy` (raw) is legacy-only. `sessionToken` to resume an in-progress game. `consent` = `{ tosVersion, age18 }` — the 18+/ToS acceptance recorded client-side; the server persists it (per player) and requires `tosVersion === TOS_VERSION` for staked play. `name`/`flag` = editable profile (server sanitizes/validates, falls back to derived values). `avatar`/`frame`/`tokenSkin`/`entranceFx` = equipped cosmetics (client-authoritative; ids validated against the shared catalog — `tokenSkin` must be a `token` cosmetic, `entranceFx` an `entrance` one — and relayed to the opponent via `match.found`). `miniPay: true` marks a MiniPay session (auto-connected wallet accepted as proven; MiniPay has no `personal_sign`). |
| `wallet.prove` | `{ signature }` | Wallet ownership proof (SIWE): signs the `walletNonce` from `hello.ok` (message = `walletProofMessage(nonce)`). The server recovers the address and, on a match, marks the session's wallet proven — required for wallet-backed staked play so RG limits / self-exclusion can't be dodged with a different address. |
| `game.entropy` | `{ entropy }` | Reveals this session's raw entropy after `match.found`; verified against the hello commit. The game's dice are finalized (and the Room created) only once both players revealed. |
| `queue.join` | `{ stake, freeroll? }` | Joins the queue (stake in dollar cents: 0, 10, 25, 50, 100, 200). `freeroll: true` joins the ticket-gated freeroll queue instead (stake forced to 0; entry = 1 ticket, spent at match time; winner takes 3). |
| `queue.leave` | `{}` | Leaves the queue. |
| `queue.join4` | `{ stakeCents? }` | Joins the 4-player online table. `stakeCents` 0 (or omitted) = FREE table (empty seats bot-filled after a short wait). `stakeCents` > 0 (an allowed cUSD stake) = staked table — requires 4 real stakers (bots have no funds) and locks each stake in `LudoEscrowN` (staked path lands with the escrow integration). In-game it shares `game.roll`/`game.move`/`game.resign`. |
| `table.create` | `{ stake }` | Creates a private table (E4.4); server replies `table.created` with a shareable code. |
| `table.join` | `{ code }` | Joins a private table by its 6-char code; pairs with the host or returns `error TABLE_NOT_FOUND`. |
| `friend.add` | `{ pid }` | Friends (E-social 2): "I want to be friends with `pid`". MUTUAL-consent: the first direction is a request, the reciprocal add seals the friendship. Requires a PROVEN wallet (durable identity); throttled 1/s. Server replies `friend.added` and pushes `friends.update` to both sides' live sessions. |
| `friend.remove` | `{ pid }` | Tears down BOTH directions, silently — the other side is NOT notified (their next hello reflects it); de-friending must not be a conflict trigger. |
| `friend.challenge` | `{ pid, stake }` | Challenge a MUTUAL friend: creates a private table on the challenger's session (reply `table.created`, same machinery/guards as `table.create`) and pushes `friend.challenge.offer` to the friend's live session when they're connected. The code doubles as the WhatsApp deep link for offline friends. |
| `game.roll` | `{}` | Requests the roll (if it is their turn and phase is `awaiting-roll`). |
| `game.move` | `{ token }` | Plays token `token` (0 or 1). |
| `game.resign` | `{}` | Deliberately forfeits the current match — the opponent wins and the normal `game.over`/settlement path runs. |
| `game.rematch` | `{}` | Rematch at the same stake. If the LAST opponent is still connected, idle, and also sent `game.rematch` (and the anti-collusion cap `MAX_DAILY_GAMES_VS_SAME` still allows another game between them), the two are paired directly; otherwise the requester is re-queued for any opponent. Sent on the still-open session (no re-`hello`). |
| `ping` | `{}` | Keepalive (every 20 s). |

## Server → Client

| t | Payload | Description |
|---|---|---|
| `hello.ok` | `{ sessionToken, elo, resumed?, challenge?, streak?, league?, limits?, ownedSkins?, stakingBlocked?, walletNonce?, walletProven?, consentTosVersion? }` | Session established. If a game is in progress, `resumed` = `{ gameId, seat, state, stakeCents, potCents, opponent, fairnessCommit }` — everything needed to rebuild the game screen after a reconnection or a server restart. `challenge` = daily-challenge state (E4.1); `streak` = login-streak state (E4.2); `league` = weekly-league standings + top-5 board (E4.3). `walletNonce` = string to sign via `wallet.prove` when a wallet is unproven; `walletProven` reflects proof state; `consentTosVersion` = the accepted ToS version on record. |
| `queue.ok` | `{ position }` | Queued. |
| `table.created` | `{ code, stakeCents }` | Private table created (E4.4); share `code` with a friend. |
| `friend.added` | `{ pid, status }` | Ack for `friend.add`: `requested` (awaiting their reciprocal add) or `friends` (the edge just became mutual). |
| `friends.update` | `{ friends, requests }` | Live refresh of both `FriendInfo` lists, pushed to a player whose graph changed while they had an active session. Also included in `hello.ok` (`friends`/`friendRequests`, walletProven sessions only) with an `online` presence SNAPSHOT. |
| `friend.challenge.offer` | `{ code, stakeCents, from }` | A friend challenges you RIGHT NOW: accept = the normal `table.join(code)`; ignoring is safe (tables expire, the challenger keeps the share screen). |
| `match.found` | `{ gameId, seat, opponent: { name, elo, flag, pid?, avatar?, frame?, tokenSkin?, entranceFx? }, stakeCents, potCents, fairnessCommit }` | Match found. `fairnessCommit` = hash of the server seed, to display. `opponent` carries the other player's equipped cosmetics: `tokenSkin` patterns THEIR pawns on my board, `entranceFx` plays their entrance burst at match start (cosmetics phase 1). |
| `game.state` | `{ state }` | Full state (resync, game start). `state` = engine `GameState`. |
| `game.dice` | `{ value, index, seat }` | Roll result (index = roll number, verifiable). |
| `game.moved` | `{ seat, token, capture, finished, extraTurn, state }` | Move applied. |
| `game.turn` | `{ seat, deadlineTs }` | Whose turn + clock deadline (auto-move afterwards). |
| `game.over` | `{ winner, reason, payoutCents, rakeCents, eloDelta, fairnessReveal, txHash? }` | End. `fairnessReveal` = server seed + entropies (verification). `reason` ∈ `finish` \| `timeout-forfeit` \| `resign`. |
| `game.settled` | `{ gameId, txHash, winner }` | On-chain payout confirmed (E3.3). Sent after `game.over` once the arbiter's `settle()` tx is mined; decoupled so `game.over` is never blocked on chain latency. |
| `game.refunded` | `{ gameId, txHash }` | Stake refunded on-chain (E3.4): the opponent never joined within the 120 s escrow timeout, so the lone staker got their stake back via `refundExpired`. |
| `match.found4` | `{ gameId, seat, players: [{ name, flag, bot }], entryTickets, prizeTickets, stakeCents, potCents, fairnessCommit }` | 4-player match found. `seat` = 0–3; `players` indexed by seat (bot seats `bot: true`). `stakeCents` = cUSD stake per seat (0 = free); `potCents` = winner's cUSD payout (0 = free). `entryTickets`/`prizeTickets` are legacy (0). `fairnessCommit` = hash of the server seed, revealed at `game.over4`. |
| `game.state4` | `{ state }` | Full 4-player state (game start). `state` = engine `Game4`. |
| `game.dice4` | `{ value, index, seat }` | 4-player roll result (index = roll number, verifiable). |
| `game.moved4` | `{ seat, token, capture, state }` | 4-player move applied (`state` = `Game4`). |
| `game.turn4` | `{ seat, deadlineTs }` | 4-player turn + clock deadline (auto-move / bot-play afterwards). |
| `game.over4` | `{ winner, prizeTickets, payoutCents, rakeCents, fairnessReveal: { serverSeed, seeds } }` | 4-player end. `winner` (0–3). `payoutCents` = winner's cUSD payout (0 = free), `rakeCents` = rake taken; `prizeTickets` legacy (0). `fairnessReveal` = server seed + per-seat seeds (verifiable, not fully grinding-resistant — see fairness note). |
| `game.settled4` | `{ gameId, txHash, winner }` | Staked 4-player payout confirmed on-chain (arbiter `settle()` mined on `LudoEscrowN`). |
| `game.refunded4` | `{ gameId, txHash }` | Staked 4-player stakes refunded on-chain (table didn't fill, or a stuck game). |
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
