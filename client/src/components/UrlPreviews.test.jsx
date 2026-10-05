// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { setPrivacyPref } from '../utils/privacy';
import { NsfwChannelContext } from '../contexts';
import UrlPreviews from './UrlPreviews';
import { youtubeVideoId } from '../utils/youtube';
import { EMBED_ORIGIN } from '../voice/youtubeEmbed';

const ORIGIN = encodeURIComponent(window.location.origin);

// What the embed page would send us.
function fromPlayer(frame, data) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { origin: EMBED_ORIGIN, source: frame.contentWindow, data: JSON.stringify(data) }));
  });
}

const commandsSent = (spy) => spy.mock.calls.map(([message]) => JSON.parse(message)).filter((m) => m.event === 'command').map((m) => m.func);

describe('UrlPreviews', () => {
  it('finds YouTube video ids in watch, share and shorts links', () => {
    expect(youtubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://youtu.be/dQw4w9WgXcQ?si=abc')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://m.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://www.youtube.com/@channel')).toBeNull();
    expect(youtubeVideoId('https://notyoutube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(youtubeVideoId('https://[bad')).toBeNull();
  });

  it('embeds each video once', () => {
    const { container } = render(
      <UrlPreviews text="look https://youtu.be/dQw4w9WgXcQ and again https://www.youtube.com/watch?v=dQw4w9WgXcQ https://example.com" />
    );
    const frames = container.querySelectorAll('iframe');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveAttribute('src', `https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?enablejsapi=1&origin=${ORIGIN}`);
  });

  it('waits for Play before loading anything from YouTube when Settings → Privacy says so', () => {
    setPrivacyPref('youtubeEmbeds', false);
    try {
      const { container } = render(<UrlPreviews text="https://youtu.be/abcdefghijk" />);
      expect(container.querySelector('iframe')).toBeNull();
      expect(container.querySelector('img')).toBeNull();
      expect(screen.getByRole('link')).toHaveAttribute('href', 'https://youtu.be/abcdefghijk');
      fireEvent.click(screen.getByRole('button', { name: 'Play YouTube video' }));
      expect(container.querySelector('iframe')).toHaveAttribute('src', `https://www.youtube-nocookie.com/embed/abcdefghijk?enablejsapi=1&origin=${ORIGIN}&autoplay=1`);
    } finally {
      setPrivacyPref('youtubeEmbeds', true);
    }
  });

  it('covers a video in an NSFW channel, loading nothing from YouTube until uncovered', () => {
    const { container } = render(
      <NsfwChannelContext.Provider value><UrlPreviews text="https://youtu.be/abcdefghijk" /></NsfwChannelContext.Provider>
    );
    expect(container.querySelector('iframe')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'NSFW: YouTube video, select to reveal' }));
    expect(container.querySelector('iframe')).toHaveAttribute('src', `https://www.youtube-nocookie.com/embed/abcdefghijk?enablejsapi=1&origin=${ORIGIN}`);
  });

  describe('the touch shield over the player', () => {
    afterEach(() => vi.useRealTimers());

    it('plays and pauses the video when tapped', () => {
      const { container } = render(<UrlPreviews text="https://youtu.be/abcdefghijk" />);
      const frame = container.querySelector('iframe');
      const post = vi.spyOn(frame.contentWindow, 'postMessage');
      fromPlayer(frame, { event: 'initialDelivery', info: { playerState: -1 } });
      fireEvent.click(container.querySelector('.youtube-shield'));
      expect(commandsSent(post)).toContain('playVideo');
      fromPlayer(frame, { event: 'onStateChange', info: 1 });
      fireEvent.click(container.querySelector('.youtube-shield'));
      expect(commandsSent(post).at(-1)).toBe('pauseVideo');
    });

    it('steps aside when the phone won\'t start the video for it, until it plays', () => {
      vi.useFakeTimers();
      const { container } = render(<UrlPreviews text="https://youtu.be/abcdefghijk" />);
      const frame = container.querySelector('iframe');
      fromPlayer(frame, { event: 'initialDelivery', info: { playerState: 5 } });
      fireEvent.click(container.querySelector('.youtube-shield'));
      act(() => vi.advanceTimersByTime(2000));
      expect(container.querySelector('.youtube-shield')).toBeNull();
      fromPlayer(frame, { event: 'onStateChange', info: 1 });
      expect(container.querySelector('.youtube-shield')).not.toBeNull();
    });

    it('steps aside at once when the player never answered', () => {
      const { container } = render(<UrlPreviews text="https://youtu.be/abcdefghijk" />);
      fireEvent.click(container.querySelector('.youtube-shield'));
      expect(container.querySelector('.youtube-shield')).toBeNull();
    });
  });
});
