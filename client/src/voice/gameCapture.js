// Game capture's page side (the desktop app on Windows; see Game capture in
// docs/desktop-and-site.md): the app hooks the game and hands this page each frame it draws, as a
// GPU texture (desktop.gameCapture, electron/preload.js). Here they become a video track
// (MediaStreamTrackGenerator), which voiceClient's startScreenShare swaps into the screen share
// in place of the game window's own capture (frozen while a game is in exclusive full screen).

// Frames waiting to be written: past this, new ones are dropped rather than queued (each holds
// one of the helper's few textures).
const MAX_PENDING = 2;

// Starts capturing the game whose window is `hwnd` at up to `fps` frames a second. Resolves to
// { track, width, height, stop(), setFrameRate(fps) }; `onEnd({ code } | { reason })` is called
// once if the capture ends on its own (the game closed, or it failed), `onResize({ width,
// height })` when the game's picture changes size. Rejects with { code, message } if the game
// couldn't be captured (the share then keeps the window's capture).
export async function startGameFrames(bridge, { hwnd, fps, onEnd = () => {}, onResize = () => {} }) {
  if (!bridge || typeof globalThis.MediaStreamTrackGenerator !== 'function') {
    throw { code: 'unavailable', message: '' };
  }
  const generator = new globalThis.MediaStreamTrackGenerator({ kind: 'video' });
  const writer = generator.writable.getWriter();
  let open = true;
  let id = null;
  let pending = 0;

  const offFrame = bridge.onFrame(async (imported) => {
    const frame = imported.getVideoFrame();
    if (!open || pending >= MAX_PENDING) {
      frame.close();
      return;
    }
    pending++;
    try {
      await writer.write(frame);
    } catch {
      frame.close();
    } finally {
      pending--;
    }
  });

  function close() {
    if (!open) return false;
    open = false;
    offFrame?.();
    offState?.();
    writer.close().catch(() => {});
    generator.stop();
    return true;
  }

  let size = null;
  const offState = bridge.onState((state) => {
    if (id === null || state?.id !== id) return;
    if (state.state === 'live') {
      if (size && (state.width !== size.width || state.height !== size.height)) onResize({ width: state.width, height: state.height });
      size = { width: state.width, height: state.height };
      return;
    }
    if (state.state !== 'error' && state.state !== 'stopped') return;
    if (close()) onEnd(state.state === 'error' ? { code: state.code } : { reason: state.reason });
  });

  const result = await bridge.start(hwnd, fps).catch((err) => ({ error: { code: 'failed', message: String(err?.message ?? err) } }));
  if (!result || result.error) {
    close();
    throw result?.error ?? { code: 'failed', message: '' };
  }
  ({ id } = result);
  size = { width: result.width, height: result.height };
  if (!open) {
    bridge.stop();
    throw { code: 'stopped', message: '' };
  }
  return {
    track: generator,
    width: result.width,
    height: result.height,
    setFrameRate: (rate) => bridge.setFrameRate(rate),
    stop() {
      if (close()) bridge.stop();
    },
  };
}

// The encodings for game frames `nativeHeight` high when the sharer chose `targetHeight`
// (Infinity for Source): LiveKit lays a screen share's layers out at the track's own size (the
// top one full size, simulcast's below it), so frames bigger than the chosen resolution are
// scaled down to it, as the window's capture was. `encodings` are LiveKit's, as it set them.
export function scaledEncodings(encodings, nativeHeight, targetHeight) {
  const factor = nativeHeight > targetHeight ? nativeHeight / targetHeight : 1;
  return encodings.map((encoding) => ({ ...encoding, scaleResolutionDownBy: (encoding.scaleResolutionDownBy ?? 1) * factor }));
}

// The height the sharer's resolution choice means (streamSettings.js RESOLUTIONS).
export const targetHeight = (resolution) => (resolution === '720' ? 720 : resolution === '1080' ? 1080 : Infinity);

// What to tell the sharer when the game couldn't be captured and its window is shared instead
// (a translation key, under voice.errors).
export function gameCaptureFailureKey(code) {
  if (code === 'elevated') return 'gameCaptureElevated';
  if (code === 'hook_not_loaded' || code === 'inject_failed') return 'gameCaptureBlocked';
  if (code === 'unsupported_format' || code === 'import_failed' || code === 'no_adapter') return 'gameCaptureUnsupported';
  return 'gameCaptureFailed';
}
