import { describe, it, expect } from 'vitest';
import { mayBeAnimated, makeThumbnail } from './mediaDimensions';
import { stillType } from '../services/attachmentCache';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngChunk(type, length = 0) {
  const bytes = new Uint8Array(12 + length);
  new DataView(bytes.buffer).setUint32(0, length);
  bytes.set([...type].map((c) => c.charCodeAt(0)), 4);
  return bytes;
}

const png = (...chunks) => new File([new Uint8Array(PNG_SIGNATURE), ...chunks], 'a.png', { type: 'image/png' });

function webp(chunk, flags = 0) {
  const bytes = new Uint8Array(30);
  bytes.set([...`RIFF\0\0\0\0WEBP${chunk}`].map((c) => c.charCodeAt(0)));
  bytes[20] = flags;
  return new File([bytes], 'a.webp', { type: 'image/webp' });
}

describe('mayBeAnimated', () => {
  it('tells a still PNG from an animated one (acTL before the image data)', async () => {
    expect(await mayBeAnimated(png(pngChunk('IHDR', 13), pngChunk('tEXt', 40), pngChunk('IDAT', 100)))).toBe(false);
    expect(await mayBeAnimated(png(pngChunk('IHDR', 13), pngChunk('acTL', 8), pngChunk('IDAT', 100)))).toBe(true);
  });

  it("says a PNG might be when its image data starts past what's read", async () => {
    expect(await mayBeAnimated(png(pngChunk('IHDR', 13), pngChunk('iCCP', 300 * 1024), pngChunk('IDAT', 10)))).toBe(true);
  });

  it("reads a WebP's animation flag", async () => {
    expect(await mayBeAnimated(webp('VP8 '))).toBe(false);
    expect(await mayBeAnimated(webp('VP8X', 0x10))).toBe(false);
    expect(await mayBeAnimated(webp('VP8X', 0x12))).toBe(true);
  });

  it('never reads JPEGs', async () => {
    expect(await mayBeAnimated(new File(['x'], 'a.jpg', { type: 'image/jpeg' }))).toBe(false);
  });
});

describe('makeThumbnail', () => {
  it('leaves small images, GIFs and SVGs as they are', async () => {
    const big = { width: 4000, height: 3000 };
    expect(await makeThumbnail(new File(['x'], 'a.jpg', { type: 'image/jpeg' }), { width: 800, height: 600 })).toBeNull();
    expect(await makeThumbnail(new File(['x'], 'a.gif', { type: 'image/gif' }), big)).toBeNull();
    expect(await makeThumbnail(new File(['x'], 'a.svg', { type: 'image/svg+xml' }), big)).toBeNull();
  });
});

describe('stillType', () => {
  it('tells JPEG, PNG and WebP thumbnails apart by their first bytes', () => {
    expect(stillType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer)).toBe('image/jpeg');
    expect(stillType(new Uint8Array(PNG_SIGNATURE).buffer)).toBe('image/png');
    expect(stillType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ').buffer)).toBe('image/webp');
  });
});
