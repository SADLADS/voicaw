// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bringBackVideo, closeFloatingVideo, floatVideo, getFloatingVideo, parkingSpot, reclaimVideo,
  registerVideoPlayer, resetFloatingVideo, setFloatingMode,
} from './floatingVideo';
import { cornerHolder, leaveCorner, resetCornerSlot, wantCorner } from './cornerSlot';
import { claimPlayback } from '../utils/videoPlayer';

function playingVideo() {
  const element = document.createElement('video');
  element.pause = vi.fn();
  document.body.appendChild(element);
  return element;
}

function entry(key = 'a', extra = {}) {
  return { key, element: playingVideo(), src: `blob:${key}`, name: `${key}.mp4`, release: vi.fn(), origin: { path: '/dm/2' }, ...extra };
}

beforeEach(() => {
  resetFloatingVideo();
  resetCornerSlot();
});
afterEach(() => {
  resetFloatingVideo();
  resetCornerSlot();
});

describe('a video playing on outside its message', () => {
  it('goes to the corner (taking it) and waits in the page, playing, until the corner holds it', () => {
    const video = entry();
    expect(floatVideo(video)).toBe(true);
    expect(getFloatingVideo()).toMatchObject({ key: 'a', mode: 'corner' });
    expect(cornerHolder()).toBe('video');
    expect(video.element.parentNode).toBe(parkingSpot());
    expect(video.element.pause).not.toHaveBeenCalled();
  });

  it('is refused the corner while a stream or Watch Together has it (first come, first served)', () => {
    wantCorner('stream');
    const video = entry();
    expect(floatVideo(video)).toBe(false);
    expect(getFloatingVideo()).toBeNull();
    // A window isn't the corner.
    expect(floatVideo(video, 'window')).toBe(true);
    expect(cornerHolder()).toBe('stream');
    leaveCorner('stream');
  });

  it('gives the corner up when it moves to a window, and back only if still free', () => {
    floatVideo(entry());
    expect(setFloatingMode('window')).toBe(true);
    expect(cornerHolder()).toBeNull();
    wantCorner('watchParty');
    expect(setFloatingMode('corner')).toBe(false);
    expect(getFloatingVideo().mode).toBe('window');
  });

  it('is taken back by its own player only', () => {
    const video = entry('a');
    floatVideo(video);
    expect(reclaimVideo('b')).toBeNull();
    expect(reclaimVideo('a')).toMatchObject({ key: 'a', element: video.element });
    expect(getFloatingVideo()).toBeNull();
    expect(cornerHolder()).toBeNull();
    // Taken back, it's the player's again: nothing released.
    expect(video.release).not.toHaveBeenCalled();
  });

  it('closing stops it and frees what it held', () => {
    const video = entry();
    floatVideo(video);
    closeFloatingVideo();
    expect(video.element.pause).toHaveBeenCalled();
    expect(video.release).toHaveBeenCalledTimes(1);
    expect(video.element.isConnected).toBe(false);
    expect(getFloatingVideo()).toBeNull();
    expect(cornerHolder()).toBeNull();
  });

  it('another video starting replaces it; playing it again does not', () => {
    const video = entry();
    floatVideo(video);
    claimPlayback(video.element);
    expect(getFloatingVideo()).not.toBeNull();
    claimPlayback(document.createElement('video'));
    expect(getFloatingVideo()).toBeNull();
    expect(video.release).toHaveBeenCalled();
  });

  it('a second video floating closes the first', () => {
    const first = entry('a');
    floatVideo(first, 'window');
    floatVideo(entry('b'));
    expect(first.release).toHaveBeenCalled();
    expect(getFloatingVideo().key).toBe('b');
  });

  it('Bring back hands it to its message\'s player if one is on the page, else the corner', () => {
    const video = entry('a');
    const take = vi.fn();
    const unregister = registerVideoPlayer('a', take);
    floatVideo(video, 'window');
    bringBackVideo();
    expect(take).toHaveBeenCalledWith(expect.objectContaining({ key: 'a', element: video.element }));
    expect(getFloatingVideo()).toBeNull();

    unregister();
    floatVideo(video, 'window');
    bringBackVideo();
    expect(getFloatingVideo().mode).toBe('corner');
  });

  it('Bring back with nowhere to go (no player, corner taken) stops it', () => {
    const video = entry('a');
    floatVideo(video, 'window');
    wantCorner('stream');
    bringBackVideo();
    expect(getFloatingVideo()).toBeNull();
    expect(video.release).toHaveBeenCalled();
  });
});
