// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { setPrivacyPref } from '../utils/privacy';
import { InteractionContext, NsfwChannelContext } from '../contexts';
import UrlPreviews from './UrlPreviews';
import { youtubeVideoId } from '../utils/youtube';

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
    expect(frames[0]).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  });

  it('waits for Play before loading anything from YouTube when Settings → Privacy says so', () => {
    setPrivacyPref('youtubeEmbeds', false);
    try {
      const { container } = render(<UrlPreviews text="https://youtu.be/abcdefghijk" />);
      expect(container.querySelector('iframe')).toBeNull();
      expect(container.querySelector('img')).toBeNull();
      expect(screen.getByRole('link')).toHaveAttribute('href', 'https://youtu.be/abcdefghijk');
      fireEvent.click(screen.getByRole('button', { name: 'Play YouTube video' }));
      expect(container.querySelector('iframe')).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/abcdefghijk?autoplay=1');
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
    expect(container.querySelector('iframe')).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/abcdefghijk');
  });

  describe('on a phone', () => {
    const onPhone = (ui) => render(<InteractionContext.Provider value={{ isMobile: true }}>{ui}</InteractionContext.Provider>);
    const player = () => document.querySelector('[role="dialog"] iframe');

    it('shows the thumbnail in the message and plays the video full screen when tapped', () => {
      const { container } = onPhone(<UrlPreviews text="https://youtu.be/abcdefghijk" />);
      expect(container.querySelector('iframe')).toBeNull();
      expect(container.querySelector('img')).toHaveAttribute('src', 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
      fireEvent.click(screen.getByRole('button', { name: 'Play YouTube video' }));
      expect(screen.getByRole('dialog', { name: 'YouTube video' })).toBeInTheDocument();
      expect(player()).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/abcdefghijk?autoplay=1&playsinline=1');
      expect(container.querySelector('iframe')).toBeNull(); // over the app, not in the message
    });

    it('closes with X, Escape or the back button', async () => {
      onPhone(<UrlPreviews text="https://youtu.be/abcdefghijk" />);
      const open = () => fireEvent.click(screen.getByRole('button', { name: 'Play YouTube video' }));
      open();
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(player()).toBeNull());
      open();
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(player()).toBeNull());
      open();
      act(() => window.history.back());
      await waitFor(() => expect(player()).toBeNull());
    });

    it('keeps to the placeholder when Settings → Privacy says so, and plays full screen from it', () => {
      setPrivacyPref('youtubeEmbeds', false);
      try {
        const { container } = onPhone(<UrlPreviews text="https://youtu.be/abcdefghijk" />);
        expect(container.querySelector('img')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Play YouTube video' }));
        expect(player()).not.toBeNull();
      } finally {
        setPrivacyPref('youtubeEmbeds', true);
      }
    });
  });
});
