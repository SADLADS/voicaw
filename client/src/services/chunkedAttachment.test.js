import { describe, it, expect } from 'vitest';
import {
  CHUNK_SIZE, TAG_BYTES, chunkCount, encryptedSize, encryptedRange, encryptChunkedAttachment,
  decryptChunkedAttachment, decryptChunks, importChunkKey, decryptPoster,
} from './chunkedAttachment';

const randomBytes = (n) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
};

describe('chunkedAttachment', () => {
  it('sizes: one tag per 256 KiB, at least one chunk', () => {
    expect(chunkCount(0)).toBe(1);
    expect(chunkCount(1)).toBe(1);
    expect(chunkCount(CHUNK_SIZE)).toBe(1);
    expect(chunkCount(CHUNK_SIZE + 1)).toBe(2);
    expect(encryptedSize(CHUNK_SIZE * 2 + 5)).toBe(CHUNK_SIZE * 2 + 5 + 3 * TAG_BYTES);
  });

  it('round-trips a file, and its poster', async () => {
    const plain = randomBytes(CHUNK_SIZE * 2 + 1000);
    const poster = new Blob([new Uint8Array([1, 2, 3])]);
    const { blob, key, nonce, poster: sealed } = await encryptChunkedAttachment(new Blob([plain]), poster);
    expect(blob.size).toBe(encryptedSize(plain.length));
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{16}$/);
    const back = await decryptChunkedAttachment(await blob.arrayBuffer(), key, nonce, plain.length);
    expect(back).toEqual(plain);
    expect(new Uint8Array(await decryptPoster(await sealed.arrayBuffer(), key))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('decrypts any range from just the chunks that cover it', async () => {
    const size = CHUNK_SIZE * 3 + 77;
    const plain = randomBytes(size);
    const { blob, key, nonce } = await encryptChunkedAttachment(new Blob([plain]));
    const stored = new Uint8Array(await blob.arrayBuffer());
    const cryptoKey = await importChunkKey(key);

    for (const [start, end] of [[0, 1], [CHUNK_SIZE - 3, CHUNK_SIZE + 3], [CHUNK_SIZE * 2 + 10, size - 1], [size - 1, size - 1]]) {
      const r = encryptedRange(start, end, size);
      const out = await decryptChunks(cryptoKey, nonce, size, r.first, stored.slice(r.from, r.to + 1));
      const offset = start - r.first * CHUNK_SIZE;
      expect(out.subarray(offset, offset + end - start + 1)).toEqual(plain.subarray(start, end + 1));
    }
  });

  it('refuses tampered, reordered or cut-short data', async () => {
    const size = CHUNK_SIZE * 2 + 10;
    const { blob, key, nonce } = await encryptChunkedAttachment(new Blob([randomBytes(size)]));
    const stored = new Uint8Array(await blob.arrayBuffer());
    const cryptoKey = await importChunkKey(key);
    const stride = CHUNK_SIZE + TAG_BYTES;

    const flipped = stored.slice();
    flipped[5] ^= 1;
    await expect(decryptChunkedAttachment(flipped.buffer, key, nonce, size)).rejects.toThrow();

    // Chunk 1 served as chunk 0.
    await expect(decryptChunks(cryptoKey, nonce, size, 0, stored.slice(stride, stride * 2))).rejects.toThrow();

    // Dropping the last chunk: the one before isn't marked last, so it can't pass as the end.
    await expect(decryptChunks(cryptoKey, nonce, CHUNK_SIZE * 2, 1, stored.slice(stride, stride * 2))).rejects.toThrow();
    await expect(decryptChunkedAttachment(stored.slice(0, stride * 2).buffer, key, nonce, size)).rejects.toThrow();
  });
});
