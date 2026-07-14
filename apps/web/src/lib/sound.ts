/**
 * Ludo Arena sound engine — fully procedural (zero asset bytes), designed as a
 * coherent sonic identity rather than a pile of beeps:
 *
 *   · one MASTER CHAIN (soft tape-style saturation → air shelf → compressor)
 *   · one SPACE — a generated-impulse-response convolution room, so every sound
 *     sits in the same believable acoustic (the previous comb network rang
 *     metallic); pre-delay keeps transients dry and readable
 *   · a small set of expert voices: 2-op FM (bells/knocks/glass), Karplus-Strong
 *     plucked strings, Peltola-style granular hand-claps, and a formant vocal
 *     synth (laughter/whoa/sigh) — each emote is a LITERAL translation of its
 *     emoji, not a generic blip
 *   · sonic-branding discipline: a ≤1.2 s audio logo on the first user gesture,
 *     micro-interactions ≤120 ms, per-layer peaks bounded, everything opt-out.
 *
 * iOS-Safari-safe nodes only. Opt-out persisted; no-op when unsupported.
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
function audio(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function play(build: (ac: AudioContext, now: number) => void): void {
  if (!soundEnabled()) return;
  const ac = audio();
  if (!ac) return;
  build(ac, ac.currentTime);
}

/* ------------------------------------------------------------------ master */

let master: GainNode | null = null;
let reverbSend: GainNode | null = null;

/** Soft-saturation transfer curve (gentle tanh — glue, never distortion). */
function satCurve(): Float32Array<ArrayBuffer> {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(1.4 * x) / Math.tanh(1.4);
  }
  return c;
}

/** Generated stereo impulse response: 0.9 s exponential-decay noise whose tail
 *  progressively darkens (one-pole lowpass with a closing cutoff) — a small,
 *  warm room. Deterministic enough, zero assets, no normalize() surprises. */
function roomIR(ac: AudioContext): AudioBuffer {
  const dur = 0.9;
  const n = Math.floor(ac.sampleRate * dur);
  const buf = ac.createBuffer(2, n, ac.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const decay = Math.exp(-6.2 * t);
      const a = 0.55 - 0.42 * t; // closing lowpass: bright head, dark tail
      lp += a * ((Math.random() * 2 - 1) - lp);
      d[i] = lp * decay * 0.55;
    }
  }
  return buf;
}

/** Master bus: sum → soft saturator → air shelf → compressor → out, plus a
 *  convolution-room send with 12 ms pre-delay. Built once per context. */
function bus(ac: AudioContext): { out: GainNode; send: GainNode } {
  if (!master || !reverbSend) {
    master = ac.createGain();
    master.gain.value = 0.55; // headroom: never clip or startle

    const shaper = ac.createWaveShaper();
    shaper.curve = satCurve();
    shaper.oversample = '2x';

    const air = ac.createBiquadFilter();
    air.type = 'highshelf';
    air.frequency.value = 7600;
    air.gain.value = 2.5;

    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 18;
    comp.ratio.value = 3;
    comp.attack.value = 0.003;
    comp.release.value = 0.22;

    master.connect(shaper);
    shaper.connect(air);
    air.connect(comp);
    comp.connect(ac.destination);

    reverbSend = ac.createGain();
    reverbSend.gain.value = 1;
    const pre = ac.createDelay(0.05);
    pre.delayTime.value = 0.012; // transients stay dry + readable
    const conv = ac.createConvolver();
    conv.normalize = false;
    conv.buffer = roomIR(ac);
    const wet = ac.createGain();
    wet.gain.value = 0.4;
    reverbSend.connect(pre);
    pre.connect(conv);
    conv.connect(wet);
    wet.connect(master);
  }
  return { out: master, send: reverbSend };
}

/* --------------------------------------------------------------- primitives */

interface Hit {
  freq: number;
  q: number;
  dur: number;
  peak: number;
  pan: number;
  sendAmt?: number;
}

/** Bandpass-filtered decaying noise burst (woody/plastic tick), stereo-panned. */
function tick(ac: AudioContext, out: GainNode, send: GainNode, t0: number, h: Hit): void {
  const n = Math.max(1, Math.floor(ac.sampleRate * h.dur));
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = ac.createBufferSource();
  src.buffer = buf;
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = h.freq;
  bp.Q.value = h.q;
  const g = ac.createGain();
  g.gain.value = h.peak;
  const p = ac.createStereoPanner();
  p.pan.value = h.pan;
  src.connect(bp);
  bp.connect(g);
  g.connect(p);
  p.connect(out);
  if (h.sendAmt) {
    const s = ac.createGain();
    s.gain.value = h.sendAmt;
    p.connect(s);
    s.connect(send);
  }
  src.start(t0);
  src.stop(t0 + h.dur + 0.02);
}

/** Fast-decaying resonant partial — a simple tonal body mode. */
function mode(
  ac: AudioContext,
  out: GainNode,
  send: GainNode,
  t0: number,
  freq: number,
  dur: number,
  peak: number,
  type: OscillatorType,
  sendAmt = 0,
): void {
  const o = ac.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g);
  g.connect(out);
  if (sendAmt) {
    const s = ac.createGain();
    s.gain.value = sendAmt;
    g.connect(s);
    s.connect(send);
  }
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

/** Pitch-glide oscillator with an attack/decay envelope — risers, sighs, drips. */
function gliss(
  ac: AudioContext,
  out: GainNode,
  send: GainNode,
  t0: number,
  f0: number,
  f1: number,
  dur: number,
  peak: number,
  type: OscillatorType,
  sendAmt = 0,
  pan = 0,
  attack = 0.02,
): void {
  const o = ac.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(Math.max(20, f0), t0);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  const p = ac.createStereoPanner();
  p.pan.value = pan;
  o.connect(g);
  g.connect(p);
  p.connect(out);
  if (sendAmt) {
    const sg = ac.createGain();
    sg.gain.value = sendAmt;
    p.connect(sg);
    sg.connect(send);
  }
  o.start(t0);
  o.stop(t0 + dur + 0.03);
}

/** Band-SWEPT noise — a moving whoosh (tick() is a fixed-band transient). */
function whoosh(
  ac: AudioContext,
  out: GainNode,
  send: GainNode,
  t0: number,
  f0: number,
  f1: number,
  dur: number,
  peak: number,
  q = 1.4,
  sendAmt = 0.5,
): void {
  const n = Math.max(1, Math.floor(ac.sampleRate * dur));
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(Math.max(40, f0), t0);
  bp.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t0 + dur);
  bp.Q.value = q;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + dur * 0.35);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(bp);
  bp.connect(g);
  g.connect(out);
  if (sendAmt) {
    const sg = ac.createGain();
    sg.gain.value = sendAmt;
    g.connect(sg);
    sg.connect(send);
  }
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

/** 2-operator FM voice — the premium tonal primitive. Low index + slow decay =
 *  bell/glass; high index + fast decay = wooden knock; ratio sets inharmonicity. */
function fmHit(
  ac: AudioContext,
  out: GainNode,
  send: GainNode,
  t0: number,
  o: {
    carrier: number;
    ratio: number; // modulator = carrier * ratio (non-integer → inharmonic)
    index: number; // modulation depth, in units of carrier freq
    iDecay: number; // how fast the brightness dies (s)
    dur: number;
    peak: number;
    sendAmt?: number;
    pan?: number;
    attack?: number;
  },
): void {
  const car = ac.createOscillator();
  car.type = 'sine';
  car.frequency.value = o.carrier;
  const mod = ac.createOscillator();
  mod.type = 'sine';
  mod.frequency.value = o.carrier * o.ratio;
  const mg = ac.createGain();
  mg.gain.setValueAtTime(o.index * o.carrier, t0);
  mg.gain.exponentialRampToValueAtTime(0.001, t0 + Math.max(0.005, o.iDecay));
  mod.connect(mg);
  mg.connect(car.frequency);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(o.peak, t0 + (o.attack ?? 0.003));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
  const p = ac.createStereoPanner();
  p.pan.value = o.pan ?? 0;
  car.connect(g);
  g.connect(p);
  p.connect(out);
  if (o.sendAmt) {
    const sg = ac.createGain();
    sg.gain.value = o.sendAmt;
    p.connect(sg);
    sg.connect(send);
  }
  car.start(t0);
  mod.start(t0);
  car.stop(t0 + o.dur + 0.03);
  mod.stop(t0 + o.dur + 0.03);
}

/** Wooden knock: FM strike (bright attack dying instantly into the body pitch)
 *  + a noise transient + a low seat. The dice/pawn material voice. */
function knock(ac: AudioContext, out: GainNode, send: GainNode, t0: number, level: number, pan: number, body = 210): void {
  fmHit(ac, out, send, t0, { carrier: body, ratio: 3.83, index: 6, iDecay: 0.012, dur: 0.11, peak: 0.2 * level, sendAmt: 0.55, pan });
  tick(ac, out, send, t0, { freq: 2400, q: 1.1, dur: 0.02, peak: 0.28 * level, pan, sendAmt: 0.6 });
  mode(ac, out, send, t0, body * 0.55, 0.12, 0.14 * level, 'sine', 0.5);
}

/** One Peltola-style hand clap: a short enveloped noise burst exciting two
 *  parallel resonators (the palm air-cavity ~1 kHz + a brighter skin partial). */
function clap1(ac: AudioContext, out: GainNode, send: GainNode, t0: number, f: number, peak: number, pan: number): void {
  const dur = 0.028;
  const n = Math.max(1, Math.floor(ac.sampleRate * dur));
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-9 * (i / n));
  const src = ac.createBufferSource();
  src.buffer = buf;
  const bp1 = ac.createBiquadFilter();
  bp1.type = 'bandpass';
  bp1.frequency.value = f;
  bp1.Q.value = 2.1;
  const bp2 = ac.createBiquadFilter();
  bp2.type = 'bandpass';
  bp2.frequency.value = f * 2.3;
  bp2.Q.value = 1.4;
  const g1 = ac.createGain();
  g1.gain.value = peak;
  const g2 = ac.createGain();
  g2.gain.value = peak * 0.45;
  const p = ac.createStereoPanner();
  p.pan.value = pan;
  src.connect(bp1);
  src.connect(bp2);
  bp1.connect(g1);
  bp2.connect(g2);
  g1.connect(p);
  g2.connect(p);
  p.connect(out);
  const sg = ac.createGain();
  sg.gain.value = 0.7;
  p.connect(sg);
  sg.connect(send);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

/** Applause: two alternating "clappers" with humanised timing, level and
 *  cavity pitch — reads as real clapping, not rhythm-machine claps. */
function applause(ac: AudioContext, out: GainNode, send: GainNode, t0: number, claps: number, span: number): void {
  for (let i = 0; i < claps; i++) {
    const clapper = i % 2;
    const at = (i / claps) * span + (Math.random() - 0.5) * 0.024;
    const f = (clapper ? 1050 : 1400) * (0.94 + Math.random() * 0.14);
    const lvl = 0.12 * (0.75 + Math.random() * 0.45) * (i === claps - 1 ? 0.7 : 1);
    clap1(ac, out, send, t0 + Math.max(0, at), f, lvl, clapper ? -0.32 : 0.32);
  }
}

/** Karplus-Strong plucked string, rendered OFFLINE into a buffer. (A live
 *  DelayNode feedback loop is forced to ≥128 samples of latency by Web Audio,
 *  which detunes any string above ~350 Hz — so we simulate the ring buffer in
 *  JS: exact pitch, natural decay, zero graph cleanup.) The 🍀 harp voice. */
function pluck(ac: AudioContext, out: GainNode, send: GainNode, t0: number, freq: number, dur: number, peak: number, sendAmt = 0.8): void {
  const sr = ac.sampleRate;
  const n = Math.floor(sr * dur);
  const period = Math.max(2, Math.round(sr / freq));
  const ring = new Float32Array(period);
  for (let i = 0; i < period; i++) ring[i] = Math.random() * 2 - 1; // the pluck
  const buf = ac.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const cur = ring[idx]!;
    const nxt = ring[(idx + 1) % period]!;
    ring[idx] = 0.5 * (cur + nxt) * 0.995; // lowpass + damping = string decay
    d[i] = cur * (1 - i / n); // linear fade guards the tail
    idx = (idx + 1) % period;
  }
  const src = ac.createBufferSource();
  src.buffer = buf;
  const g = ac.createGain();
  g.gain.value = peak;
  src.connect(g);
  g.connect(out);
  const sg = ac.createGain();
  sg.gain.value = sendAmt;
  g.connect(sg);
  sg.connect(send);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

/** Formant vocal synth: a glottal-rich sawtooth (with vibrato + breath noise)
 *  through parallel formant resonators, gated by syllable envelopes. This is
 *  what makes 😂/😮/😢 sound like a VOICE and not an oscillator. */
function voice(
  ac: AudioContext,
  out: GainNode,
  send: GainNode,
  t0: number,
  o: {
    f0: Array<[number, number]>; // [timeOffset, hz] — linear pitch contour
    formants: Array<[number, number, number]>; // [hz, Q, gain]
    syll: Array<{ at: number; dur: number; amp: number }>;
    breath?: number;
    vib?: { rate: number; depth: number };
    sendAmt?: number;
    pan?: number;
  },
): void {
  const total = Math.max(...o.syll.map((s) => s.at + s.dur)) + 0.08;
  const src = ac.createOscillator();
  src.type = 'sawtooth';
  const first = o.f0[0];
  src.frequency.setValueAtTime(first ? first[1] : 220, t0);
  for (const [at, hz] of o.f0.slice(1)) src.frequency.linearRampToValueAtTime(hz, t0 + at);
  let lfo: OscillatorNode | null = null;
  if (o.vib) {
    lfo = ac.createOscillator();
    lfo.frequency.value = o.vib.rate;
    const lg = ac.createGain();
    lg.gain.value = o.vib.depth;
    lfo.connect(lg);
    lg.connect(src.frequency);
    lfo.start(t0);
    lfo.stop(t0 + total);
  }
  const input = ac.createGain();
  input.gain.value = 1;
  src.connect(input);
  if (o.breath) {
    const n = Math.floor(ac.sampleRate * total);
    const nb = ac.createBuffer(1, n, ac.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < n; i++) nd[i] = (Math.random() * 2 - 1) * o.breath!;
    const ns = ac.createBufferSource();
    ns.buffer = nb;
    ns.connect(input);
    ns.start(t0);
    ns.stop(t0 + total);
  }
  const env = ac.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  for (const s of o.syll) {
    env.gain.setValueAtTime(0.0001, t0 + s.at);
    env.gain.exponentialRampToValueAtTime(s.amp, t0 + s.at + 0.018);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + s.at + s.dur);
  }
  for (const [hz, q, g] of o.formants) {
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = hz;
    bp.Q.value = q;
    const fg = ac.createGain();
    fg.gain.value = g;
    input.connect(bp);
    bp.connect(fg);
    fg.connect(env);
  }
  const p = ac.createStereoPanner();
  p.pan.value = o.pan ?? 0;
  env.connect(p);
  p.connect(out);
  const sg = ac.createGain();
  sg.gain.value = o.sendAmt ?? 0.5;
  p.connect(sg);
  sg.connect(send);
  src.start(t0);
  src.stop(t0 + total);
}

/** Scattered glass micro-hits — confetti, fairy dust, debris. */
function shimmer(ac: AudioContext, out: GainNode, send: GainNode, t0: number, count: number, from: number, span: number): void {
  for (let i = 0; i < count; i++) {
    const at = from + Math.random() * span;
    fmHit(ac, out, send, t0 + at, {
      carrier: 2200 + Math.random() * 2800,
      ratio: 5.07,
      index: 1.4,
      iDecay: 0.015,
      dur: 0.12,
      peak: 0.028 + Math.random() * 0.022,
      sendAmt: 1,
      pan: Math.random() * 1.2 - 0.6,
    });
  }
}

/** Deep detonation: a sub drop + saturated low noise — the 🤯 payload. */
function boom(ac: AudioContext, out: GainNode, send: GainNode, t0: number, level: number): void {
  gliss(ac, out, send, t0, 88, 38, 0.4, 0.2 * level, 'sine', 0.4, 0, 0.006);
  whoosh(ac, out, send, t0, 700, 120, 0.3, 0.16 * level, 0.7, 0.8);
  tick(ac, out, send, t0, { freq: 1400, q: 0.8, dur: 0.05, peak: 0.18 * level, pan: 0, sendAmt: 0.8 });
}

/* ------------------------------------------------------------ public sounds */

/** Set when the audio logo fires so PLAY doesn't stack a second sting on it. */
let lastLogoAt = 0;

/**
 * Audio logo (app open): browsers block sound before the first user gesture, so
 * this fires on the FIRST pointerdown of the session — sub bloom, a three-note
 * FM-bell motif (the "Lu-do!" signature), air, shimmer. ~1.1 s, calm, ownable.
 */
export function playWelcome(): void {
  play((ac, now) => {
    lastLogoAt = Date.now();
    const { out, send } = bus(ac);
    gliss(ac, out, send, now, 52, 66, 0.55, 0.11, 'sine', 0.4, 0, 0.12); // sub bloom
    mode(ac, out, send, now, 130.81, 0.9, 0.06, 'sine', 0.6); // C3 root bed
    whoosh(ac, out, send, now, 300, 2600, 0.5, 0.04, 1.1, 0.9); // air lift
    const motif: Array<[number, number, number]> = [
      [523.25, 0, 0.8], // C5
      [783.99, 0.16, 0.8], // G5
      [1046.5, 0.32, 1.1], // C6 — lands and rings
    ];
    for (const [f, at, dur] of motif) {
      fmHit(ac, out, send, now + at, { carrier: f, ratio: 3.51, index: 2.1, iDecay: 0.28, dur, peak: 0.12, sendAmt: 0.85, attack: 0.004 });
    }
    shimmer(ac, out, send, now, 5, 0.45, 0.4);
  });
}

/** Match-start sting (the PLAY tap). Skips itself if the audio logo just fired
 *  on the same gesture — one statement at a time. */
export function playStart(): void {
  if (Date.now() - lastLogoAt < 900) return;
  play((ac, now) => {
    const { out, send } = bus(ac);
    whoosh(ac, out, send, now, 400, 2400, 0.32, 0.04, 1.1, 0.8);
    [523.25, 659.25, 783.99].forEach((f, i) =>
      fmHit(ac, out, send, now + i * 0.06, { carrier: f, ratio: 3.51, index: 1.9, iDecay: 0.2, dur: 0.45, peak: 0.1, sendAmt: 0.7 }),
    );
    mode(ac, out, send, now, 130.81, 0.4, 0.08, 'sine', 0.5);
  });
}

/**
 * Dice roll — "two ivory dice on felt": a brief granular shake, two physically
 * decaying FM-knock bounces, and a felt settle. Tight (~0.55 s), weighty,
 * stereo-detailed; restraint IS the premium trait.
 */
export function playDice(): void {
  play((ac, now) => {
    const { out, send } = bus(ac);
    // shake: sparse knock-grains, not a wash of noise
    for (let i = 0; i < 6; i++) {
      const at = i * 0.034 + Math.random() * 0.01;
      fmHit(ac, out, send, now + at, {
        carrier: 620 + Math.random() * 420,
        ratio: 2.9,
        index: 3.2,
        iDecay: 0.008,
        dur: 0.04,
        peak: 0.05 + 0.012 * i,
        pan: (i % 2 ? 1 : -1) * (0.25 + Math.random() * 0.3),
        sendAmt: 0.3,
      });
    }
    // bounce: energy dies physically — level, spacing and body all decay
    knock(ac, out, send, now + 0.24, 0.95, -0.18, 212);
    knock(ac, out, send, now + 0.36, 0.6, 0.14, 188);
    knock(ac, out, send, now + 0.44, 0.34, -0.04, 232);
    // settle on the felt
    mode(ac, out, send, now + 0.5, 94, 0.13, 0.11, 'sine', 0.5);
    tick(ac, out, send, now + 0.5, { freq: 760, q: 0.7, dur: 0.045, peak: 0.06, pan: 0, sendAmt: 0.5 });
  });
}

let lastHop = 0;
let hopFlip = false;

/** Pawn step — a soft felt tap, pitch-humanised and micro-panned so a 6-cell
 *  walk reads as footsteps, not a repeated sample. Never fatiguing. */
export function playHop(): void {
  play((ac, now) => {
    if (now - lastHop < 0.06) return; // fast re-renders never stack
    lastHop = now;
    hopFlip = !hopFlip;
    const vary = 0.96 + Math.random() * 0.08;
    fmHit(ac, out(ac), sendOf(ac), now, {
      carrier: 1900 * vary,
      ratio: 2.02,
      index: 1.6,
      iDecay: 0.007,
      dur: 0.045,
      peak: 0.07,
      pan: hopFlip ? 0.12 : -0.12,
      sendAmt: 0.25,
    });
    mode(ac, out(ac), sendOf(ac), now, 310 * vary, 0.05, 0.05, 'sine', 0.2);
  });
}
// tiny accessors so hop stays terse
function out(ac: AudioContext): GainNode {
  return bus(ac).out;
}
function sendOf(ac: AudioContext): GainNode {
  return bus(ac).send;
}

/**
 * Capture — strike & banish: a deep wooden strike, a dark downward whoosh and a
 * sub drop as the token is knocked home. Punchy, classy, ~0.45 s.
 */
export function playCapture(): void {
  play((ac, now) => {
    const { out, send } = bus(ac);
    knock(ac, out, send, now, 1.25, 0, 132);
    whoosh(ac, out, send, now + 0.03, 2200, 280, 0.28, 0.12, 1.2, 0.7);
    whoosh(ac, out, send, now + 0.08, 480, 130, 0.24, 0.09, 0.8, 0.8); // dark poof
    gliss(ac, out, send, now + 0.02, 92, 46, 0.3, 0.12, 'sine', 0.4, 0, 0.01); // sub
  });
}

/** Win: an FM-bell fanfare over a warm root, with a shimmer tail. */
export function playWin(): void {
  play((ac, now) => {
    const { out, send } = bus(ac);
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    notes.forEach((f, i) => {
      fmHit(ac, out, send, now + i * 0.11, { carrier: f, ratio: 3.51, index: 2.1, iDecay: 0.3, dur: 0.7, peak: 0.13, sendAmt: 0.85 });
    });
    mode(ac, out, send, now, 130.81, 0.8, 0.14, 'sine', 0.6); // C3 root
    shimmer(ac, out, send, now, 6, 0.35, 0.45);
  });
}

/** Loss: a soft, brief descending cue of commiseration (never harsh). */
export function playLose(): void {
  play((ac, now) => {
    const { out, send } = bus(ac);
    mode(ac, out, send, now, 330, 0.4, 0.1, 'sine', 0.6);
    mode(ac, out, send, now + 0.14, 247, 0.5, 0.09, 'sine', 0.7); // minor drop
  });
}

/**
 * Payout count-up: glass FM coins climbing with the number, landing on a chime.
 * Call once as the end-screen amount counts up.
 */
export function playPayout(steps = 10): void {
  play((ac, now) => {
    const { out, send } = bus(ac);
    const n = Math.max(3, Math.min(16, steps));
    for (let i = 0; i < n; i++) {
      const t0 = now + i * 0.05;
      fmHit(ac, out, send, t0, {
        carrier: 1500 + (i / n) * 1700,
        ratio: 5.07,
        index: 1.3,
        iDecay: 0.012,
        dur: 0.07,
        peak: 0.06,
        pan: (Math.random() * 2 - 1) * 0.35,
        sendAmt: 0.5,
      });
    }
    const end = now + n * 0.05;
    fmHit(ac, out, send, end, { carrier: 1046.5, ratio: 3.51, index: 1.8, iDecay: 0.25, dur: 0.55, peak: 0.12, sendAmt: 0.9 });
  });
}

/** UI tap: a single glassy FM micro-tick — 50 ms, quiet, pitch-jittered. */
export function playTap(kind: 'tap' | 'select' = 'tap'): void {
  play((ac, now) => {
    const { out, send } = bus(ac);
    const base = kind === 'select' ? 1650 : 1300;
    fmHit(ac, out, send, now, {
      carrier: base * (1 + (Math.random() * 2 - 1) * 0.03),
      ratio: 5.07,
      index: 1.1,
      iDecay: 0.01,
      dur: 0.05,
      peak: kind === 'select' ? 0.07 : 0.05,
      sendAmt: 0.25,
    });
  });
}

/**
 * Emote signatures — each emoji translated LITERALLY into sound:
 * 👏 is real (granular) applause, 😂 is a synthesized chuckle, 😎 is a finger
 * snap, 🎉 is a party-popper with confetti, 🍀 is a plucked charm harp…
 * All ≤700 ms, all in the same room as everything else.
 */
export function playEmote(id: string): void {
  play((ac, now) => {
    const { out, send } = bus(ac);
    switch (id) {
      case '👍': { // affirmative: a solid wood "thock" resolving up a fifth
        knock(ac, out, send, now, 0.7, -0.05, 225);
        fmHit(ac, out, send, now + 0.1, { carrier: 659.25, ratio: 3.51, index: 1.8, iDecay: 0.22, dur: 0.4, peak: 0.1, sendAmt: 0.75 });
        break;
      }
      case '😂': { // an actual chuckle: 4 falling "ha" syllables, /a/ formants
        voice(ac, out, send, now, {
          f0: [[0, 300], [0.55, 228]],
          formants: [[820, 9, 1], [1210, 11, 0.45], [2700, 12, 0.2]],
          syll: [
            { at: 0, dur: 0.09, amp: 0.1 },
            { at: 0.13, dur: 0.09, amp: 0.09 },
            { at: 0.26, dur: 0.09, amp: 0.075 },
            { at: 0.4, dur: 0.1, amp: 0.055 },
          ],
          breath: 0.05,
          sendAmt: 0.45,
        });
        break;
      }
      case '🔥': { // ignition: strike, swept flame, low roar, irregular crackle
        tick(ac, out, send, now, { freq: 3200, q: 1.2, dur: 0.03, peak: 0.1, pan: 0, sendAmt: 0.5 });
        whoosh(ac, out, send, now, 260, 3100, 0.3, 0.13, 1.2, 0.7);
        whoosh(ac, out, send, now + 0.05, 230, 120, 0.34, 0.09, 0.7, 0.5); // roar under
        [0.09, 0.14, 0.22, 0.29].forEach((dt, i) =>
          tick(ac, out, send, now + dt, { freq: 2600 + Math.random() * 1600, q: 1.6, dur: 0.02, peak: 0.05 + Math.random() * 0.03, pan: (i % 2) * 0.6 - 0.3, sendAmt: 0.6 }),
        );
        break;
      }
      case '😎': { // cool: a literal finger SNAP over a lazy warm chord swell
        clap1(ac, out, send, now, 2300, 0.16, 0.08); // the snap
        [196, 246.9, 311.1].forEach((f) => gliss(ac, out, send, now + 0.08, f, f, 0.45, 0.045, 'triangle', 0.7, 0, 0.09));
        break;
      }
      case '🎉': { // party-popper: POP → confetti shimmer → falling streamer
        tick(ac, out, send, now, { freq: 1500, q: 0.7, dur: 0.05, peak: 0.22, pan: 0, sendAmt: 0.5 });
        fmHit(ac, out, send, now, { carrier: 92, ratio: 1.4, index: 2.4, iDecay: 0.03, dur: 0.12, peak: 0.12, sendAmt: 0.3 }); // air thump
        shimmer(ac, out, send, now, 9, 0.07, 0.5); // confetti
        gliss(ac, out, send, now + 0.1, 2700, 1150, 0.32, 0.032, 'sine', 0.8, 0.25); // streamer
        break;
      }
      case '👏': { // real applause — Peltola claps, two hands, humanised
        applause(ac, out, send, now, 9, 0.58);
        break;
      }
      case '🤯': { // riser → deep detonation → debris + faint shell-shock ring
        gliss(ac, out, send, now, 130, 1300, 0.28, 0.07, 'sawtooth', 0.4, 0, 0.05);
        whoosh(ac, out, send, now, 500, 3400, 0.28, 0.05, 1.1, 0.7);
        boom(ac, out, send, now + 0.29, 1);
        shimmer(ac, out, send, now, 4, 0.42, 0.3); // debris
        mode(ac, out, send, now + 0.34, 3400, 0.5, 0.022, 'sine', 1); // ring
        break;
      }
      case '😮': { // a vocal "whoa" — one rising, breathy /o→a/ syllable
        voice(ac, out, send, now, {
          f0: [[0, 205], [0.22, 330], [0.45, 285]],
          formants: [[520, 8, 1], [920, 9, 0.55], [2400, 12, 0.14]],
          syll: [{ at: 0, dur: 0.46, amp: 0.1 }],
          breath: 0.06,
          vib: { rate: 5, depth: 5 },
          sendAmt: 0.55,
        });
        break;
      }
      case '😢': { // a falling "aww" with real vibrato + a tear-drop plink
        voice(ac, out, send, now, {
          f0: [[0, 310], [0.5, 212]],
          formants: [[700, 8, 1], [1060, 9, 0.5], [2500, 12, 0.1]],
          syll: [{ at: 0, dur: 0.5, amp: 0.09 }],
          breath: 0.05,
          vib: { rate: 5.5, depth: 11 },
          sendAmt: 0.65,
        });
        gliss(ac, out, send, now + 0.54, 2100, 850, 0.07, 0.06, 'sine', 0.9, 0.15); // plink
        break;
      }
      case '💪': { // muscle: cloth whumph + two deep body punches + strain
        whoosh(ac, out, send, now, 900, 240, 0.15, 0.11, 0.9, 0.4);
        fmHit(ac, out, send, now + 0.02, { carrier: 66, ratio: 1.4, index: 2.6, iDecay: 0.04, dur: 0.18, peak: 0.18, sendAmt: 0.3, pan: -0.1 });
        fmHit(ac, out, send, now + 0.17, { carrier: 60, ratio: 1.4, index: 2.6, iDecay: 0.04, dur: 0.2, peak: 0.2, sendAmt: 0.35, pan: 0.1 });
        gliss(ac, out, send, now + 0.05, 82, 97, 0.26, 0.04, 'sawtooth', 0.3); // strain
        break;
      }
      case '🍀': { // charm: a plucked harp gliss (real strings) + fairy dust
        [783.99, 987.77, 1174.7, 1568].forEach((f, i) => pluck(ac, out, send, now + i * 0.085, f, 0.55, 0.09));
        shimmer(ac, out, send, now, 4, 0.38, 0.32);
        break;
      }
      case '🎲': { // a miniature premium dice throw
        knock(ac, out, send, now, 0.85, -0.15, 208);
        knock(ac, out, send, now + 0.1, 0.55, 0.15, 186);
        mode(ac, out, send, now + 0.17, 96, 0.11, 0.08, 'sine', 0.5);
        break;
      }
      default: // quick-chat: a rounded message-bubble pop
        gliss(ac, out, send, now, 380, 720, 0.07, 0.1, 'sine', 0.4, 0, 0.008);
        fmHit(ac, out, send, now + 0.05, { carrier: 1800, ratio: 5.07, index: 1, iDecay: 0.01, dur: 0.05, peak: 0.035, sendAmt: 0.6 });
    }
  });
}
