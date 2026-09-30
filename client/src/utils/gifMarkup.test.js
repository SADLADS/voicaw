import { describe, it, expect } from 'vitest';
import { gifMarkup, parseGifUrl } from './gifMarkup';
import { summarizeAttachments } from './attachmentMarkup';

describe('gifMarkup', () => {
  const gif = { url: 'https://static.klipy.com/ii/a/b.webp', width: 498, height: 374 };

  it('writes a markdown image carrying the size', () => {
    const text = gifMarkup(gif);
    expect(text).toBe('![GIF](https://static.klipy.com/ii/a/b.webp#gif&w=498&h=374)');
    expect(summarizeAttachments(text)).toBe('📎 GIF');
  });

  it('reads the size back, and only from GIF URLs', () => {
    expect(parseGifUrl(`${gif.url}#gif&w=498&h=374`)).toEqual({ width: 498, height: 374 });
    expect(parseGifUrl(`${gif.url}#gif&w=0&h=x`)).toEqual({ width: null, height: null });
    expect(parseGifUrl(gif.url)).toBeNull();
    expect(parseGifUrl('https://media.example/u.bin#v=1&k=abc&w=1&h=1')).toBeNull();
  });
});
