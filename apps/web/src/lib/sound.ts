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

/** Chosen sample per event (auditioned in the lab). */
const FILES: Record<string, string> = {
  dice: 'dice.ogg', // real dice throw
  pawn: 'pawn.ogg', // soft wooden step
  capture: 'capture.ogg', // punch impact
  coin: 'coin.ogg', // chips handling
  tap: 'tap.ogg', // UI click
  select: 'select.ogg', // stake selection
  confirm: 'confirm.ogg', // confirm / start / small win
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

/** Warm the cache so the first dice roll / tap has no fetch latency. */
export function preloadSounds(): void {
  if (!soundEnabled()) return;
  for (const name of Object.keys(FILES)) void load(name);
}

interface PlayOpts {
  gain?: number;
  rate?: number; // playbackRate (pitch/speed) — humanises repeated hits
  pan?: number;
  delay?: number; // seconds
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
    let node: AudioNode = src;
    if (o.gain !== undefined && o.gain !== 1) {
      const g = ac.createGain();
      g.gain.value = o.gain;
      src.connect(g);
      node = g;
    }
    if (o.pan) {
      const p = ac.createStereoPanner();
      p.pan.value = o.pan;
      node.connect(p);
      node = p;
    }
    node.connect(master!);
    src.start(ac.currentTime + (o.delay ?? 0));
  };
  if (buffers[name]) start();
  else void load(name).then(start); // first use: load then play (tiny delay once)
}

/* ------------------------------------------------- public API (unchanged names) */

export function playDice(): void {
  playSample('dice', { rate: 0.97 + Math.random() * 0.06 });
}

let lastHop = 0;
export function playHop(): void {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (now - lastHop < 60) return; // fast re-renders never stack
  lastHop = now;
  playSample('pawn', { gain: 0.55, rate: 0.9 + Math.random() * 0.2 }); // soft, humanised
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

/** Emote sounds are sourced in batch 2 (real applause / laughter / etc.).
 *  Until then, silent — the floating emoji still animates. */
export function playEmote(_id: string): void {
  /* batch 2 */
}
