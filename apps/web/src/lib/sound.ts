/**
 * Ludo Arena sound engine — REAL recorded samples (Kenney.nl, CC0 / public
 * domain, commercial-safe, no attribution required). Replaces the previous
 * procedural synthesis. Files live in `public/sfx/` and are decoded once into
 * AudioBuffers, then played through a shared master gain (respects the sound
 * toggle). Samples were auditioned + chosen in the sound lab.
 *
 * Format note: the packs ship as OGG Vorbis — decoded natively by Chromium
 * (Android / MiniPay, the primary target) and most desktop browsers. iOS Safari
 * doesn't decode OGG, so audio there degrades to silence (never an error). MP3
 * fallbacks can be added later if iOS web traffic matters.
 *
 * Emotes + landing music are sourced in a second batch; until then emote taps
 * are silent (visual only) rather than reusing a mismatched sound.
 */
const SOUND_KEY = 'ludo.sound';

export function soundEnabled(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSoundEnabled(on: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
  } catch {
    /* storage unavailable */
  }
}

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
function audio(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    if (!master) {
      master = ctx.createGain();
      master.gain.value = 0.85;
      const comp = ctx.createDynamicsCompressor(); // safety glue, never startle
      comp.threshold.value = -10;
      comp.ratio.value = 2;
      master.connect(comp);
      comp.connect(ctx.destination);
    }
    return ctx;
  } catch {
    return null;
  }
}

/** Chosen sample per event (auditioned in the lab). Board/UI = Kenney CC0 (OGG);
 *  emotes = Mixkit Free License (MP3), each a LITERAL sound for its emoji. */
const FILES: Record<string, string> = {
  dice: 'dice.ogg', // real dice throw
  pawn: 'pawn.ogg', // soft wooden step
  capture: 'capture.ogg', // punch impact
  coin: 'coin.ogg', // chips handling
  tap: 'tap.ogg', // UI click
  select: 'select.ogg', // stake selection
  confirm: 'confirm.ogg', // confirm / start / small win
  e_clap: 'emotes/clap.mp3',
  e_laugh: 'emotes/laugh.mp3',
  e_fire: 'emotes/fire.mp3',
  e_party: 'emotes/party.mp3',
  e_mind: 'emotes/mind.mp3',
  e_whoa: 'emotes/whoa.mp3',
  e_sad: 'emotes/sad.mp3',
  e_muscle: 'emotes/muscle.mp3',
  e_charm: 'emotes/charm.mp3',
  e_up: 'emotes/up.mp3',
  e_cool: 'emotes/cool.mp3',
  g_coffee: 'gifts/coffee.mp3',
  g_rose: 'gifts/rose.mp3',
  g_choc: 'gifts/chocolate.mp3',
  g_gift: 'gifts/gift.mp3',
  g_pizza: 'gifts/pizza.mp3',
  g_boba: 'gifts/bubbletea.mp3',
  g_beer: 'gifts/beer.mp3',
  g_cake: 'gifts/cake.mp3',
};

/** Emoji → sample + per-emote level (I can't ear-tune, so levels are moderate;
 *  the master compressor guards peaks). 🎲 reuses the board dice. */
const EMOTE_MAP: Record<string, { name: string; gain: number }> = {
  '👏': { name: 'e_clap', gain: 0.6 },
  '😂': { name: 'e_laugh', gain: 0.75 },
  '🔥': { name: 'e_fire', gain: 0.6 },
  '🎉': { name: 'e_party', gain: 0.65 },
  '🤯': { name: 'e_mind', gain: 0.55 },
  '😮': { name: 'e_whoa', gain: 0.8 },
  '😢': { name: 'e_sad', gain: 0.8 },
  '💪': { name: 'e_muscle', gain: 0.75 },
  '🍀': { name: 'e_charm', gain: 0.75 },
  '👍': { name: 'e_up', gain: 0.75 },
  '😎': { name: 'e_cool', gain: 0.7 },
  '🎲': { name: 'dice', gain: 0.8 },
};

/** Gift emoji → its dedicated sample + level, each a LITERAL sound for the item
 *  (☕ = a hot sip, 🍺 = clinking glasses, 🎂 = a birthday cheer…). Chosen in the
 *  gift lab. Long clips (🍫 🍕 🎂) are capped in playGift so a reaction stays snappy. */
const GIFT_MAP: Record<string, { name: string; gain: number }> = {
  '☕': { name: 'g_coffee', gain: 0.85 },
  '🌹': { name: 'g_rose', gain: 0.75 },
  '🍫': { name: 'g_choc', gain: 0.8 },
  '🎁': { name: 'g_gift', gain: 0.7 },
  '🍕': { name: 'g_pizza', gain: 0.8 },
  '🧋': { name: 'g_boba', gain: 0.9 },
  '🍺': { name: 'g_beer', gain: 0.85 },
  '🎂': { name: 'g_cake', gain: 0.7 },
};

const buffers: Record<string, AudioBuffer> = {};
const loading: Record<string, Promise<void>> = {};

function url(file: string): string {
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return `${base}sfx/${file}`;
}

function load(name: string): Promise<void> {
  if (buffers[name]) return Promise.resolve();
  if (loading[name]) return loading[name]!;
  const ac = audio();
  const file = FILES[name];
  if (!ac || !file) return Promise.resolve();
  loading[name] = fetch(url(file))
    .then((r) => r.arrayBuffer())
    .then((ab) => ac.decodeAudioData(ab))
    .then((buf) => {
      buffers[name] = buf;
    })
    .catch(() => {
      /* unsupported format (iOS) or offline → stays silent, never throws */
    });
  return loading[name]!;
}

/** Small, always-needed board/UI sounds preloaded on the first gesture so the
 *  first dice roll / tap has no fetch latency. Emotes (heavier, MP3) load lazily
 *  on first use — never fetched just for opening the app. */
const CORE = ['dice', 'pawn', 'capture', 'coin', 'tap', 'select', 'confirm'];
export function preloadSounds(): void {
  if (!soundEnabled()) return;
  for (const name of CORE) void load(name);
}

interface PlayOpts {
  gain?: number;
  rate?: number; // playbackRate (pitch/speed) — humanises repeated hits
  pan?: number;
  delay?: number; // seconds
  maxDur?: number; // cap a long clip (e.g. applause) with a soft fade-out
}

function playSample(name: string, o: PlayOpts = {}): void {
  if (!soundEnabled()) return;
  const ac = audio();
  if (!ac || !master) return;
  const start = (): void => {
    const buf = buffers[name];
    if (!buf) return;
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = o.rate ?? 1;
    const g = ac.createGain();
    g.gain.value = o.gain ?? 1;
    src.connect(g);
    let node: AudioNode = g;
    if (o.pan) {
      const p = ac.createStereoPanner();
      p.pan.value = o.pan;
      node.connect(p);
      node = p;
    }
    node.connect(master!);
    const t = ac.currentTime + (o.delay ?? 0);
    src.start(t);
    // keep in-game reactions snappy: fade + stop a long sample early
    if (o.maxDur && buf.duration > o.maxDur) {
      g.gain.setValueAtTime(o.gain ?? 1, t + o.maxDur - 0.18);
      g.gain.exponentialRampToValueAtTime(0.0001, t + o.maxDur);
      src.stop(t + o.maxDur + 0.03);
    }
  };
  if (buffers[name]) start();
  else void load(name).then(start); // first use: load then play (tiny delay once)
}

/* ------------------------------------------------- public API (unchanged names) */

export function playDice(): void {
  // Was too thin: a fuller, louder throw + a soft low wooden "landing" thud for
  // weight (the die settling on the board). Fires for EVERY seat's roll.
  const r = 0.9 + Math.random() * 0.07;
  playSample('dice', { gain: 1.6, rate: r });
  playSample('pawn', { gain: 0.4, rate: 0.8, delay: 0.05 });
}

let lastHop = 0;
export function playHop(): void {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (now - lastHop < 60) return; // fast re-renders never stack
  lastHop = now;
  // Clearly audible wooden step per cell (was too faint at 0.55). Hops are 300 ms
  // apart (WALK_STEP_MS), so a strong level reads as a satisfying tap, not a buzz.
  playSample('pawn', { gain: 1.5, rate: 0.9 + Math.random() * 0.2 });
}

export function playCapture(): void {
  playSample('capture', { gain: 0.95 });
}

export function playWin(): void {
  playSample('confirm', { gain: 1 });
  playSample('coin', { gain: 0.7, delay: 0.16 });
}

/** No dedicated loss sample yet — a soft, brief synth sigh (kept minimal so it
 *  never reads as "cheap"; a real cue can replace it in batch 2). */
export function playLose(): void {
  if (!soundEnabled()) return;
  const ac = audio();
  if (!ac || !master) return;
  const o = ac.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(330, ac.currentTime);
  o.frequency.exponentialRampToValueAtTime(196, ac.currentTime + 0.45);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, ac.currentTime);
  g.gain.exponentialRampToValueAtTime(0.08, ac.currentTime + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.5);
  o.connect(g);
  g.connect(master);
  o.start();
  o.stop(ac.currentTime + 0.55);
}

/** Payout count-up: the chips-handling sample once (it already reads as a
 *  cascade of chips). `steps` kept for signature compatibility. */
export function playPayout(_steps = 10): void {
  playSample('coin', { gain: 0.9 });
}

export function playTap(kind: 'tap' | 'select' = 'tap'): void {
  playSample(kind === 'select' ? 'select' : 'tap', { gain: 0.6 });
}

/** Match start (PLAY): the confirm sample. */
export function playStart(): void {
  playSample('confirm', { gain: 0.9 });
}

/** App-open cue on the first gesture — also warms the sample cache. A real
 *  music bed replaces this in batch 2. */
export function playWelcome(): void {
  preloadSounds();
  playSample('confirm', { gain: 0.7 });
}

/* ------------------------------------------------------------- landing music */

let musicEl: HTMLAudioElement | null = null;
let musicWanted = false;

function ensureMusicEl(): HTMLAudioElement | null {
  if (typeof Audio === 'undefined') return null;
  if (!musicEl) {
    musicEl = new Audio(url('landing.mp3')); // streamed (range requests), lazy
    musicEl.loop = true;
    musicEl.preload = 'none';
    musicEl.volume = 0.3; // low bed under the SFX
  }
  return musicEl;
}

/** Start the festive landing loop. Browsers block audio before a user gesture,
 *  so a blocked start auto-retries on the next pointerdown. Idempotent. */
export function startMusic(): void {
  if (!soundEnabled()) return;
  const el = ensureMusicEl();
  if (!el) return;
  musicWanted = true;
  void el.play().catch(() => {
    const retry = (): void => {
      if (musicWanted && soundEnabled()) void el.play().catch(() => {});
    };
    window.addEventListener('pointerdown', retry, { once: true });
  });
}

/** Stop the landing loop (leaving the lobby, or sound turned off). */
export function stopMusic(): void {
  musicWanted = false;
  if (musicEl) musicEl.pause();
}

/** A gift was sent/received — plays that gift's dedicated, literal sound (☕ sip,
 *  🍺 clink, 🎂 birthday cheer…), capped ~2.6 s so it stays snappy. Unknown ids
 *  fall back to the soft confirm chime. */
export function playGift(id?: string): void {
  const m = id ? GIFT_MAP[id] : undefined;
  if (!m) {
    playSample('confirm', { gain: 0.5 });
    return;
  }
  playSample(m.name, { gain: m.gain, maxDur: 2.6 });
}

/** Real per-emoji sounds (Mixkit) — clap = applause, laugh = laughter, etc.
 *  Long clips are capped ~2.6 s so a reaction stays snappy. Unmapped ids
 *  (quick-chats) stay silent; the floating emoji still animates. */
export function playEmote(id: string): void {
  const m = EMOTE_MAP[id];
  if (!m) return;
  playSample(m.name, { gain: m.gain, maxDur: 2.6 });
}
