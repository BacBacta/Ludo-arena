/**
 * Shared audit-harness library (QA-GAME-AUDIT-PROMPT.md).
 *
 * Two families of helpers:
 *  - WireBot: a protocol-level client (ws) that speaks the real fairness
 *    handshake (entropyCommit in hello, game.entropy reveal on match) and can
 *    play a full game to game.over. Fast — used for state-machine, pacing,
 *    identity and gate probes.
 *  - Playwright helpers: launch, welcome-modal dismissal, private-table pairing,
 *    board/label readers. Used for everything the player actually SEES.
 *
 * Env: SRV (default ws://localhost:8787), WEB (default http://localhost:8898).
 */
import wspkg from 'ws';
import { createHash, randomBytes } from 'node:crypto';

// ws's ESM entry exports the class as default; the CJS deep path exposes
// `.WebSocket`. Support both so the harness runs regardless of resolution.
export const WebSocket = wspkg.WebSocket ?? wspkg;
export const SRV = process.env.SRV || 'ws://localhost:8787';
export const WEB = process.env.WEB || 'http://localhost:8898';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Simple per-file assertion tally so every probe reports the same way. */
export function tally(file) {
  const rows = [];
  return {
    check(name, ok, detail = '') {
      rows.push({ name, ok: !!ok, detail });
      console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
      return !!ok;
    },
    note: (msg) => console.log(`  · ${msg}`),
    done() {
      const bad = rows.filter((r) => !r.ok);
      console.log(`\n[${file}] ${rows.length - bad.length}/${rows.length} checks passed${bad.length ? ` — FAILURES: ${bad.map((b) => b.name).join(', ')}` : ''}`);
      process.exitCode = bad.length ? 1 : 0;
      return bad.length === 0;
    },
  };
}

/**
 * Protocol-level player. Collects every server message in `log` (with `at`
 * timestamps) and exposes awaitable helpers. `opts.autoReveal` (default true)
 * sends game.entropy on match.found/match.found4 so the room actually starts.
 */
export class WireBot {
  constructor(name, opts = {}) {
    this.name = name;
    this.opts = opts;
    this.entropy = randomBytes(32).toString('hex');
    this.log = [];
    this.hello = null; // hello.ok payload
    this.match = null; // match.found / match.found4 payload
    this.over = null; // game.over / game.over4 payload
    this.state = null; // latest game state (2p or 4p)
    this.closed = false;
    this.ws = null;
  }

  connect(extraHello = {}) {
    return new Promise((resolve, reject) => {
      // opts.url lets a single run point different bots at different endpoints
      // (e.g. separate chaos proxies for asymmetric latency); defaults to SRV.
      const ws = new WebSocket(this.opts.url ?? SRV);
      this.ws = ws;
      const to = setTimeout(() => reject(new Error(`${this.name}: hello timeout`)), 8000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ t: 'hello', entropyCommit: sha256(this.entropy), name: this.name, ...extraHello }));
      });
      ws.on('message', (d) => {
        let m;
        try { m = JSON.parse(String(d)); } catch { return; }
        m.at = Date.now();
        this.log.push(m);
        if (m.t === 'hello.ok') { this.hello = m; clearTimeout(to); resolve(this); }
        if (m.t === 'match.found' || m.t === 'match.found4') {
          this.match = m;
          if (this.opts.autoReveal !== false) this.send({ t: 'game.entropy', entropy: this.entropy });
        }
        if (m.t === 'game.state' || m.t === 'game.state4') this.state = m.state;
        if (m.t === 'game.moved' || m.t === 'game.moved4') this.state = m.state;
        if (m.t === 'game.over' || m.t === 'game.over4') this.over = m;
        this.onMessage?.(m);
      });
      ws.on('error', (e) => { clearTimeout(to); if (!this.hello) reject(e); });
      ws.on('close', () => { this.closed = true; });
    });
  }

  send(obj) { try { this.ws.send(JSON.stringify(obj)); } catch { /* closed */ } }
  close() { try { this.ws.close(); } catch { /* already */ } }

  /** Position marker into the message log — pair with awaitFrom. Timestamp
   *  filters (`m.at > since`) are UNRELIABLE locally: a reply often lands in the
   *  same millisecond as the send and the predicate silently misses it. */
  mark() { return this.log.length; }

  /** Wait for the first message at/after log index `from` matching `pred`. */
  awaitFrom(from, pred, ms = 8000, label = 'message') {
    const seen = this.log.slice(from).find(pred);
    if (seen) return Promise.resolve(seen);
    return this.await((m) => this.log.indexOf(m) >= from && pred(m), ms, label);
  }

  /** Wait until a logged message matches `pred` (also checks past messages). */
  await(pred, ms = 15000, label = 'message') {
    const hit = this.log.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => { this.onMessage = prev; reject(new Error(`${this.name}: timeout waiting for ${label}`)); }, ms);
      const prev = this.onMessage;
      this.onMessage = (m) => {
        prev?.(m);
        if (pred(m)) { clearTimeout(to); this.onMessage = prev; resolve(m); }
      };
    });
  }

  /**
   * Autoplay loop: roll on my turn, play the first legal token on awaiting-move,
   * until game over (or `maxMs`). `moveDelay` paces harness taps so they are
   * never mistaken for server auto-moves in pacing measurements.
   */
  async playUntilOver({ maxMs = 240_000, moveDelay = 150, is4p = false } = {}) {
    const seat = this.match?.seat;
    const turnT = is4p ? 'game.turn4' : 'game.turn';
    const stateT = is4p ? 'game.state4' : 'game.state';
    const deadline = Date.now() + maxMs;
    const act = async () => {
      if (this.over || this.closed) return;
      const s = this.state;
      if (!s || s.turn !== seat) return;
      if (s.phase === 'awaiting-roll') this.send({ t: 'game.roll' });
      else if (s.phase === 'awaiting-move' && s.legal?.length) {
        await sleep(moveDelay);
        if (!this.over && this.state?.turn === seat && this.state.phase === 'awaiting-move') {
          this.send({ t: 'game.move', token: this.state.legal[0] });
        }
      }
    };
    const prev = this.onMessage;
    this.onMessage = (m) => {
      prev?.(m);
      if (m.t === turnT || m.t === stateT || m.t === (is4p ? 'game.moved4' : 'game.moved')) void act();
    };
    void act();
    while (!this.over && Date.now() < deadline && !this.closed) await sleep(250);
    this.onMessage = prev;
    return this.over;
  }
}

/** Pair two fresh bots on a FREE private table; resolves once both have match.found. */
export async function privatePair(nameA = 'AuditHost', nameB = 'AuditGuest', stake = 0) {
  const a = new WireBot(nameA);
  await a.connect();
  a.send({ t: 'table.create', stake });
  const created = await a.await((m) => m.t === 'table.created', 8000, 'table.created');
  const b = new WireBot(nameB);
  await b.connect();
  b.send({ t: 'table.join', code: created.code });
  await Promise.all([
    a.await((m) => m.t === 'match.found', 10000, 'match.found (host)'),
    b.await((m) => m.t === 'match.found', 10000, 'match.found (guest)'),
  ]);
  return { a, b, code: created.code };
}

// ---------------------------------------------------------------- Playwright

export async function launchBrowser() {
  const pw = await import('playwright');
  return pw.chromium.launch({ headless: true, args: ['--disable-gpu', '--no-sandbox'] });
}

export async function newPlayer(browser, ctxOpts = {}) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const wire = { helloName: null, helloSent: null, seat: null, seat4: null, pingsSent: 0 };
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => {
      try {
        const m = JSON.parse(f.payload);
        if (m.t === 'hello.ok' && m.name) wire.helloName = m.name;
        if (m.t === 'match.found') wire.seat = m.seat;
        if (m.t === 'match.found4') wire.seat4 = m.seat;
      } catch { /* binary/other */ }
    });
    ws.on('framesent', (f) => {
      try {
        const m = JSON.parse(f.payload);
        if (m.t === 'ping') wire.pingsSent++;
        if (m.t === 'hello') wire.helloSent = m; // observe wallet/miniPay claims
      } catch { /* other */ }
    });
  });
  return { ctx, page, wire };
}

/** Android low-end webview emulation (MiniPay's target): 360x800, touch. */
export const MOBILE_CONTEXT = {
  viewport: { width: 360, height: 800 },
  userAgent: 'Mozilla/5.0 (Linux; Android 10; SM-A105F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
};

/**
 * Inject a MOCKED MiniPay wallet (window.ethereum) BEFORE the app boots, for CI.
 * `opts.reject` makes eth_requestAccounts throw a user-rejected (4001) error to
 * test the refusal path. Real signing is exercised manually on Celo Sepolia.
 * The provider records every request method in `window.__ethCalls`.
 */
export async function injectMiniPay(page, opts = {}) {
  const address = opts.address || '0x00000000000000000000000000000000000000Aa';
  const reject = !!opts.reject;
  await page.addInitScript(({ address, reject }) => {
    const calls = [];
    // eslint-disable-next-line no-undef
    window.__ethCalls = calls;
    // eslint-disable-next-line no-undef
    window.ethereum = {
      isMiniPay: true,
      request: async ({ method }) => {
        calls.push(method);
        if ((method === 'eth_requestAccounts' || method === 'eth_accounts') && reject) {
          const e = new Error('User rejected the request');
          e.code = 4001;
          throw e;
        }
        switch (method) {
          case 'eth_requestAccounts':
          case 'eth_accounts':
            return [address];
          case 'eth_chainId':
            return '0xaa044c'; // 11142220 (Celo Sepolia)
          case 'net_version':
            return '11142220';
          case 'wallet_switchEthereumChain':
            return null;
          case 'eth_getBalance':
            return '0x0';
          default:
            return null;
        }
      },
    };
  }, { address, reject });
}

export async function openLobby(page) {
  await page.goto(WEB, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2200);
  await page.getByText(/\(tap to close\)/i).first().click({ timeout: 2500 }).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
}

/** Host creates a free private table; guest joins by deep link. */
export async function uiPrivatePair(browser) {
  const host = await newPlayer(browser);
  await openLobby(host.page);
  await host.page.getByText(/Private table/i).first().click({ timeout: 5000 });
  await host.page.waitForTimeout(1500);
  const code = (await host.page.locator('.tablecode').first().textContent({ timeout: 4000 }))?.trim();
  const guest = await newPlayer(browser);
  await guest.page.goto(`${WEB}/#/g/${code}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await guest.page.waitForTimeout(2200);
  await guest.page.getByText(/\(tap to close\)/i).first().click({ timeout: 2500 }).catch(() => {});
  await guest.page.keyboard.press('Escape').catch(() => {}); // belt & suspenders vs a stuck modal
  await host.page.waitForTimeout(3500);
  return { host, guest, code };
}

/** 2p banner labels by displayed corner (s0 = my bottom-left after board spin). */
export const banners2p = (page) => page.evaluate(() => {
  const out = {};
  document.querySelectorAll('.pbanner').forEach((b) => {
    const cls = [...b.classList].find((c) => /^pbanner--s\d$/.test(c));
    if (cls) out[cls.slice(-1)] = (b.textContent || '').trim();
  });
  return out;
});

/** 4p quadrant labels (q0 = bottom-left). */
export const labels4p = (page) => page.evaluate(() => {
  const out = {};
  document.querySelectorAll('.plabel').forEach((l) => {
    const cls = [...l.classList].find((c) => /^plabel--q\d$/.test(c));
    if (cls) out[cls.slice(-1)] = (l.textContent || '').trim();
  });
  return out;
});

/** Tap-through one UI turn if possible: roll then play a movable token. */
export async function uiPlayTick(page) {
  const btn = page.locator('button.dicebtn:not([disabled])');
  if (await btn.count()) {
    await btn.first().click({ timeout: 800 }).catch(() => {});
    await page.waitForTimeout(300);
  }
  const tk = page.locator('.token--movable');
  if (await tk.count()) await tk.first().click({ timeout: 700, force: true }).catch(() => {});
}
