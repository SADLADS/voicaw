// The picture type a book's file really is, from its first bytes, never from what the book's
// manifest says: only PNG, JPEG, GIF and WebP (pictures a browser can't run), else null. Blobs
// made from a book's files only ever get one of these types (docs/uploads.md, EPUB reader).
export function rasterType(bytes) {
  const b = new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, Math.min(12, bytes.byteLength));
  const ascii = (at, length) => String.fromCharCode(...b.subarray(at, at + length));
  if (b[0] === 0x89 && ascii(1, 3) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  return null;
}
