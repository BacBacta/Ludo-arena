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

function tone(ac: AudioContext, freq: number, t0: number, dur: number, type: OscillatorType, peak: number): void {
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(g);
  g.connect(ac.destination);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise(ac: AudioContext, t0: number, dur: number, peak: number): void {
  const n = Math.floor(ac.sampleRate * dur);
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n); // decaying white noise
  const src = ac.createBufferSource();
  src.buffer = buf;
  const g = ac.createGain();
  g.gain.value = peak;
  src.connect(g);
  g.connect(ac.destination);
  src.start(t0);
}

function play(build: (ac: AudioContext, now: number) => void): void {
  if (!soundEnabled()) return;
  const ac = audio();
  if (!ac) return;
  build(ac, ac.currentTime);
}

/** Dice roll: two quick noisy rattles. */
export function playDice(): void {
  play((ac, now) => {
    noise(ac, now, 0.08, 0.12);
    noise(ac, now + 0.09, 0.06, 0.09);
  });
}

/** Capture: a short descending two-tone. */
export function playCapture(): void {
  play((ac, now) => {
    tone(ac, 520, now, 0.1, 'triangle', 0.18);
    tone(ac, 320, now + 0.08, 0.14, 'triangle', 0.18);
  });
}

/** Win: a rising major arpeggio. */
export function playWin(): void {
  play((ac, now) => {
    [523, 659, 784, 1047].forEach((f, i) => tone(ac, f, now + i * 0.1, 0.22, 'sine', 0.16));
  });
}
