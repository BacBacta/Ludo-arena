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

/**
 * Per-emote signature (E-social): each emote has its own short, charming cue —
 * same premium bus/reverb as everything else, ≤400 ms, never harsh. Quick-chat
 * presets (non-emoji ids) get a soft speech-bubble double pop.
 */
export function playEmote(id: string): void {
  play((ac, now) => {
    const { out, send } = bus(ac);
    switch (id) {
      case '👍': // approving pop
        mode(ac, out, send, now, 660, 0.09, 0.12, 'triangle', 0.3);
        mode(ac, out, send, now + 0.07, 880, 0.12, 0.1, 'triangle', 0.4);
        break;
      case '😂': { // giggle: two quick staccato pairs
        const g = [1318.5, 1046.5, 1318.5, 1046.5];
        g.forEach((f, i) => mode(ac, out, send, now + i * 0.07, f, 0.05, 0.09, 'square', 0.25));
        break;
      }
      case '😮': { // surprise: rising sweep
        const o = ac.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(320, now);
        o.frequency.exponentialRampToValueAtTime(950, now + 0.22);
        const g = ac.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.12, now + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);
        o.connect(g);
        g.connect(out);
        o.start(now);
        o.stop(now + 0.28);
        break;
      }
      case '😢': // soft minor droop
        mode(ac, out, send, now, 494, 0.22, 0.09, 'sine', 0.5);
        mode(ac, out, send, now + 0.16, 392, 0.3, 0.08, 'sine', 0.6);
        break;
      case '🔥': // blaze: accelerating crackle + low body
        [0, 0.05, 0.09, 0.12].forEach((dt, i) =>
          tick(ac, out, send, now + dt, { freq: 2400 + i * 700, q: 1.6, dur: 0.03, peak: 0.09, pan: (i % 2) * 0.5 - 0.25, sendAmt: 0.5 }),
        );
        mode(ac, out, send, now, 165, 0.28, 0.1, 'sawtooth', 0.4);
        break;
      case '💪': // flex: two low punches
        mode(ac, out, send, now, 180, 0.12, 0.16, 'triangle', 0.3);
        mode(ac, out, send, now + 0.12, 220, 0.16, 0.14, 'triangle', 0.35);
        break;
      case '🍀': // luck: sparkle arpeggio up
        [784, 988, 1175].forEach((f, i) => mode(ac, out, send, now + i * 0.08, f, 0.18, 0.09, 'sine', 0.6));
        tick(ac, out, send, now + 0.26, { freq: 5200, q: 1.4, dur: 0.05, peak: 0.07, pan: 0.2, sendAmt: 1 });
        break;
      case '🎲': // mini dice: two clacks
        tick(ac, out, send, now, { freq: 1900, q: 2.4, dur: 0.03, peak: 0.12, pan: -0.2, sendAmt: 0.4 });
        tick(ac, out, send, now + 0.09, { freq: 1500, q: 2.4, dur: 0.035, peak: 0.1, pan: 0.2, sendAmt: 0.4 });
        break;
      case '🎉': // party: a bright rising sparkle burst
        [523, 659, 784, 1047].forEach((f, i) => mode(ac, out, send, now + i * 0.05, f, 0.14, 0.09, 'triangle', 0.6));
        tick(ac, out, send, now + 0.22, { freq: 6000, q: 1.3, dur: 0.06, peak: 0.09, pan: 0, sendAmt: 1 });
        break;
      case '😎': // cool: a smooth low two-note "yeah"
        mode(ac, out, send, now, 392, 0.16, 0.12, 'sine', 0.4);
        mode(ac, out, send, now + 0.12, 330, 0.22, 0.11, 'sine', 0.5);
        break;
      case '👏': // clap: three quick noise transients
        [0, 0.11, 0.22].forEach((dt, i) =>
          tick(ac, out, send, now + dt, { freq: 2000 - i * 200, q: 1.2, dur: 0.03, peak: 0.13, pan: (i % 2) * 0.4 - 0.2, sendAmt: 0.4 }),
        );
        break;
      case '🤯': // mind-blown: rising sweep into a burst
        {
          const o = ac.createOscillator();
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(200, now);
          o.frequency.exponentialRampToValueAtTime(1200, now + 0.18);
          const g = ac.createGain();
          g.gain.setValueAtTime(0.0001, now);
          g.gain.exponentialRampToValueAtTime(0.1, now + 0.03);
          g.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
          o.connect(g);
          g.connect(out);
          o.start(now);
          o.stop(now + 0.22);
          tick(ac, out, send, now + 0.2, { freq: 4800, q: 1.1, dur: 0.08, peak: 0.11, pan: 0, sendAmt: 1 });
        }
        break;
      default: // quick-chat bubble: soft double pop
        mode(ac, out, send, now, 550, 0.07, 0.09, 'triangle', 0.3);
        mode(ac, out, send, now + 0.08, 720, 0.09, 0.08, 'triangle', 0.35);
    }
  });
}
