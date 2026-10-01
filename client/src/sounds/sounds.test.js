// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A stand-in for Web Audio that records what's made and played.
let made;
function param() {
  return { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
}
function node(kind, extra = {}) {
  const n = { kind, connect: vi.fn((to) => to), disconnect: vi.fn(), ...extra };
  made.push(n);
  return n;
}
class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = { kind: 'destination' };
  }
  resume() { return Promise.resolve(); }
  createGain() { return node('gain', { gain: param() }); }
  createOscillator() { return node('oscillator', { frequency: param(), start: vi.fn(), stop: vi.fn() }); }
  createBufferSource() { return node('buffer', { start: vi.fn() }); }
  decodeAudioData() { return Promise.resolve({ decoded: true }); }
}

let sounds;
let soundList;
beforeEach(async () => {
  made = [];
  localStorage.clear();
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.resetModules();
  soundList = await import('./soundList');
  sounds = await import('./sounds');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const oscillators = () => made.filter((n) => n.kind === 'oscillator');
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('sounds', () => {
  it('plays a sound as its tone, at the chosen volume', async () => {
    sounds.setSoundVolume(0.5);
    sounds.playSound('mute');
    await flush();
    expect(oscillators()).toHaveLength(soundList.SOUNDS.mute.tone.notes.length);
    expect(oscillators()[0].start).toHaveBeenCalled();
    const out = made.find((n) => n.kind === 'gain');
    expect(out.gain.value).toBe(0.5);
    expect(out.connect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'destination' }));
  });

  it('skips sounds turned off (and everything at volume 0), but previews them', async () => {
    sounds.setSoundEnabled('mute', false);
    sounds.playSound('mute');
    await flush();
    expect(made).toEqual([]);
    sounds.playSound('mute', { preview: true });
    await flush();
    expect(oscillators().length).toBeGreaterThan(0);

    made = [];
    sounds.setSoundEnabled('mute', true);
    sounds.setSoundVolume(0);
    sounds.playSound('unmute');
    await flush();
    expect(made).toEqual([]);
  });

  it('remembers the choices on this device', async () => {
    sounds.setSoundEnabled('message', false);
    sounds.setSoundVolume(0.3);
    vi.resetModules();
    const again = await import('./sounds');
    expect(again.getSoundPrefs()).toEqual({ volume: 0.3, off: ['message'] });
    expect(again.isSoundOn('message')).toBe(false);
    expect(again.isSoundOn('mute')).toBe(true);
  });

  it('dings once for a burst of messages', async () => {
    sounds.playSound('message');
    sounds.playSound('message');
    await flush();
    expect(oscillators()).toHaveLength(soundList.SOUNDS.message.tone.notes.length);
  });

  it('loops a ring until stopped, then cuts it off', async () => {
    vi.useFakeTimers();
    sounds.startLoop('incomingRing');
    const perRing = soundList.SOUNDS.incomingRing.tone.notes.length;
    await vi.advanceTimersByTimeAsync(0);
    expect(oscillators()).toHaveLength(perRing);
    await vi.advanceTimersByTimeAsync(soundList.SOUNDS.incomingRing.every);
    expect(oscillators()).toHaveLength(perRing * 2);
    const out = made.find((n) => n.kind === 'gain');
    sounds.stopLoop();
    expect(out.disconnect).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10000);
    expect(oscillators()).toHaveLength(perRing * 2);
  });

  it('plays a sound file when one is given, and falls back to the tone without it', async () => {
    soundList.SOUNDS.mute.file = '/sounds/mute.ogg';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) })));
    sounds.playSound('mute');
    await flush();
    await flush();
    expect(made.filter((n) => n.kind === 'buffer')).toHaveLength(1);
    expect(oscillators()).toEqual([]);

    soundList.SOUNDS.unmute.file = '/sounds/missing.ogg';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    sounds.playSound('unmute');
    await flush();
    await flush();
    expect(oscillators()).toHaveLength(soundList.SOUNDS.unmute.tone.notes.length);
  });

  it('plays the message sound only when the page is in front (in a browser)', async () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    sounds.playMessageSound();
    await flush();
    expect(made).toEqual([]);
    focus.mockReturnValue(true);
    sounds.playMessageSound();
    await flush();
    expect(oscillators().length).toBeGreaterThan(0);
  });
});
