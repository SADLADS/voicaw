// @vitest-environment jsdom
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import VideoPlayer from './VideoPlayer';
import { VideoCorner } from './FloatingVideo';
import { getFloatingVideo, resetFloatingVideo } from '../services/floatingVideo';
import { resetCornerSlot, wantCorner, leaveCorner } from '../services/cornerSlot';
import { setPipPref } from '../utils/pipPrefs';
import { claimPlayback } from '../utils/videoPlayer';

// jsdom's media elements don't play: these say they do.
function setPaused(el, paused) {
  Object.defineProperty(el, 'paused', { value: paused, configurable: true });
  el.dispatchEvent(new Event(paused ? 'pause' : 'play'));
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function play() {
    setPaused(this, false);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function pause() {
    setPaused(this, true);
  });
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  setPipPref('onLeave', true);
  setPipPref('onScroll', false);
});

afterEach(() => {
  cleanup();
  act(() => {
    resetFloatingVideo();
    resetCornerSlot();
  });
  vi.restoreAllMocks();
  localStorage.clear();
});

let showMessage;
let location;
function Where() {
  location = useLocation();
  return null;
}

function App({ release }) {
  const [shown, setShown] = useState(true);
  showMessage = setShown;
  return (
    <>
      <Where />
      {shown && (
        <div data-chat-id="dm-2" data-chat-name="Bob">
          <div data-msg-id="7">
            <VideoPlayer src="blob:clip" mediaKey="file-1" name="clip.mp4" width={640} height={360} release={release} />
          </div>
        </div>
      )}
      <div className="corner-players"><VideoCorner /></div>
    </>
  );
}

function renderApp(release = vi.fn()) {
  const view = render(
    <MemoryRouter initialEntries={['/dm/2']}>
      <App release={release} />
    </MemoryRouter>,
  );
  return { ...view, release };
}

function playInMessage(container) {
  fireEvent.click(screen.getByLabelText('Play clip.mp4'));
  const video = container.querySelector('.video-player video');
  expect(video).not.toBeNull();
  expect(video.paused).toBe(false);
  return video;
}

describe('a video playing on in the corner', () => {
  it('moves the same playing element to the corner when its message goes, never pausing it', () => {
    const { container } = renderApp();
    const video = playInMessage(container);
    const pause = HTMLMediaElement.prototype.pause;
    pause.mockClear();

    act(() => showMessage(false));

    const corner = container.querySelector('.floating-video.corner');
    expect(corner).not.toBeNull();
    expect(corner.querySelector('video')).toBe(video);
    expect(pause).not.toHaveBeenCalled();
    expect(video.paused).toBe(false);
    expect(screen.getByText('clip.mp4')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('Go to message opens its chat at that message', () => {
    const { container } = renderApp();
    playInMessage(container);
    act(() => showMessage(false));

    fireEvent.click(screen.getByLabelText('Go to message'));
    expect(location.pathname).toBe('/dm/2');
    expect(location.state).toEqual({ jumpToMessage: { chatId: 'dm-2', messageId: '7' } });
  });

  it('comes back into its message, still playing, when that shows again', () => {
    const { container } = renderApp();
    const video = playInMessage(container);
    act(() => showMessage(false));
    act(() => showMessage(true));

    expect(container.querySelector('.floating-video')).toBeNull();
    expect(container.querySelector('.video-player video')).toBe(video);
    expect(video.paused).toBe(false);
    expect(getFloatingVideo()).toBeNull();
  });

  it('Close stops it and lets go of its file', () => {
    const { container, release } = renderApp();
    const video = playInMessage(container);
    act(() => showMessage(false));
    fireEvent.click(screen.getByLabelText('Close'));
    expect(container.querySelector('.floating-video')).toBeNull();
    expect(video.paused).toBe(true);
    expect(release).toHaveBeenCalledWith('blob:clip');
  });

  it('a paused video just stops, as before', () => {
    const { container, release } = renderApp();
    const video = playInMessage(container);
    act(() => video.pause());
    act(() => showMessage(false));
    expect(container.querySelector('.floating-video')).toBeNull();
    expect(release).toHaveBeenCalledWith('blob:clip');
  });

  it('stops instead with the setting off', () => {
    setPipPref('onLeave', false);
    const { container, release } = renderApp();
    const video = playInMessage(container);
    act(() => showMessage(false));
    expect(container.querySelector('.floating-video')).toBeNull();
    expect(video.paused).toBe(true);
    expect(release).toHaveBeenCalledWith('blob:clip');
  });

  it('stops while a stream or Watch Together has the corner (first come, first served)', () => {
    act(() => wantCorner('stream'));
    const { container } = renderApp();
    const video = playInMessage(container);
    act(() => showMessage(false));
    expect(container.querySelector('.floating-video')).toBeNull();
    expect(video.paused).toBe(true);
    act(() => leaveCorner('stream'));
  });

  it('starting another video replaces it', () => {
    const { container } = renderApp();
    playInMessage(container);
    act(() => showMessage(false));
    act(() => claimPlayback(document.createElement('video')));
    expect(container.querySelector('.floating-video')).toBeNull();
  });
});
