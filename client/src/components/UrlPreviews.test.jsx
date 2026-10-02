// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setPrivacyPref } from '../utils/privacy';
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
});
