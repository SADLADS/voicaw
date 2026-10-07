// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setPrivacyPref } from '../utils/privacy';
import MessageEmbeds from './MessageEmbeds';

const card = {
  type: 'link',
  url: 'https://news.example/story',
  title: 'A story',
  description: 'Some **words** <@1>',
  provider: { name: 'Example News' },
  thumbnail: { url: 'https://cdn.example/pic.jpg', width: 400, height: 300 },
};

describe('MessageEmbeds (link previews)', () => {
  it("draws a page's card, its text as plain text", () => {
    const { container } = render(<MessageEmbeds embeds={[card]} links />);
    expect(screen.getByRole('link', { name: 'A story' })).toHaveAttribute('href', 'https://news.example/story');
    expect(screen.getByText('Example News')).toBeInTheDocument();
    expect(screen.getByText('Some **words** <@1>')).toBeInTheDocument();
    expect(container.querySelector('.embed-thumbnail')).toHaveAttribute('src', 'https://cdn.example/pic.jpg');
  });

  it('shows a picture link as the picture and a video link as a player', () => {
    const { container } = render(
      <MessageEmbeds
        links
        embeds={[
          { type: 'image', url: 'https://i.example/a.png', thumbnail: { url: 'https://i.example/a.png', width: 800, height: 600 } },
          { type: 'video', url: 'https://v.example/b.mp4', video: { url: 'https://v.example/b.mp4' } },
        ]}
      />
    );
    expect(container.querySelector('.embed')).toBeNull();
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://i.example/a.png');
    expect(container.querySelector('video')).toHaveAttribute('src', 'https://v.example/b.mp4');
  });

  it("holds other sites' pictures back when Settings → Privacy says so, the text still showing", () => {
    setPrivacyPref('linkPreviews', false);
    try {
      const { container } = render(<MessageEmbeds embeds={[card]} links />);
      expect(screen.getByText('A story')).toBeInTheDocument();
      expect(container.querySelector('img')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Show picture from cdn.example' }));
      expect(container.querySelector('img')).toHaveAttribute('src', 'https://cdn.example/pic.jpg');
    } finally {
      setPrivacyPref('linkPreviews', true);
    }
  });

  it("hides link previews, not the sender's own embeds, when Settings → Privacy turns them off", () => {
    setPrivacyPref('showLinkPreviews', false);
    try {
      const { container } = render(<MessageEmbeds embeds={[card]} links />);
      expect(container).toBeEmptyDOMElement();
      render(<MessageEmbeds embeds={[{ title: 'From a bot' }]} renderMarkdown={(text) => text} />);
      expect(screen.getByText('From a bot')).toBeInTheDocument();
    } finally {
      setPrivacyPref('showLinkPreviews', true);
    }
  });

  it("doesn't hold back a webhook embed's picture that is one of its own files", () => {
    setPrivacyPref('linkPreviews', false);
    try {
      const own = 'https://s3.test/uploads/webhooks/x/a.png';
      const { container } = render(
        <MessageEmbeds embeds={[{ title: 'Hook', image: { url: own } }, { title: 'Other', image: { url: 'https://else.example/b.png' } }]} renderMarkdown={(text) => text} ownUrls={[own]} />
      );
      expect([...container.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual([own]);
    } finally {
      setPrivacyPref('linkPreviews', true);
    }
  });
});
