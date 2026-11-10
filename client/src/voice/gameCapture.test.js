import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gameCaptureFailureKey, scaledEncodings, startGameFrames, targetHeight } from './gameCapture';

// Chrome's MediaStreamTrackGenerator: frames written to it go out as the track's video.
class FakeGenerator {
  constructor({ kind }) {
    this.kind = kind;
    this.written = [];
    this.stopped = false;
    this.slow = null; // a promise the next write waits for
    FakeGenerator.last = this;
    this.writable = {
      getWriter: () => ({
        write: async (frame) => {
          if (this.slow) await this.slow;
          this.written.push(frame);
        },
        close: async () => {},
      }),
    };
  }
  stop() { this.stopped = true; }
}

// desktop.gameCapture (electron/preload.js): frame(n) hands over a frame as the app would.
function fakeBridge({ start = async () => ({ id: 3, width: 1920, height: 1080 }) } = {}) {
  const bridge = {
    frameCallback: null,
    stateCallback: null,
    start: vi.fn(start),
    stop: vi.fn(),
    setFrameRate: vi.fn(),
    onFrame: vi.fn((cb) => {
      bridge.frameCallback = cb;
      return () => { bridge.frameCallback = null; };
    }),
    onState: vi.fn((cb) => {
      bridge.stateCallback = cb;
      return () => { bridge.stateCallback = null; };
    }),
    async frame(n) {
      const frame = { n, closed: false, close() { this.closed = true; } };
      await bridge.frameCallback?.({ getVideoFrame: () => frame });
      return frame;
    },
    state: (state) => bridge.stateCallback?.(state),
  };
  return bridge;
}

describe('game capture frames (voice/gameCapture.js)', () => {
  beforeEach(() => { globalThis.MediaStreamTrackGenerator = FakeGenerator; });
  afterEach(() => { delete globalThis.MediaStreamTrackGenerator; });

  it('starts the app\'s capture and writes each frame into a video track', async () => {
    const bridge = fakeBridge();
    const capture = await startGameFrames(bridge, { hwnd: '42', fps: 30 });
    expect(bridge.start).toHaveBeenCalledWith('42', 30);
    expect(capture).toMatchObject({ width: 1920, height: 1080, track: FakeGenerator.last });
    expect(FakeGenerator.last.kind).toBe('video');
    const frame = await bridge.frame(1);
    expect(FakeGenerator.last.written).toEqual([frame]);
    capture.setFrameRate(60);
    expect(bridge.setFrameRate).toHaveBeenCalledWith(60);
  });

  it('drops frames rather than queueing them while the track is behind', async () => {
    const bridge = fakeBridge();
    await startGameFrames(bridge, { hwnd: '42', fps: 60 });
    let catchUp;
    FakeGenerator.last.slow = new Promise((resolve) => { catchUp = resolve; });
    const first = bridge.frame(1);
    const second = bridge.frame(2);
    const third = await bridge.frame(3); // two already waiting: this one goes
    expect(third.closed).toBe(true);
    catchUp();
    await Promise.all([first, second]);
    expect(FakeGenerator.last.written.map((f) => f.n)).toEqual([1, 2]);
  });

  it('rejects with the app\'s reason, letting everything go', async () => {
    const bridge = fakeBridge({ start: async () => ({ error: { code: 'elevated', message: 'admin' } }) });
    await expect(startGameFrames(bridge, { hwnd: '42', fps: 60 })).rejects.toEqual({ code: 'elevated', message: 'admin' });
    expect(FakeGenerator.last.stopped).toBe(true);
    expect(bridge.frameCallback).toBeNull();
    await expect(startGameFrames(null, { hwnd: '42', fps: 60 })).rejects.toMatchObject({ code: 'unavailable' });
    delete globalThis.MediaStreamTrackGenerator;
    await expect(startGameFrames(fakeBridge(), { hwnd: '42', fps: 60 })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('hears its own capture\'s end and resizes, not another one\'s', async () => {
    const bridge = fakeBridge();
    const onEnd = vi.fn();
    const onResize = vi.fn();
    await startGameFrames(bridge, { hwnd: '42', fps: 60, onEnd, onResize });
    bridge.state({ id: 2, state: 'stopped', reason: 'stopped' }); // the one before
    bridge.state({ id: 3, state: 'live', width: 1920, height: 1080 });
    expect(onEnd).not.toHaveBeenCalled();
    expect(onResize).not.toHaveBeenCalled();
    bridge.state({ id: 3, state: 'live', width: 1280, height: 720 });
    expect(onResize).toHaveBeenCalledWith({ width: 1280, height: 720 });
    bridge.state({ id: 3, state: 'error', code: 'import_failed' });
    bridge.state({ id: 3, state: 'stopped', reason: 'game_closed' });
    expect(onEnd.mock.calls).toEqual([[{ code: 'import_failed' }]]);
    expect(FakeGenerator.last.stopped).toBe(true);
    // A frame arriving after the end is let go.
    expect((await bridge.frame(9)).closed).toBe(false); // no callback any more: the app releases it
    expect(bridge.frameCallback).toBeNull();
  });

  it('stop() stops the app\'s capture once', async () => {
    const bridge = fakeBridge();
    const capture = await startGameFrames(bridge, { hwnd: '42', fps: 60 });
    capture.stop();
    capture.stop();
    expect(bridge.stop).toHaveBeenCalledTimes(1);
    expect(FakeGenerator.last.stopped).toBe(true);
  });
});

describe('game capture sizes and messages', () => {
  it('scales LiveKit\'s layers down to the chosen resolution, never up', () => {
    const layers = [{ rid: 'f', scaleResolutionDownBy: 1 }, { rid: 'h', scaleResolutionDownBy: 2 }];
    expect(scaledEncodings(layers, 2160, 1080).map((e) => e.scaleResolutionDownBy)).toEqual([2, 4]);
    expect(scaledEncodings(layers, 720, 1080).map((e) => e.scaleResolutionDownBy)).toEqual([1, 2]);
    expect(scaledEncodings(layers, 2160, Infinity).map((e) => e.scaleResolutionDownBy)).toEqual([1, 2]);
    expect(scaledEncodings([{}], 1440, 720)[0].scaleResolutionDownBy).toBe(2);
    expect([targetHeight('720'), targetHeight('1080'), targetHeight('source')]).toEqual([720, 1080, Infinity]);
  });

  it('picks what to tell the sharer from the reason', () => {
    expect(gameCaptureFailureKey('elevated')).toBe('gameCaptureElevated');
    expect(gameCaptureFailureKey('hook_not_loaded')).toBe('gameCaptureBlocked');
    expect(gameCaptureFailureKey('inject_failed')).toBe('gameCaptureBlocked');
    expect(gameCaptureFailureKey('unsupported_format')).toBe('gameCaptureUnsupported');
    expect(gameCaptureFailureKey('timeout')).toBe('gameCaptureFailed');
  });
});
