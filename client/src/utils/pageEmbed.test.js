import { describe, it, expect } from 'vitest';
import * as linkPreviews from './pageEmbed';

// The same cases as server/test/linkPreviews.test.js's embedFromHtml: the two must agree.
describe('embedFromHtml', () => {
  it("reads a page's OpenGraph and Twitter card", () => {
    const html = `<!doctype html><html><head><title>Fallback</title>
      <meta property="og:title" content="A &amp; B &#x2014; news">
      <meta name="description" content="  Plain
        description ">
      <meta property="og:site_name" content='Example'>
      <meta property="og:image" content="/pic.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
      <meta name="twitter:card" content="summary_large_image">
      <meta name="theme-color" content="#f80">
      </head><body><meta property="og:title" content="not this"></body></html>`;
    expect(linkPreviews.embedFromHtml(html, 'https://example.test/a', 'https://www.example.test/a')).toEqual({
      type: 'link',
      url: 'https://example.test/a',
      title: 'A & B — news',
      description: 'Plain description',
      color: 0xff8800,
      provider: { name: 'Example' },
      image: { url: 'https://www.example.test/pic.png', width: 1200, height: 630 },
    });
  });

  it('uses <title> and a small picture by default, and a video file when there is one', () => {
    expect(linkPreviews.embedFromHtml('<title>Just a title</title><meta property="og:image" content="https://x.test/i.jpg">', 'https://x.test/', 'https://x.test/'))
      .toEqual({ type: 'link', url: 'https://x.test/', title: 'Just a title', thumbnail: { url: 'https://x.test/i.jpg' } });
    const video = linkPreviews.embedFromHtml(`<meta property="og:title" content="Clip"><meta property="og:video" content="https://x.test/v.mp4">
      <meta property="og:video:type" content="video/mp4"><meta property="og:image" content="javascript:alert(1)">`, 'https://x.test/v', 'https://x.test/v');
    expect(video).toEqual({ type: 'video', url: 'https://x.test/v', title: 'Clip', video: { url: 'https://x.test/v.mp4' } });
  });

  it('gives nothing for a page that says nothing', () => {
    expect(linkPreviews.embedFromHtml('<html><body>hi</body></html>', 'https://x.test/', 'https://x.test/')).toBeNull();
  });

  it('cuts long text', () => {
    const embed = linkPreviews.embedFromHtml(`<meta name="description" content="${'word '.repeat(200)}">`, 'https://x.test/', 'https://x.test/');
    expect(embed.description.length).toBe(350);
    expect(embed.description.endsWith('…')).toBe(true);
  });
});

describe('embedFromResponse', () => {
  it('shows a picture or a video as itself, and a page as its card', () => {
    expect(linkPreviews.embedFromResponse({ status: 200, url: 'https://cdn.test/a.png', contentType: 'image/png' }, 'https://x.test/a'))
      .toEqual({ type: 'image', url: 'https://x.test/a', thumbnail: { url: 'https://cdn.test/a.png' } });
    expect(linkPreviews.embedFromResponse({ status: 200, url: 'https://cdn.test/v', contentType: 'video/mp4' }, 'https://x.test/v'))
      .toEqual({ type: 'video', url: 'https://x.test/v', video: { url: 'https://cdn.test/v' } });
    expect(linkPreviews.embedFromResponse({ status: 200, url: 'https://x.test/p', contentType: 'text/html', html: '<title>Page</title>' }, 'https://x.test/p'))
      .toEqual({ type: 'link', url: 'https://x.test/p', title: 'Page' });
  });

  it('gives nothing for errors and other files', () => {
    expect(linkPreviews.embedFromResponse({ status: 404, url: 'https://x.test/', contentType: 'text/html', html: '<title>Gone</title>' }, 'https://x.test/')).toBeNull();
    expect(linkPreviews.embedFromResponse({ status: 200, url: 'https://x.test/f.zip', contentType: 'application/zip' }, 'https://x.test/f.zip')).toBeNull();
    expect(linkPreviews.embedFromResponse(null, 'https://x.test/')).toBeNull();
  });
});
