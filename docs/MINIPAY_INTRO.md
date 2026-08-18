# Ludo Arena → MiniPay — introduction

> Supports **E7.3** (listing submission, `docs/BACKLOG.md`). Three ready-to-send pieces:
>
> 1. **§1 — Short version.** One paragraph, for a form field, a DM or a Telegram intro.
> 2. **§2 — The intro letter.** The full story. Use as the email / listing-application body.
> 3. **§3 — Fact sheet.** Numbers and on-chain addresses, as an appendix or a leave-behind.
>
> Every figure is sourced from this repo (`docs/`, `TESTING_REPORT.md`,
> `packages/contracts/deployments.json`) — nothing is estimated or rounded up.
> `[Bracketed]` items are the only things to fill in before sending.
> See §4 for what deliberately is **not** claimed, and why.
>
> Written in English (MiniPay/Celo working language). A French version can be added on request.

---

## §1 — Short version

> Ludo Arena is a Mini App built for MiniPay from day one: a 1v1 Ludo duel that's over in three to
> six minutes, with a 25-cent cUSD stake, provably fair dice, and the winner paid on-chain seconds
> after the last move. Stakes sit in an escrow contract on Celo — never in an account we control —
> with a rake capped in the contract and refund valves if anything goes wrong; every die can be
> recomputed by the player, in their own browser, from a seed committed before the game started.
> It's built to MiniPay's constraints as CI gates, not as an afterthought: legacy transactions, gas
> paid in cUSD, a 201 KB gzipped critical path, interactive in under four seconds on a low-end
> Android at 3G. Ludo needs no explaining in the markets MiniPay serves, and inside MiniPay the
> stake *is* the user's first transaction — no install, no seed phrase, no CELO for gas.
> We'd like to be listed.

---

## §2 — The intro letter

**Subject:** Ludo Arena — a Ludo built *for* MiniPay, not ported to it

Hello MiniPay team,

My name is [Mike] and I build Ludo Arena. I'd like to tell you why I think it belongs in MiniPay,
and I'd rather do that by telling you how it got built than by listing features at you.

### It started with a game nobody has to learn

Most crypto products ask a person to learn something before they can feel anything. Ludo asks
nothing. In Lagos, Accra, Nairobi, Mumbai, the rules are already installed — in the family, on the
kitchen table, in childhood. If a stablecoin payment is ever going to feel *ordinary* rather than
technical, it should ride on something like that.

So the whole product is one sentence: **a 1v1 Ludo duel that's over in three to six minutes,
twenty-five cents of cUSD on the line, dice anyone can verify, and the winner paid on-chain before
they put the phone down.**

Everything since has been the work of making that sentence literally true.

### Making it fast

Classic Ludo is a forty-minute game — useless on a commute. So the format was cut down to a Blitz
ruleset: two tokens per player instead of four, overshoot allowed to finish so you never sit waiting
for an exact roll, a fifteen-second decision clock with auto-move on expiry. Then the ruleset was run
through a two-thousand-game simulation until the numbers held: ~68 rolls per game, three to six
minutes, zero games that fail to terminate. That simulation still runs in CI on every commit — a rule
change that makes games drag physically cannot merge.

### Making it honest

This took the longest, and it's the part I'd defend hardest. A dice game where the house generates
the dice and there's money on the table is a trust problem, not a technical one.

So: before a match, the server publishes `keccak256(serverSeed)`. Both players contribute their own
entropy — hash-committed *first* and revealed only after the pairing, so nobody can grind their
contribution against a seed they've already seen. Every die is
`1 + keccak256(serverSeed ‖ entropyA ‖ entropyB ‖ i) % 6`. When the game ends the server reveals the
seed, and the app recomputes **every single roll in the player's own browser** with WebCrypto, showing
a played-versus-recomputed table, roll by roll, with a verdict.

The server can't cheat, because it committed before it knew the entropies. The players can't, because
they never see the seed. Nobody has to take my word for anything — which is the only version of
"provably fair" that actually means something.

### Making the money someone else's problem

Funds never touch an account I control. Stakes lock in `LudoEscrow.sol` on Celo. The server holds an
arbiter key that can only *sign a result* — the contract will only ever pay a wallet that actually
deposited into that game, and can never divert funds to a third party. The rake is snapshotted at
game creation (so a fee change can't re-price a pot already in play) and hard-capped at 10% in the
contract itself. If the arbiter key were lost tomorrow, every locked stake is still recoverable: a
120-second timeout refunds a player whose opponent never showed up, and a permissionless refund opens
on any stuck game after 24 hours.

Foundry invariant campaigns hammer that continuously — 128,000 randomised sequences of
join/settle/refund/void/withdraw against one master money invariant (*escrow balance always equals
stakes locked in open games plus every credited-but-unwithdrawn amount*). Zero violations, zero
reverts.

### Making it survive contact with a real network

A dropped connection is not a loss. Your clock keeps running, a legal move is auto-played on expiry,
and you have sixty seconds to come back to a fully resynced board. A server restart doesn't kill games
in progress either: room snapshots are written through to Redis and the clocks re-arm at boot, so
players reattach with their session token and carry on.

Under load: **2,000 concurrent games, 4,000 sockets, p95 action latency 138 ms, zero errors and zero
dropped messages.** A one-hour soak of 45,250 continuous games with memory flat on a plateau and no
leaked file descriptors. Those are measurements from the repo's own harness driving the real client
protocol, not a synthetic WebSocket echo.

### Making it not look like a casino

The first visual direction was royal blue and gold — and it read exactly like a mobile casino. So I
threw it out and rebuilt the whole surface. The app now looks like a beautiful board game sitting on
a table: cream ground, sand surfaces, ceramic pieces, one terracotta accent, real money on its own
quiet dark surface. No emoji anywhere, no flashing, no near-miss animation, no artificial-urgency
badges before a player's first game.

That same principle runs through the safety rails, which are server-side and not decorative: a
**$15/day stake ceiling** a player can lower but never raise, self-exclusion, an 18+/ToS gate recorded
per player, **geo-gating by allowlist** so staked play is simply off where it shouldn't be, and
device-fingerprint anti-multi-accounting that refuses same-device self-play and caps repeat matchups
against the same wallet. When an early anti-tilt *cash* cashback turned out to create an unbacked
liability, I deleted it and replaced it with free-entry tickets. A losing streak is answered with
free games — never with credit.

A wallet's users deserve a game that doesn't behave like a slot machine, and a wallet shouldn't have
to defend one.

### And then there was the wallet problem — which is why I'm writing to you

Outside MiniPay, a new player hits a wall. They need a wallet installed. They need a seed phrase. They
need native CELO for gas, which they can't get without an on-ramp — in order to play for twenty-five
cents.

So I built around it. The app now *mints* a wallet in the browser on first tap, constructs every
transaction itself so gas is paid in cUSD through Celo's `feeCurrency`, and a faucet seeds it with a
one-cent stake budget — with just-in-time top-ups, so a wallet that claims and walks away keeps two
cents instead of the whole quota. One tap, and someone with no crypto at all is in a staked game.

It works. It is also, honestly, an enormous amount of machinery to reproduce something MiniPay simply
*is*. The wallet already exists. It's already funded in cUSD. Gas is already abstracted. The user is
already past the wall that costs everyone else most of their funnel. **Building the workaround is
exactly what convinced me the real answer was distribution through you, not around you.**

### Why MiniPay specifically

- **The economics only close at zero onboarding cost.** A 25¢ stake cannot pay for a wallet install,
  a seed-phrase tutorial and an on-ramp. Inside MiniPay, the stake *is* the first transaction.
- **It was built to your constraints as CI gates.** Legacy transactions only, `feeCurrency` in cUSD,
  cUSD/USDC/USDT. Critical-path bundle under 300 KB gzipped and total landing transfer under 500 KB,
  both enforced by an automated probe that loads the app in a 360×800 Android webview at 3G
  (750 kb/s, 100 ms RTT) with 4× CPU throttling. Current measurement: **201 KB gz critical path,
  interactive in 3.95 s.** No CSS framework, inline SVG icons, sounds synthesised in Web Audio (zero
  asset bytes), PWA shell so the app still opens offline. Designed for the phone your users hold.
- **It's a session engine, not a one-shot.** Games last minutes, rematch is one tap, and daily
  challenges, login streaks, a 28-day season pass and free-entry tickets all bring the player back —
  into the wallet. Every staked game is real, repeated on-chain activity: an approve + join from each
  player and an on-chain settlement, all attributable to MiniPay. Dune queries against the live
  mainnet contracts are already written and in the repo.
- **Ludo is culturally native where MiniPay is strong.** This isn't a crypto product that needs
  explaining to a new market; it's a game that market already loves, with the crypto invisible
  underneath it.
- **It's listable without risk.** Server-enforced responsible-gaming limits, geo-gating, on-chain
  custody with a contract-capped rake and refund valves. There is no house edge: this is skill-based
  PvP with ELO matchmaking, and the revenue is a transparent rake on the pot, not a book run against
  the player. Where an operator-owned opponent does exist — a one-cent event tier where it keeps
  matchmaking alive and absorbs suspected farmers — it stakes its own real money at roughly even odds
  and **every one of its games is flagged in the database**, so house-generated volume is never
  reported as organic usage.

### What's actually unique here

There's no token. The only NFT in the system is a **soulbound** event pass that cannot be traded. No
yield, no "earn" narrative, no speculation layer bolted onto a game. The entire product is a duel, a
stake, dice you can check, and a payout in seconds.

The same pure rules engine runs on the server and in the client, so the offline practice game against
the bot is bit-for-bit the same game as the one with money on it. Verifiability is a screen a player
can open on their own phone, not a paragraph in a whitepaper. And every line of it was written for a
low-end Android on mobile data, because that is the actual constraint — not an optimisation pass
scheduled for later.

### Where it stands, and what I'm asking for

Contracts are live on **Celo mainnet** — 1v1 escrow, four-seat escrow, cosmetics store, and a
soulbound event pass. The game server runs on Fly, the Mini App on Vercel. The full pre-launch
hardening campaign (engine, contracts, integration, chaos/network, performance and endurance,
application security) is written up in the repo, and I've already run a live on-chain event —
Race Week — end to end: one soulbound pass per wallet, faucet onboarding, anti-wash-trading
leaderboard, quest integration.

What's left on my own roadmap is the listing track itself: ToS and privacy pages, a testing pass
inside MiniPay against your checklist, and submission.

So the only missing input is distribution. That's the ask:

1. **A listing** in MiniPay's Mini App discovery.
2. **Twenty minutes of feedback** on the listing checklist *before* I submit — I'd much rather fix
   what you'd flag than argue about it afterwards.
3. **A MiniPay-native event**, if it's interesting to you. The Race Week machinery already exists and
   can be pointed at a MiniPay cohort — event pass, leaderboard, prize pool — whenever you'd like a
   real activation number rather than a projection.

Happy to send a build link and a two-minute video, or to walk through it live at whatever time works
for you.

— [Mike]
[email] · [repo / demo link]

---

## §3 — Fact sheet

### Product

| | |
|---|---|
| Format | Blitz 1v1 — 2 tokens/player, overshoot to finish, 15 s decision clock, auto-move on expiry |
| Game length | 3–6 minutes (~68 rolls average, validated over a 2,000-game simulation in CI) |
| Also shipped | 4-player online Sit&Go tables, offline practice vs bot, private tables via shareable code |
| Stakes | Free · 25¢ · $1 · $5 in cUSD (plus a 1¢ event tier), geo-gated by allowlist |
| Business model | Degressive rake 10% (25¢) / 8% ($1) / 6% ($5), hard-capped at 10% on-chain · $1.50 season pass per 28-day season · cosmetics · sponsored freerolls |
| House bot | Operator-owned opponent, **default off**, 1¢ event tier only: keeps matchmaking alive and acts as an anti-farm honeypot (games against it score zero). Stakes its own real cUSD at ~50/50 odds; every game tagged `is_house_bot` so human-only volume can always be reported separately |
| Retention loops | 1-tap rematch, daily challenge, login streak, freeroll tickets, 28-day 50-tier season pass, friends + challenges |
| Languages | EN (default), FR, PT, ES, SW |

### Fairness & settlement

| | |
|---|---|
| Randomness | Commit-reveal. `commit = keccak256(serverSeed)` published pre-match; both players' entropies hash-committed before the pairing; `die_i = 1 + keccak256(serverSeed ‖ entropyA ‖ entropyB ‖ i) % 6` |
| Verification | Seed revealed at game end; the client replays every roll with WebCrypto and shows played-vs-recomputed per roll |
| Custody | Stakes locked in escrow on Celo — never in an app-owned account |
| Authorisation | Arbiter EIP-191 signature over `(chainid, escrow, gameId, winner)`; only a depositor can ever be named winner |
| Safety valves | 120 s join timeout refund · permissionless refund after 24 h on a stuck game · rake snapshotted at game creation · `MAX_RAKE_BPS` = 10% |
| Measured settlement | ~5.5 s from result to on-chain payout (verified against the live testnet escrow) |

### Engineering (all measured, from `TESTING_REPORT.md`)

| | |
|---|---|
| Client bundle | 201 KB gz critical path (budget 300 KB) · 114 KB lazy 3D dice chunk off the critical path · total landing budget 500 KB |
| Time to interactive | 3.95 s on 360×800 Android webview, 3G (750 kb/s / 100 ms RTT), 4× CPU throttle |
| Load | 500 games / 1,000 conns → p95 15 ms · 2,000 games / 4,000 conns → p95 138 ms, 0 errors, 0 loss |
| Endurance | 1 h soak, 45,250 games, memory plateau flat, 0 crashes, 0 zombies, no FD leak |
| Contract testing | Foundry invariants, 128,000 calls, 0 violations · authorization fuzz · Slither · fork tests |
| Resilience | Redis + Postgres write-through; in-progress games survive a server restart; 60 s reconnection window |
| Discipline | Pure deterministic engine (no `Math.random`, dice injected) · authoritative server · strict TypeScript · lint/typecheck/tests/simulation all gating in CI |

### Responsible gaming & compliance

Server-enforced daily stake ceiling ($15/day default *and* maximum, self-lowerable) · self-exclusion ·
18+/ToS consent recorded per player · geo-gating by country allowlist · anti multi-accounting (device
fingerprint, same-device self-play refused, capped repeat matchups per wallet/day) · rate limiting and
temporary IP bans · no casino mechanics, no urgency badges, no cash cashback · smart-contract audit
dossier prepared for an external auditor (`docs/AUDIT_PACKAGE.md`).

### On-chain — Celo mainnet (42220)

| Role | Address |
|---|---|
| 1v1 escrow | `0xabdfea03be58d3276b13b40885311d84259d7f4d` |
| 4-player escrow | `0x0142dd7125e339dcbccbb4e2fc7b28c09d21fc6e` |
| Cosmetics store | `0x423442b6b78423ca8970ee1b92f85236d9194c6f` |
| RacePass (soulbound event pass) | `0x3ca68b8a7e2c429dec33a34e0589173dfb305be4` |
| Stake token (cUSD) | `0x765DE816845861e75A25fCA122bb6898B8B1282a` |

Also deployed on Celo Sepolia (11142220) for testing. Dune queries against these contracts:
`docs/DUNE.md`.

---

## §4 — Notes before sending

**Fill in:** `[Mike]`, `[email]`, `[repo / demo link]`. Add the canonical app URL once the
production domain is fixed (it's also still a TODO in `apps/web/index.html` for the `og:` tags).

**Deliberately not claimed** — keep it that way, because MiniPay will check:

- **No user, DAU or revenue numbers.** Race Week is described as an event we built and ran end to
  end, which is true; no participation or payout figures are quoted, and ER.2 (prize distribution) is
  still open in the backlog. If real numbers exist by the time you send this, add them — they'd be the
  strongest paragraph in the letter.
- **No claim that the contracts have been audited.** The dossier is *prepared* for an external
  auditor; an independent audit is still a hard requirement before scaling stakes
  (`TESTING_REPORT.md`). The letter says "audit dossier already prepared", which is accurate.
- **No promise of a listing timeline or exclusivity.**
- **The house bot is disclosed, not hidden.** It stakes real money against players in the 1¢ event
  tier, so "the house never plays against your money" would be false — the letter and fact sheet say
  what it is instead. Disclosing it *with* the `is_house_bot` tagging reads as integrity; being caught
  omitting it would not.

**Tone check:** the ask is deliberately small and specific (list it, review my checklist, optionally
run an event). Resist the temptation to add a token, a roadmap slide, or a funding ask — the whole
credibility of the letter rests on it being about a working product.
