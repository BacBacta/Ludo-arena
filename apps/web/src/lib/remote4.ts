/**
 * Remote4 — one 4-player online Sit&Go session (ticket entry). Mirrors the
 * 2-player RemoteSession but for the ludo4 protocol: it opens a socket, says
 * hello (with an entropy commit, anti-grinding parity), joins the 4-player
 * queue, and surfaces the server-authoritative game to the screen.
 *
 * v1 is in-memory server-side (a disconnect forfeits the seat to a bot), so
 * unlike the 2-player path there is no reconnect/resume — a dropped socket ends
 * the session. That's acceptable for TICKET games (no on-chain money at stake).
 */
import type { Game4 } from '@ludo/game-engine';
import { walletProofMessage, type Player4Info, type ServerMsg } from '@ludo/shared';
import { deviceFingerprint } from './fingerprint';
import { isMiniPay } from './minipay';
import { withQa } from './session';
import { loadFrameId } from './avatarFrames';
import { loadAvatarId } from './avatars';
import { adoptServerIdentity, loadCustomIdentity } from './profile';
import { sha256Hex } from './fairnessVerify';
import type { WalletAuth } from './session';

export interface Match4Info {
  gameId: string;
  seat: number;
  players: Player4Info[];
  stakeCents: number; // 0 = free table; >0 = cUSD stake per seat
  potCents: number; // winner's cUSD payout (0 for free)
  fairnessCommit: string;
}

export interface Over4Info {
  winner: number;
  payoutCents: number; // winner's cUSD payout (0 for free)
  rakeCents: number;
  fairnessReveal: { serverSeed: string; seeds: string[] };
}

export interface Remote4Events {
  /** In the queue, waiting for a full table (bots fill in after a short wait). */
  onQueued(position: number): void;
  onMatch(info: Match4Info): void;
  onState(state: Game4): void;
  onDice(value: number, index: number, seat: number): void;
  onMoved(seat: number, token: number, capture: boolean, state: Game4): void;
  onTurn(seat: number, deadlineTs: number): void;
  /** A seat sent a quick emote (broadcast to the table). */
  onEmote(seat: number, id: string): void;
  onGift(from: number, to: number, id: string): void;
  onOver(info: Over4Info): void;
  /** Staked payout confirmed on-chain (game.settled4). */
  onSettled(txHash: string): void;
  /** Staked stakes refunded on-chain — table didn't fill (game.refunded4). */
  onRefunded(txHash: string): void;
  /** A server error (bad state) — terminal for this session. */
  onError(message: string): void;
  /** The socket dropped mid-game; the session is retrying in the background
   *  (R-WEB-1). Optional — the board keeps its last state during the retry. */
  onReconnecting?(): void;
  /** The socket could not be reached / dropped before/after the game. */
  onGone(): void;
}

// R-WEB-2: localStorage (not sessionStorage) so the resume token survives a
// webview/tab kill — see the note in session.ts. Shared key with the 2p session.
const TOKEN_KEY = 'ludo.sessionToken';
// R-WEB-1: bounded reconnect attempts for a dropped in-progress (staked) game,
// ~45s of backoff total — mirrors the 2p RemoteSession budget.
const MAX_RECONNECTS = 12;
/** Initial-connect retries before "server unreachable" — survives 3G jitter. */
const MAX_INITIAL_ATTEMPTS4 = 4;

export class Remote4 {
  private ws: WebSocket | null = null;
  private disposed = false;
  private inGame = false;
  private readonly entropy: string;
  private entropyCommit = ''; // sha256(entropy); computed once, reused on reconnect
  private revealedGameId = ''; // gameId we last revealed raw entropy for (once per game)
  private gameOver = false; // set on game.over4 — a close after this is expected
  private reconnects = 0; // consecutive reconnect attempts (bounded)
  private initialAttempts = 0; // initial-connect retries before onGone (3G jitter)
  /** Last message timestamp — liveness. A silently-dead socket (screen off,
   *  sleep, NAT timeout) fires no close event; the heartbeat force-closes it so
   *  the session ends visibly (onGone) instead of freezing the board forever. */
  private lastSeen = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly onVisible = (): void => {
    if (this.disposed || typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    this.send({ t: 'ping' });
    const probeAt = Date.now();
    setTimeout(() => {
      if (!this.disposed && this.lastSeen < probeAt && this.ws) this.ws.close();
    }, 3_500);
  };

  constructor(
    private readonly ev: Remote4Events,
    private readonly serverUrl: string,
    private readonly walletAddress?: string,
    /** 0 = free table; >0 = cUSD stake per seat. */
    private readonly stakeCents: number = 0,
    /** Consent + wallet signer for a staked table (18+/ToS + SIWE proof). */
    private readonly auth?: WalletAuth,
  ) {
    this.entropy = randomHex(32);
    // Commit to our entropy (hash) before connecting: the server uses each seat's
    // commit as its dice contribution and never sees the raw value up front.
    void sha256Hex(this.entropy).then((commit) => {
      this.entropyCommit = commit;
      if (!this.disposed) this.connect(false);
    });
    // Liveness heartbeat (mirrors RemoteSession): ping every 10s; 25s of silence
    // means the socket is dead — close it so the player isn't left frozen.
    this.heartbeat = setInterval(() => {
      if (this.disposed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.send({ t: 'ping' });
      if (this.lastSeen && Date.now() - this.lastSeen > 25_000) this.ws.close();
    }, 10_000);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisible);
  }

  private connect(resume: boolean): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(withQa(this.serverUrl));
    } catch {
      this.scheduleReconnectOrGone();
      return;
    }
    this.ws = ws;
    // Generous handshake budget (was 2.5 s): on a distant/3G link the wss upgrade
    // legitimately takes a few seconds — a tight window turned jitter into a false
    // "server unreachable" on the initial connect.
    const failTimer = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) ws.close();
    }, 4500);

    ws.onopen = () => {
      clearTimeout(failTimer);
      this.send({
        t: 'hello',
        entropyCommit: this.entropyCommit,
        sessionToken: this.token() ?? undefined,
        wallet: this.walletAddress,
        fingerprint: deviceFingerprint(),
        consent: this.auth?.consent,
        miniPay: isMiniPay(), // trusted address → server accepts it without SIWE
        frame: loadFrameId(), // equipped avatar frame (cosmetic, broadcast to others)
        avatar: loadAvatarId(), // chosen 3D profile avatar (broadcast to others)
        ...loadCustomIdentity(), // edited display name / country flag
      });
      // On a RESUME the server reattaches us to our live seat from the token and
      // resyncs (R-WEB-1); joining the queue again would try to start a new game.
      if (!resume) this.send({ t: 'queue.join4', stakeCents: this.stakeCents });
      this.reconnects = 0; // a successful open resets the retry budget
      this.initialAttempts = 0; // reachable → later drops retry, not instant onGone
    };
    ws.onclose = () => {
      clearTimeout(failTimer);
      if (this.disposed || this.gameOver) return;
      this.scheduleReconnectOrGone();
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg;
      } catch {
        return;
      }
      this.lastSeen = Date.now(); // any traffic proves the socket is alive
      this.handle(msg);
    };
  }

  private handle(msg: ServerMsg): void {
    switch (msg.t) {
      case 'hello.ok':
        try {
          localStorage.setItem(TOKEN_KEY, msg.sessionToken);
        } catch {
          /* storage unavailable */
        }
        // Guests: pin the first server-assigned name so it stays the same in
        // every later game/mode (the server derives a NEW one per connection).
        adoptServerIdentity(msg.name);
        // Wallet ownership proof (SIWE) for a staked table: sign the server's nonce.
        if (msg.walletNonce && this.stakeCents > 0 && this.auth?.signMessage) {
          void this.auth
            .signMessage(walletProofMessage(msg.walletNonce))
            .then((signature) => this.send({ t: 'wallet.prove', signature }))
            .catch(() => {
              /* user declined — server keeps staking gated */
            });
        }
        break;
      case 'queue.ok':
        this.ev.onQueued(msg.position);
        break;
      case 'match.found4':
        this.inGame = true;
        // Anti-grinding reveal (R-DICE-3): the server committed its seed knowing
        // only our entropy COMMIT; reveal the raw value now so the staked-4p dice
        // bind to it. Harmless on a free table (the server ignores the reveal).
        if (this.revealedGameId !== msg.gameId) {
          this.revealedGameId = msg.gameId;
          this.send({ t: 'game.entropy', entropy: this.entropy });
        }
        this.ev.onMatch({
          gameId: msg.gameId,
          seat: msg.seat,
          players: msg.players,
          stakeCents: msg.stakeCents,
          potCents: msg.potCents,
          fairnessCommit: msg.fairnessCommit,
        });
        break;
      case 'game.state4':
        this.ev.onState(msg.state);
        break;
      case 'game.dice4':
        this.ev.onDice(msg.value, msg.index, msg.seat);
        break;
      case 'game.moved4':
        this.ev.onMoved(msg.seat, msg.token, msg.capture, msg.state);
        break;
      case 'game.turn4':
        this.ev.onTurn(msg.seat, msg.deadlineTs);
        break;
      case 'game.emote':
        this.ev.onEmote(msg.seat, msg.id);
        break;
      case 'game.gift':
        this.ev.onGift(msg.from, msg.to, msg.id);
        break;
      case 'game.over4':
        this.inGame = false;
        this.gameOver = true; // a socket close after this is expected, not a drop
        this.ev.onOver({ winner: msg.winner, payoutCents: msg.payoutCents, rakeCents: msg.rakeCents, fairnessReveal: msg.fairnessReveal });
        break;
      case 'game.settled4':
        this.ev.onSettled(msg.txHash);
        break;
      case 'game.refunded4':
        this.ev.onRefunded(msg.txHash);
        break;
      case 'error':
        this.ev.onError(msg.message);
        break;
      default:
        break;
    }
  }

  /** R-WEB-1: a dropped IN-PROGRESS game (a staker whose socket blipped) retries
   *  with backoff and resumes via the token; before match.found4 no stake is
   *  locked, so a drop there just ends the search. Gives up after MAX_RECONNECTS. */
  private scheduleReconnectOrGone(): void {
    if (this.disposed || this.gameOver) return;
    // Initial connection (never reached a game): retry a few times before declaring
    // the server gone — a single slow/dropped 3G handshake must not fail instantly.
    if (!this.inGame) {
      this.initialAttempts += 1;
      if (this.initialAttempts >= MAX_INITIAL_ATTEMPTS4) {
        this.ev.onGone();
        return;
      }
      const delay = Math.min(400 * 2 ** (this.initialAttempts - 1), 2000);
      setTimeout(() => {
        if (!this.disposed && !this.gameOver) this.connect(false); // re-send queue.join4
      }, delay);
      return;
    }
    if (this.reconnects >= MAX_RECONNECTS) {
      this.ev.onGone();
      return;
    }
    this.reconnects += 1;
    this.ev.onReconnecting?.();
    const delay = Math.min(500 * 2 ** (this.reconnects - 1), 4000);
    setTimeout(() => {
      if (!this.disposed && !this.gameOver) this.connect(true);
    }, delay);
  }

  private token(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }

  private send(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  roll(): void {
    this.send({ t: 'game.roll' });
  }

  move(token: number): void {
    this.send({ t: 'game.move', token });
  }

  emote(id: string): void {
    this.send({ t: 'emote', id });
  }

  gift(to: number, id: string): void {
    this.send({ t: 'gift', to, id });
  }

  resign(): void {
    this.send({ t: 'game.resign' });
  }

  isInGame(): boolean {
    return this.inGame;
  }

  dispose(): void {
    this.disposed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible);
    this.ws?.close();
  }
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
