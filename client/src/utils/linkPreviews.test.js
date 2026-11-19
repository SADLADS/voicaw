import { describe, it, expect } from 'vitest';
import { linksIn, mediaLinkKind, linkFileName, drawnByApp, isGifLinkOnly, SUPPRESS_EMBEDS } from './linkPreviews';

describe('linkPreviews', () => {
  it('hides a message that is only a GIF site link with its GIF preview', () => {
    const link = 'https://klipy.com/gifs/happy-birthday-1405';
    const gif = [{ type: 'gifv', url: link, thumbnail: { url: 'https://static.klipy.com/x.webp' } }];
    expect(isGifLinkOnly(` ${link} `, gif)).toBe(true);
    expect(isGifLinkOnly(`look ${link}`, gif)).toBe(false);
    expect(isGifLinkOnly(link, gif, SUPPRESS_EMBEDS)).toBe(false);
    expect(isGifLinkOnly(link, [{ type: 'link', url: link }])).toBe(false);
    expect(isGifLinkOnly(link, undefined)).toBe(false);
  });

  it('finds links as the server does (server/test/linkPreviews.test.js)', () => {
    const text = 'see https://a.test/x_(y), and (https://b.test/z). `https://c.test` <https://d.test> '
      + '||https://e.test|| ![g](https://f.test/g.gif) ```\nhttps://g.test\n``` https://a.test/x_(y) http://h.test/p?q=1!';
    expect(linksIn(text)).toEqual(['https://a.test/x_(y)', 'https://b.test/z', 'http://h.test/p?q=1']);
    expect(linksIn('[label](https://i.test/page)')).toEqual(['https://i.test/page']);
    expect(linksIn(null)).toEqual([]);
  });

  it('tells pictures and videos by their file names', () => {
    expect(mediaLinkKind('https://x.test/a/cat.JPG?size=big')).toBe('image');
    expect(mediaLinkKind('https://x.test/clip.webm')).toBe('video');
    expect(mediaLinkKind('https://x.test/page.html')).toBeNull();
    expect(mediaLinkKind('https://x.test/?file=cat.png')).toBeNull();
    expect(linkFileName('https://x.test/a/my%20cat.png')).toBe('my cat.png');
    expect(linkFileName('https://x.test/')).toBe('x.test');
  });

  it('knows which links the app draws itself', () => {
    expect(drawnByApp('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
    expect(drawnByApp('https://example.com/')).toBe(false);
    expect(drawnByApp('https://app.voicaw.com/guild/1?event=13')).toBe(true);
  });
});
