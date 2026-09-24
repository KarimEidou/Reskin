import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECIPES, SOUND_NAMES, soundLength } from './synth';

/** Minimal AudioContext double that records what gets built. */
class FakeParam {
  value = 0;
  events: string[] = [];
  setValueAtTime(v: number) {
    this.events.push(`set ${v}`);
  }
  linearRampToValueAtTime(v: number) {
    this.events.push(`lin ${v}`);
  }
  exponentialRampToValueAtTime(v: number) {
    if (!(v > 0)) throw new RangeError('exponential ramps need a positive target');
    this.events.push(`exp ${v}`);
  }
}
class FakeNode {
  connected: FakeNode[] = [];
  connect(n: FakeNode) {
    this.connected.push(n);
    return n;
  }
}
class FakeContext {
  static instances: FakeContext[] = [];
  state: 'running' | 'suspended' = 'suspended';
  currentTime = 1;
  sampleRate = 48000;
  destination = new FakeNode();
  oscillators: Array<FakeNode & { type: string; frequency: FakeParam; started: number[] }> = [];
  sources: FakeNode[] = [];
  constructor() {
    FakeContext.instances.push(this);
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  suspend() {
    this.state = 'suspended';
    return Promise.resolve();
  }
  createGain() {
    return Object.assign(new FakeNode(), { gain: new FakeParam() });
  }
  createOscillator() {
    const o = Object.assign(new FakeNode(), {
      type: 'sine',
      frequency: new FakeParam(),
      started: [] as number[],
      start(t: number) {
        o.started.push(t);
      },
      stop() {},
    });
    this.oscillators.push(o);
    return o;
  }
  createBufferSource() {
    const s = Object.assign(new FakeNode(), { buffer: null as unknown, start() {}, stop() {} });
    this.sources.push(s);
    return s;
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(), { type: 'lowpass', Q: new FakeParam(), frequency: new FakeParam() });
  }
  createBuffer(_channels: number, length: number) {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }
}

describe('recipes', () => {
  it('are short and tasteful', () => {
    expect(SOUND_NAMES.sort()).toEqual(['click', 'drop', 'error', 'pop', 'sparkle', 'success', 'whoosh']);
    for (const name of SOUND_NAMES) {
      const voices = RECIPES[name];
      expect(voices.length).toBeGreaterThan(0);
      expect(soundLength(voices)).toBeLessThan(0.6);
      for (const v of voices) {
        expect(v.gain).toBeGreaterThan(0);
        expect(v.gain).toBeLessThanOrEqual(0.5);
        expect(v.from).toBeGreaterThan(20);
        expect(v.from).toBeLessThan(20000);
      }
    }
    expect(soundLength(RECIPES.click)).toBeLessThan(0.05);
  });
});

describe('play', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    FakeContext.instances = [];
    vi.stubGlobal('AudioContext', FakeContext);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does nothing (and creates no context) while sounds are off', async () => {
    const synth = await import('./synth');
    synth.play('pop');
    expect(FakeContext.instances).toHaveLength(0);
    expect(synth.soundEnabled()).toBe(false);
  });

  it('lazily creates one context and renders every voice', async () => {
    const synth = await import('./synth');
    synth.setSoundEnabled(true);
    synth.play('sparkle');
    synth.play('drop');
    expect(FakeContext.instances).toHaveLength(1);
    const ac = FakeContext.instances[0]!;
    expect(ac.state).toBe('running');
    const tones = [...RECIPES.sparkle, ...RECIPES.drop].filter((v) => v.kind === 'tone');
    const noises = RECIPES.drop.filter((v) => v.kind === 'noise');
    expect(ac.oscillators).toHaveLength(tones.length);
    expect(ac.sources).toHaveLength(noises.length);
    // Arpeggio notes are staggered in time.
    const starts = ac.oscillators.slice(0, 4).map((o) => o.started[0]!);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(new Set(starts).size).toBe(4);
  });

  it('suspends the context once the sounds have finished', async () => {
    const synth = await import('./synth');
    synth.setSoundEnabled(true);
    synth.play('success');
    const ac = FakeContext.instances[0]!;
    expect(ac.state).toBe('running');
    await vi.advanceTimersByTimeAsync(200);
    expect(ac.state).toBe('running');
    await vi.advanceTimersByTimeAsync(2000);
    expect(ac.state).toBe('suspended');
  });

  it('suspends immediately when sounds are switched off', async () => {
    const synth = await import('./synth');
    synth.setSoundEnabled(true);
    synth.play('click');
    synth.setSoundEnabled(false);
    await Promise.resolve();
    expect(FakeContext.instances[0]!.state).toBe('suspended');
  });
});
