/**
 * Subtle sound effects (E6.2), synthesised with Web Audio — zero asset bytes.
 * Opt-out is persisted; playback is a no-op when disabled or unsupported.
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

/* --------------------------------------------------------------------------
 * Premium dice roll — fully procedural (zero assets). Physical model:
 *   1) shake   : filtered noise ticks, stereo-scattered, accelerando→settle
 *   2) bounce  : 3 impacts, intervals shorten + energy decays (real physics),
 *                each = a noise transient + the die's resonant body modes
 *   3) settle  : low woody thud + short body resonance
 * Everything runs through a shared compressor bus and a generated-IR room
 * reverb for polish. iOS-Safari-safe nodes only.
 * ------------------------------------------------------------------------ */

let master: GainNode | null = null;
let reverbSend: GainNode | null = null;

/**
 * Lazily build (once) the master bus + a shared feedback-delay room reverb.
 * A short lowpassed comb network (deterministic, cheap, ~0.4s tail) gives a
 * subtle premium "table in a room" space — predictable across browsers, unlike
 * a normalize-dependent convolver. Returns the dry out + the reverb send.
 */
function bus(ac: AudioContext): { out: GainNode; send: GainNode } {
  if (!master || !reverbSend) {
    master = ac.createGain();
    master.gain.value = 0.5; // headroom: never clip or startle
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 20;
    comp.ratio.value = 3;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    master.connect(comp);
    comp.connect(ac.destination);

    reverbSend = ac.createGain();
    reverbSend.gain.value = 1;
    // three stereo-spread lowpassed feedback combs
    const combs: Array<[number, number]> = [
      [0.0191, -0.5],
      [0.0273, 0.35],
      [0.0356, 0.5],
    ];
    for (const [dt, pan] of combs) {
      const dl = ac.createDelay(0.1);
      dl.delayTime.value = dt;
      const fb = ac.createGain();
      fb.gain.value = 0.6;
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3200;
      const wet = ac.createGain();
      wet.gain.value = 0.32;
      const p = ac.createStereoPanner();
      p.pan.value = pan;
      reverbSend.connect(dl);
      dl.connect(lp);
      lp.connect(fb);
      fb.connect(dl); // feedback loop
      lp.connect(wet);
      wet.connect(p);
      p.connect(master);
    }
  }
  return { out: master, send: reverbSend };
}

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

/** Fast-decaying resonant partial — a material body mode of the die or board. */
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

/** Sustained bandpass-noise rattle bed (glues the loose grains into a shake). */
function rattleBed(ac: AudioContext, out: GainNode, send: GainNode, t0: number, dur: number, peak: number): void {
  const n = Math.max(1, Math.floor(ac.sampleRate * dur));
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const env = Math.sin(Math.PI * t); // rise then fall
    const wobble = 0.6 + 0.4 * Math.sin(t * 62); // granular tremolo
    d[i] = (Math.random() * 2 - 1) * env * wobble;
  }
  const src = ac.createBufferSource();
  src.buffer = buf;
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2100;
  bp.Q.value = 0.8;
  const g = ac.createGain();
  g.gain.value = peak;
  src.connect(bp);
  bp.connect(g);
  g.connect(out);
  const s = ac.createGain();
  s.gain.value = 0.3;
  g.connect(s);
  s.connect(send);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

/** A die/board impact: sharp filtered transient + two decaying body modes. */
function impact(
  ac: AudioContext,
  out: GainNode,
  send: GainNode,
  t0: number,
  level: number,
  pan: number,
  bodyLow: number,
  bodyHi: number,
): void {
  tick(ac, out, send, t0, { freq: 2600, q: 1.1, dur: 0.03, peak: 0.6 * level, pan, sendAmt: 0.75 });
  mode(ac, out, send, t0, bodyHi, 0.09, 0.26 * level, 'triangle', 0.55);
  mode(ac, out, send, t0, bodyLow, 0.13, 0.3 * level, 'sine', 0.7);
}

/** Dice roll: premium rattle → physically-decaying bounce → woody settle. */
export function playDice(): void {
  play((ac, now) => {
    const { out, send } = bus(ac);

    // 1) shake — a sustained rattle bed with dense filtered grains scattered over it
    rattleBed(ac, out, send, now, 0.26, 0.13);
    const grains = 12;
    for (let i = 0; i < grains; i++) {
      const prog = i / (grains - 1);
      const dt = prog * 0.24 + Math.random() * 0.012;
      tick(ac, out, send, now + dt, {
        freq: 1600 + Math.random() * 1600,
        q: 1.6,
        dur: 0.022,
        peak: 0.16 * (0.7 + 0.3 * Math.sin(Math.PI * prog)),
        pan: (Math.random() * 2 - 1) * 0.7,
      });
    }

    // 2) bounce — the first board contact is loudest; intervals shorten, energy decays
    const bounces = [0.29, 0.4, 0.48];
    const levels = [1, 0.58, 0.32];
    const pans = [-0.28, 0.18, 0];
    bounces.forEach((dt, i) => {
      impact(ac, out, send, now + dt, levels[i]!, pans[i]!, 182 - i * 16, 1500 + i * 130);
    });

    // 3) settle — a restrained low woody thud (kept under the first impact) + a click,
    //    the reverb tail carries the premium space after everything decays
    mode(ac, out, send, now + 0.5, 116, 0.2, 0.24, 'sine', 0.6);
    tick(ac, out, send, now + 0.5, { freq: 820, q: 2.2, dur: 0.05, peak: 0.13, pan: 0, sendAmt: 0.8 });
  });
}

/** Pawn hop: a soft wooden tap per cell — quiet, plays on every step. */
let lastHop = 0;
export function playHop(): void {
  play((ac, now) => {
    // throttle: never stack hops closer than 60ms (fast re-renders)
    if (now - lastHop < 0.06) return;
    lastHop = now;
    const { out, send } = bus(ac);
    tick(ac, out, send, now, { freq: 1750, q: 2.2, dur: 0.028, peak: 0.14, pan: 0, sendAmt: 0.3 });
    mode(ac, out, send, now, 260, 0.06, 0.1, 'sine', 0.25);
  });
}

/**
 * Capture: a satisfying "thwack" that routes through the SAME premium bus +
 * reverb as the dice (the old two-tone bypassed both → cheap 80s blip). A hard
 * noise transient + a resonant body + a quick pitched-down whoosh "removal".
 */
export function playCapture(): void {
  play((ac, now) => {
    const { out, send } = bus(ac);
    // impact: sharp hit + two body modes (reuses the die's material primitives)
    impact(ac, out, send, now, 1.1, 0, 150, 900);
    // a short downward "swipe" as the captured token is knocked home
    const o = ac.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(560, now);
    o.frequency.exponentialRampToValueAtTime(150, now + 0.16);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.14, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    o.connect(lp);
    lp.connect(g);
    g.connect(out);
    const s = ac.createGain();
    s.gain.value = 0.4;
    g.connect(s);
    s.connect(send);
    o.start(now);
    o.stop(now + 0.2);
  });
}

/**
 * Win: a warm consonant fanfare (root–3rd–5th–octave) with a bass root and a
 * reverb tail — routed through the bus so it sits in the same premium space as
 * the rest, not the old dry sine arpeggio.
 */
export function playWin(): void {
  play((ac, now) => {
    const { out, send } = bus(ac);
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    notes.forEach((f, i) => {
      mode(ac, out, send, now + i * 0.11, f, 0.5, 0.16, 'triangle', 0.6);
      mode(ac, out, send, now + i * 0.11, f * 2, 0.3, 0.05, 'sine', 0.4); // shimmer
    });
    mode(ac, out, send, now, 130.81, 0.7, 0.22, 'sine', 0.5); // C3 bass root
    // sparkle tail
    tick(ac, out, send, now + 0.34, { freq: 5200, q: 1.4, dur: 0.06, peak: 0.1, pan: 0.2, sendAmt: 1 });
  });
}

/** Loss: a soft, brief descending cue of commiseration (never harsh). */
export function playLose(): void {
  play((ac, now) => {
    const { out, send } = bus(ac);
    mode(ac, out, send, now, 330, 0.4, 0.12, 'sine', 0.5);
    mode(ac, out, send, now + 0.14, 247, 0.5, 0.12, 'sine', 0.5); // minor drop
  });
}

/**
 * Payout count-up (the #1 money moment, previously silent): a rising cascade of
 * coin ticks pitched up over `steps`, ending on a bright chime. Call once as the
 * end-screen number counts up.
 */
export function playPayout(steps = 10): void {
  play((ac, now) => {
    const { out, send } = bus(ac);
    const n = Math.max(3, Math.min(16, steps));
    for (let i = 0; i < n; i++) {
      const t0 = now + i * 0.05;
      const freq = 1400 + (i / n) * 1600; // climbs as the total rises
      tick(ac, out, send, t0, { freq, q: 2.4, dur: 0.03, peak: 0.11, pan: (Math.random() * 2 - 1) * 0.4, sendAmt: 0.5 });
      mode(ac, out, send, t0, freq * 0.5, 0.05, 0.06, 'sine', 0.3);
    }
    // landing chime
    const end = now + n * 0.05;
    mode(ac, out, send, end, 1046.5, 0.5, 0.16, 'triangle', 0.7);
    mode(ac, out, send, end, 1567.98, 0.5, 0.09, 'sine', 0.7);
  });
}

/** Soft UI tap for CTAs/selection — tiny, pitch-jittered to avoid fatigue. */
export function playTap(kind: 'tap' | 'select' = 'tap'): void {
  play((ac, now) => {
    const { out, send } = bus(ac);
    const base = kind === 'select' ? 880 : 660;
    const freq = base * (1 + (Math.random() * 2 - 1) * 0.04); // ±~1 semitone jitter
    mode(ac, out, send, now, freq, 0.07, kind === 'select' ? 0.12 : 0.08, 'triangle', 0.25);
    tick(ac, out, send, now, { freq: 3200, q: 2, dur: 0.02, peak: 0.05, pan: 0, sendAmt: 0.2 });
  });
}

/* --------------------------------------------------------------------------
 * Premium expressive layer (E-social): pitch-glide + swept-noise helpers, a
 * match-start sting, and a UNIQUE layered signature per emote. Everything runs
 * through the same compressor bus + room reverb as the dice, so the whole app
 * speaks with one acoustic voice.
 * ------------------------------------------------------------------------ */

/** Pitch-glide oscillator with an attack/decay envelope — risers, horns, sighs. */
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

/**
 * Match-start sting (the landing PLAY): a warm low root, a rising major
 * arpeggio into the reverb, an air whoosh underneath and a sparkle on top —
 * short (~0.6 s), optimistic, premium. Fired on the tap, so it doubles as the
 * user gesture that unlocks the AudioContext.
 */
export function playStart(): void {
  play((ac, now) => {
    const { out, send } = bus(ac);
    mode(ac, out, send, now, 130.81, 0.55, 0.16, 'sine', 0.5); // C3 warm root
    whoosh(ac, out, send, now, 400, 2400, 0.4, 0.05, 1.1, 0.8); // air lift
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      mode(ac, out, send, now + 0.05 + i * 0.07, f, 0.3, 0.11, 'triangle', 0.65);
      mode(ac, out, send, now + 0.05 + i * 0.07, f * 2, 0.16, 0.035, 'sine', 0.5); // shimmer double
    });
    tick(ac, out, send, now + 0.36, { freq: 5600, q: 1.3, dur: 0.06, peak: 0.08, pan: 0.15, sendAmt: 1 });
  });
}

/**
 * Per-emote signature (E-social): each emote is a small, layered sound-design
 * moment — glides, swept noise, body impacts and shimmer — so every reaction is
 * recognisable with your eyes closed. All ≤700 ms, all on the premium bus.
 */
export function playEmote(id: string): void {
  play((ac, now) => {
    const { out, send } = bus(ac);
    switch (id) {
      case '👍': { // approval stamp: woody double-hit landing on a confident fifth
        impact(ac, out, send, now, 0.5, -0.1, 180, 540);
        mode(ac, out, send, now + 0.09, 392, 0.14, 0.12, 'triangle', 0.4);
        mode(ac, out, send, now + 0.18, 588, 0.22, 0.13, 'triangle', 0.6);
        tick(ac, out, send, now + 0.3, { freq: 4800, q: 1.4, dur: 0.05, peak: 0.06, pan: 0.2, sendAmt: 0.9 });
        break;
      }
      case '😂': { // giggle: bouncing staccato that climbs, ends on a hiccup
        const gig = [1318.5, 1046.5, 1396.9, 1174.7, 1568, 1318.5];
        gig.forEach((f, i) =>
          mode(ac, out, send, now + i * 0.065, f, 0.05, 0.085, 'square', 0.3),
        );
        gliss(ac, out, send, now + 0.42, 900, 1500, 0.09, 0.07, 'sine', 0.5, 0.25); // hiccup
        break;
      }
      case '🔥': { // ignite: a real whoosh + crackle + sub swell
        whoosh(ac, out, send, now, 300, 3200, 0.32, 0.14, 1.2, 0.7);
        gliss(ac, out, send, now, 55, 95, 0.3, 0.1, 'sine', 0.3, 0, 0.08); // sub bloom
        [0.1, 0.17, 0.25].forEach((dt, i) =>
          tick(ac, out, send, now + dt, { freq: 3000 + i * 900, q: 1.6, dur: 0.025, peak: 0.08, pan: (i % 2) * 0.5 - 0.25, sendAmt: 0.6 }),
        );
        break;
      }
      case '😎': { // cool: a lazy, tape-warm Maj7 stab — twice, softer the second time
        const chord = [196, 246.9, 311.1, 370];
        chord.forEach((f, i) => mode(ac, out, send, now + i * 0.015, f, 0.3, 0.075, 'triangle', 0.55));
        tick(ac, out, send, now, { freq: 1800, q: 0.9, dur: 0.03, peak: 0.05, pan: -0.2, sendAmt: 0.4 }); // brush
        chord.forEach((f, i) => mode(ac, out, send, now + 0.22 + i * 0.015, f * 1.002, 0.34, 0.05, 'triangle', 0.7));
        break;
      }
      case '🎉': { // party: horn gliss + cork pop + sparkle rain
        gliss(ac, out, send, now, 294, 587, 0.18, 0.11, 'sawtooth', 0.5, -0.15);
        tick(ac, out, send, now + 0.16, { freq: 2200, q: 1, dur: 0.035, peak: 0.14, pan: 0.1, sendAmt: 0.6 }); // pop
        [1046.5, 1318.5, 1568, 2093].forEach((f, i) =>
          mode(ac, out, send, now + 0.2 + i * 0.05, f, 0.22, 0.07, 'sine', 0.9),
        );
        break;
      }
      case '👏': { // applause: humanised bandpass claps, alternating pan
        [0, 0.09, 0.19, 0.31].forEach((dt, i) =>
          tick(ac, out, send, now + dt, {
            freq: 1500 + (i % 2) * 350 + i * 60,
            q: 0.85,
            dur: 0.045,
            peak: i === 3 ? 0.09 : 0.13,
            pan: (i % 2) * 0.7 - 0.35,
            sendAmt: 0.7,
          }),
        );
        break;
      }
      case '🤯': { // mind blown: riser → detonation → falling debris
        gliss(ac, out, send, now, 140, 1400, 0.26, 0.09, 'sawtooth', 0.4, 0, 0.05);
        impact(ac, out, send, now + 0.27, 1.2, 0, 65, 240);
        whoosh(ac, out, send, now + 0.27, 3000, 500, 0.28, 0.1, 1, 0.9);
        tick(ac, out, send, now + 0.4, { freq: 5200, q: 1.2, dur: 0.06, peak: 0.06, pan: -0.3, sendAmt: 1 });
        tick(ac, out, send, now + 0.5, { freq: 4200, q: 1.2, dur: 0.06, peak: 0.05, pan: 0.3, sendAmt: 1 });
        break;
      }
      case '😮': { // whoa: two detuned voices rising together over a breath
        gliss(ac, out, send, now, 330, 660, 0.3, 0.08, 'sine', 0.6, -0.08, 0.06);
        gliss(ac, out, send, now, 334, 668, 0.3, 0.07, 'sine', 0.6, 0.08, 0.06);
        whoosh(ac, out, send, now, 700, 1600, 0.26, 0.03, 1.4, 0.8); // breath
        break;
      }
      case '😢': { // sad: two overlapping falling sighs + a tear-drop plink
        gliss(ac, out, send, now, 440, 330, 0.34, 0.08, 'sine', 0.7, -0.05, 0.05);
        gliss(ac, out, send, now + 0.08, 415, 311, 0.34, 0.06, 'sine', 0.7, 0.05, 0.05);
        gliss(ac, out, send, now + 0.42, 1900, 600, 0.07, 0.07, 'sine', 0.9, 0.15); // drop
        break;
      }
      case '💪': { // power: two deep body punches under a rising power-fifth
        impact(ac, out, send, now, 0.9, -0.2, 80, 220);
        impact(ac, out, send, now + 0.14, 1.1, 0.2, 72, 205);
        gliss(ac, out, send, now + 0.05, 110, 123.5, 0.22, 0.06, 'sawtooth', 0.35);
        gliss(ac, out, send, now + 0.05, 165, 185, 0.22, 0.05, 'sawtooth', 0.35);
        break;
      }
      case '🍀': { // charm: a music-box arpeggio with octave shimmer + fairy dust
        [784, 988, 1175, 1568].forEach((f, i) => {
          mode(ac, out, send, now + i * 0.075, f, 0.26, 0.085, 'sine', 0.85);
          mode(ac, out, send, now + i * 0.075, f * 2, 0.14, 0.03, 'sine', 0.9);
        });
        tick(ac, out, send, now + 0.34, { freq: 6200, q: 1.2, dur: 0.06, peak: 0.06, pan: 0.2, sendAmt: 1 });
        break;
      }
      case '🎲': { // dice: two premium body clacks + a woody table settle
        impact(ac, out, send, now, 0.8, -0.15, 150, 900);
        impact(ac, out, send, now + 0.1, 0.6, 0.2, 132, 760);
        mode(ac, out, send, now + 0.18, 220, 0.12, 0.08, 'sine', 0.5);
        break;
      }
      default: // quick-chat bubble: a soft, rounded double pop
        mode(ac, out, send, now, 587, 0.08, 0.09, 'triangle', 0.35);
        mode(ac, out, send, now + 0.09, 784, 0.1, 0.08, 'triangle', 0.45);
    }
  });
}
