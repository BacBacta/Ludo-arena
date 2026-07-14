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
import { loadFrameId } from './avatarFrames';
import { loadAvatarId } from './avatars';
import { loadCustomIdentity } from './profile';
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
  /** The socket could not be reached / dropped before/after the game. */
  onGone(): void;
}

const TOKEN_KEY = 'ludo.sessionToken';

export class Remote4 {
  private ws: WebSocket | null = null;
  private disposed = false;
  private inGame = false;
  private readonly entropy: string;

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
      if (!this.disposed) this.connect(commit);
    });
  }

  private connect(entropyCommit: string): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.serverUrl);
    } catch {
      this.ev.onGone();
      return;
    }
    this.ws = ws;
    const failTimer = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) ws.close();
    }, 2500);

    ws.onopen = () => {
      clearTimeout(failTimer);
      this.send({
        t: 'hello',
        entropyCommit,
        sessionToken: this.token() ?? undefined,
        wallet: this.walletAddress,
        fingerprint: deviceFingerprint(),
        consent: this.auth?.consent,
        miniPay: isMiniPay(), // trusted address → server accepts it without SIWE
        frame: loadFrameId(), // equipped avatar frame (cosmetic, broadcast to others)
        avatar: loadAvatarId(), // chosen 3D profile avatar (broadcast to others)
        ...loadCustomIdentity(), // edited display name / country flag
      });
      this.send({ t: 'queue.join4', stakeCents: this.stakeCents });
    };
    ws.onclose = () => {
      clearTimeout(failTimer);
      if (this.disposed) return;
      // No resume in v1: any close before the game is over ends the session.
      this.ev.onGone();
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg;
      } catch {
        return;
      }
      this.handle(msg);
    };
  }

  private handle(msg: ServerMsg): void {
    switch (msg.t) {
      case 'hello.ok':
        try {
          sessionStorage.setItem(TOKEN_KEY, msg.sessionToken);
        } catch {
          /* storage unavailable */
        }
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

  private token(): string | null {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
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
    this.ws?.close();
  }
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
