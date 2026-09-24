// Tiny WebAudio synthesiser for UI sounds. No audio assets ship: every
// sound is a short recipe of enveloped oscillators and filtered noise.
//
// * Off unless `settings.sounds` is on (`setSoundEnabled`).
// * The AudioContext is created lazily on the first sound and suspended
//   again shortly after the last one ends, so an idle page keeps no audio
//   thread busy (the box's idle CPU must stay ~0).

export type SoundName = 'pop' | 'drop' | 'whoosh' | 'sparkle' | 'error' | 'click' | 'success';

interface VoiceBase {
  /** Start offset in seconds. */
  at: number;
  /** Attack (linear ramp up) in seconds. */
  attack: number;
  /** Exponential decay after the attack, in seconds. */
  decay: number;
  /** Peak gain, 0..1 before the master volume. */
  gain: number;
}

export interface ToneVoice extends VoiceBase {
  kind: 'tone';
  wave: OscillatorType;
  /** Start frequency (Hz). */
  from: number;
  /** Optional glide target (Hz), reached near the end of the decay. */
  to?: number;
}

export interface NoiseVoice extends VoiceBase {
  kind: 'noise';
  filter: BiquadFilterType;
  /** Filter frequency at the start (Hz). */
  from: number;
  /** Optional filter sweep target (Hz). */
  to?: number;
  q: number;
}

export type Voice = ToneVoice | NoiseVoice;

const arpeggio = (notes: number[], step: number, voice: Omit<ToneVoice, 'from' | 'at'>): ToneVoice[] =>
  notes.map((from, i) => ({ ...voice, from, at: i * step }));

/** The sounds, as data (tested for length and loudness). */
export const RECIPES: Record<SoundName, Voice[]> = {
  click: [
    { kind: 'tone', wave: 'sine', from: 1800, to: 1250, at: 0, attack: 0.002, decay: 0.03, gain: 0.22 },
    { kind: 'noise', filter: 'highpass', from: 3200, q: 0.7, at: 0, attack: 0.001, decay: 0.012, gain: 0.08 },
  ],
  pop: [
    { kind: 'tone', wave: 'sine', from: 420, to: 900, at: 0, attack: 0.004, decay: 0.09, gain: 0.42 },
    { kind: 'tone', wave: 'triangle', from: 840, to: 1350, at: 0, attack: 0.004, decay: 0.05, gain: 0.1 },
  ],
  drop: [
    { kind: 'tone', wave: 'sine', from: 620, to: 170, at: 0, attack: 0.003, decay: 0.17, gain: 0.5 },
    { kind: 'noise', filter: 'lowpass', from: 900, q: 0.9, at: 0, attack: 0.002, decay: 0.06, gain: 0.16 },
    { kind: 'tone', wave: 'sine', from: 1320, to: 990, at: 0.02, attack: 0.003, decay: 0.06, gain: 0.06 },
  ],
  whoosh: [
    { kind: 'noise', filter: 'bandpass', from: 380, to: 2600, q: 1.1, at: 0, attack: 0.14, decay: 0.24, gain: 0.5 },
  ],
  sparkle: [
    ...arpeggio([1568, 2093, 2637, 3136], 0.045, { kind: 'tone', wave: 'triangle', attack: 0.003, decay: 0.22, gain: 0.12 }),
    ...arpeggio([784, 1047], 0.09, { kind: 'tone', wave: 'sine', attack: 0.004, decay: 0.3, gain: 0.05 }),
  ],
  error: [
    { kind: 'tone', wave: 'triangle', from: 330, to: 262, at: 0, attack: 0.004, decay: 0.11, gain: 0.34 },
    { kind: 'tone', wave: 'triangle', from: 262, to: 208, at: 0.13, attack: 0.004, decay: 0.16, gain: 0.34 },
  ],
  success: [
    ...arpeggio([523.25, 659.25, 783.99, 1046.5], 0.07, { kind: 'tone', wave: 'sine', attack: 0.005, decay: 0.28, gain: 0.2 }),
    { kind: 'tone', wave: 'triangle', from: 2093, at: 0.21, attack: 0.004, decay: 0.2, gain: 0.04 },
  ],
};

export const SOUND_NAMES = Object.keys(RECIPES) as SoundName[];

/** Seconds from the first voice start to the last voice end. */
export function soundLength(voices: readonly Voice[]): number {
  return Math.max(0, ...voices.map((v) => v.at + v.attack + v.decay));
}

const MASTER_GAIN = 0.35;
/** Suspend the context this long after the last sound finished (ms). */
const IDLE_SUSPEND_MS = 600;

let enabled = false;
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let suspendTimer: ReturnType<typeof setTimeout> | undefined;
let busyUntil = 0;

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  if (!on && ctx && ctx.state === 'running') void ctx.suspend().catch(() => {});
}

export function soundEnabled(): boolean {
  return enabled;
}

function context(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = globalThis.AudioContext;
  if (typeof Ctor !== 'function') return null;
  try {
    ctx = new Ctor({ latencyHint: 'interactive' });
  } catch {
    return null;
  }
  master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(ctx.destination);
  return ctx;
}

function whiteNoise(ac: AudioContext): AudioBuffer {
  if (noiseBuffer) return noiseBuffer;
  const buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * 0.5), ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buffer;
  return buffer;
}

function envelope(ac: AudioContext, v: Voice, t0: number, out: AudioNode): GainNode {
  const g = ac.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(v.gain, t0 + v.attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + v.attack + v.decay);
  g.connect(out);
  return g;
}

function renderVoice(ac: AudioContext, v: Voice, now: number, out: AudioNode): void {
  const t0 = now + v.at;
  const end = t0 + v.attack + v.decay + 0.02;
  const gain = envelope(ac, v, t0, out);
  if (v.kind === 'tone') {
    const osc = ac.createOscillator();
    osc.type = v.wave;
    osc.frequency.setValueAtTime(v.from, t0);
    if (v.to !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(v.to, t0 + v.attack + v.decay * 0.8);
    }
    osc.connect(gain);
    osc.start(t0);
    osc.stop(end);
  } else {
    const src = ac.createBufferSource();
    src.buffer = whiteNoise(ac);
    const filter = ac.createBiquadFilter();
    filter.type = v.filter;
    filter.Q.value = v.q;
    filter.frequency.setValueAtTime(v.from, t0);
    if (v.to !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(v.to, t0 + v.attack + v.decay * 0.8);
    }
    src.connect(filter);
    filter.connect(gain);
    src.start(t0);
    src.stop(end);
  }
}

/** Plays a UI sound (no-op while sounds are off or WebAudio is missing). */
export function play(name: SoundName, opts: { volume?: number } = {}): void {
  if (!enabled) return;
  const ac = context();
  if (!ac || !master) return;
  if (ac.state !== 'running') void ac.resume().catch(() => {});

  const out = ac.createGain();
  out.gain.value = Math.min(1, Math.max(0, opts.volume ?? 1));
  out.connect(master);
  const voices = RECIPES[name];
  // Tiny lead time so a context that is just resuming does not clip the attack.
  const now = ac.currentTime + 0.01;
  for (const v of voices) renderVoice(ac, v, now, out);

  busyUntil = Math.max(busyUntil, performance.now() + (soundLength(voices) + 0.05) * 1000);
  clearTimeout(suspendTimer);
  suspendTimer = setTimeout(
    () => {
      if (performance.now() >= busyUntil && ctx?.state === 'running') void ctx.suspend().catch(() => {});
    },
    Math.max(0, busyUntil - performance.now()) + IDLE_SUSPEND_MS,
  );
}
