// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readEpubCover } from './epubCover';
import { epub, xhtml, PNG } from '../../test/epubFixture';

// jsdom draws nothing: the bitmap and the canvas are stand-ins that record what they were given.
let decoded;
let drawn;
beforeEach(() => {
  decoded = [];
  drawn = [];
  globalThis.createImageBitmap = vi.fn(async (blob) => {
    decoded.push(blob);
    return { width: 1400, height: 2000, close: vi.fn() };
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext() {
    return { fillRect: vi.fn(), drawImage: (...args) => drawn.push([this.width, this.height, args]) };
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done, type) => done(new Blob(['jpeg'], { type })));
});
afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.createImageBitmap;
});

describe('book covers', () => {
  it('redraws the cover as a small JPEG, of the bytes typed by what they are', async () => {
    const cover = await readEpubCover(await epub({
      files: { 'one.xhtml': xhtml('<p>1</p>'), 'cover.jpg': PNG }, // a PNG, whatever its name says
      properties: { 'cover.jpg': 'cover-image' },
      spine: ['a'],
    }));
    expect(decoded[0].type).toBe('image/png');
    expect(cover).toEqual({ width: 280, height: 400, thumbnail: expect.any(Blob) });
    expect(cover.thumbnail.type).toBe('image/jpeg');
    expect(drawn).toHaveLength(1);
  });

  it('gives no cover for an SVG one, a missing one, or bytes that are no picture', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    for (const content of [svg, '<html><script>alert(1)</script></html>']) {
      expect(await readEpubCover(await epub({
        files: { 'one.xhtml': xhtml('<p>1</p>'), 'cover.png': content },
        properties: { 'cover.png': 'cover-image' },
        spine: ['a'],
      }))).toBeNull();
    }
    expect(await readEpubCover(await epub({ files: { 'one.xhtml': xhtml('<p>1</p>') }, spine: ['a'] }))).toBeNull();
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
});
