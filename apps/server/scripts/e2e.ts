/**
 * Test e2e : deux clients WebSocket rejoignent la file (mise 25c) et jouent
 * une partie complete jusqu'au game.over. Verifie le flux protocole de bout en bout.
 * Usage : demarrer le serveur (npm run dev) puis `npm run e2e`.
 */
import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';
import { applyRoll } from '@ludo/game-engine';
import type { GameState, Seat } from '@ludo/game-engine';
import type { ServerMsg } from '@ludo/shared';

const URL = process.env.SERVER_URL ?? 'ws://localhost:8787';

function makeClient(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    let seat: Seat | null = null;
    let state: GameState | null = null;

    const timer = setTimeout(() => reject(new Error(label + ': timeout e2e')), 90_000);

    function send(obj: unknown): void {
      ws.send(JSON.stringify(obj));
    }

    function act(): void {
      if (!state || seat === null || state.winner !== null) return;
      if (state.turn !== seat) return;
      if (state.phase === 'awaiting-roll') {
        setTimeout(() => send({ t: 'game.roll' }), 25);
      } else if (state.phase === 'awaiting-move' && state.legal.length > 0) {
        const token = state.legal[0];
        setTimeout(() => send({ t: 'game.move', token }), 25);
      }
    }

    ws.on('open', () => {
      send({ t: 'hello', entropy: randomBytes(16).toString('hex') });
      send({ t: 'queue.join', stake: 25 });
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMsg;
      switch (msg.t) {
        case 'match.found':
          seat = msg.seat;
          break;
        case 'game.state':
        case 'game.moved':
          state = msg.state;
          act();
          break;
        case 'game.dice':
          // replique le lancer localement pour connaitre ses coups legaux
          if (state && state.phase === 'awaiting-roll') {
            try {
              state = applyRoll(state, msg.value);
            } catch {
              /* resync via prochain game.moved */
            }
            act();
          }
          break;
        case 'game.turn':
          act();
          break;
        case 'game.over': {
          clearTimeout(timer);
          const won = msg.winner === seat;
          ws.close();
          resolve(
            label + ': winner=' + msg.winner + (won ? ' (gagne)' : ' (perd)') +
            ' payout=' + msg.payoutCents + 'c rake=' + msg.rakeCents +
            'c seed=' + msg.fairnessReveal.serverSeed.slice(0, 8) + '...',
          );
          break;
        }
        case 'error':
          // courses benignes (NOT_YOUR_TURN apres auto-play serveur) : ignore
          break;
        default:
          break;
      }
    });

    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(label + ': ' + String(e)));
    });
  });
}

const [a, b] = await Promise.all([makeClient('clientA'), makeClient('clientB')]);
console.log(a + '\n' + b);
console.log('E2E OK');
process.exit(0);
