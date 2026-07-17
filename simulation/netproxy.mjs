/**
 * Chaos WebSocket proxy (Phase 5) — the Toxiproxy equivalent for this stack.
 * Sits between a bot and the real server and injects, per direction and live-
 * tunable at runtime:
 *   - latency  (delay every frame; asymmetric up/down supported)
 *   - loss     (drop frames with probability p)
 *   - reorder  (hold a frame and release it after the next one)
 *   - kill     (brutal socket close, e.g. mid dice-roll)
 *
 * Usage:
 *   const proxy = await startChaosProxy({ port: 9001, upstream: 'ws://localhost:8787' });
 *   proxy.toxics.latencyDownMs = 2000;      // server→client lag
 *   proxy.killAll();                        // brutal disconnect
 *   await proxy.close();
 */
// ws's ESM entry exposes WebSocket/WebSocketServer as NAMED exports (its default
// is the WebSocket class itself, which carries no .WebSocketServer).
import { WebSocket, WebSocketServer } from 'ws';

export async function startChaosProxy({ port, upstream }) {
  const toxics = {
    latencyUpMs: 0, // client → server
    latencyDownMs: 0, // server → client
    lossUp: 0, // 0..1 probability
    lossDown: 0,
    reorderDown: 0, // 0..1 probability a server→client frame is held behind the next
  };
  const links = new Set();

  const wss = new WebSocketServer({ port, maxPayload: 10 * 1024 });

  wss.on('connection', (client, req) => {
    const up = new WebSocket(upstream + (req.url && req.url !== '/' ? req.url : '/'));
    const pending = []; // client frames buffered until upstream opens
    const link = { client, up, held: null };
    links.add(link);

    const flushHeld = (sock) => {
      if (!link.held) return;
      const h = link.held;
      link.held = null;
      if (link.heldTimer) { clearTimeout(link.heldTimer); link.heldTimer = null; }
      if (sock.readyState === WebSocket.OPEN) sock.send(h); // released late = out of order
    };

    const forward = (sock, data, { delay, loss, reorder }) => {
      if (loss && Math.random() < loss) return; // packet dropped
      const send = () => {
        if (sock.readyState !== WebSocket.OPEN) return;
        // reorder: hold this frame so the NEXT one overtakes it. A held frame must
        // ALWAYS still arrive — release it on the next frame OR after a short
        // timer, otherwise a client waiting on a lone reply (e.g. hello.ok) with no
        // follow-up traffic would deadlock (reorder must delay, never drop).
        if (reorder && Math.random() < reorder && !link.held) {
          link.held = data;
          link.heldTimer = setTimeout(() => flushHeld(sock), 120);
          return;
        }
        sock.send(data);
        flushHeld(sock);
      };
      if (delay) setTimeout(send, delay);
      else send();
    };

    up.on('open', () => {
      for (const d of pending.splice(0)) up.send(d);
    });
    client.on('message', (d) => {
      const data = typeof d === 'string' ? d : d.toString();
      if (up.readyState === WebSocket.OPEN) forward(up, data, { delay: toxics.latencyUpMs, loss: toxics.lossUp, reorder: 0 });
      else pending.push(data);
    });
    up.on('message', (d) => {
      const data = typeof d === 'string' ? d : d.toString();
      forward(client, data, { delay: toxics.latencyDownMs, loss: toxics.lossDown, reorder: toxics.reorderDown });
    });

    const teardown = () => {
      links.delete(link);
      try { client.close(); } catch { /* closing */ }
      try { up.close(); } catch { /* closing */ }
    };
    client.on('close', teardown);
    up.on('close', teardown);
    client.on('error', () => {});
    up.on('error', () => {});
  });

  await new Promise((r) => wss.once('listening', r));

  return {
    toxics,
    url: `ws://localhost:${port}`,
    /** Brutal disconnect of every live link (simulates a dropped connection). */
    killAll() {
      for (const l of [...links]) {
        try { l.client.terminate(); } catch { /* gone */ }
        try { l.up.terminate(); } catch { /* gone */ }
        links.delete(l);
      }
    },
    linkCount: () => links.size,
    close: () => new Promise((r) => wss.close(r)),
  };
}
