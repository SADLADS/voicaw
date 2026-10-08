import { describe, it, expect } from 'vitest';
import {
  CHUNK_SIZE, TAG_BYTES, chunkCount, encryptedSize, encryptedRange, encryptChunkedAttachment,
  decryptChunkedAttachment, decryptChunks, importChunkKey, decryptPoster, chunkedEncryptor, decryptingStream,
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

  it('encrypts a part at a time, the same as all at once', async () => {
    const size = CHUNK_SIZE * 5 + 123;
    const plain = randomBytes(size);
    const encryptor = await chunkedEncryptor(new Blob([plain]));
    expect(encryptor.count).toBe(6);
    const parts = [await encryptor.encrypt(0, 1), await encryptor.encrypt(2, 4), await encryptor.encrypt(5, 5)];
    expect(parts.map((p) => p.length)).toEqual([2 * (CHUNK_SIZE + TAG_BYTES), 3 * (CHUNK_SIZE + TAG_BYTES), 123 + TAG_BYTES]);
    const stored = new Blob(parts);
    expect(stored.size).toBe(encryptedSize(size));
    const back = await decryptChunkedAttachment(await stored.arrayBuffer(), encryptor.key, encryptor.nonce, size);
    expect(back).toEqual(plain);
  });

  describe('decryptingStream', () => {
    // Pushes `stored` through in pieces of `pieceSize`, resolving to the plaintext.
    async function throughStream(stored, key, nonce, size, pieceSize) {
      const source = new ReadableStream({
        start(controller) {
          for (let at = 0; at < stored.length; at += pieceSize) controller.enqueue(stored.slice(at, at + pieceSize));
          controller.close();
        },
      });
      const out = [];
      const reader = source.pipeThrough(decryptingStream(await importChunkKey(key), nonce, size)).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out.push(value);
      }
      return new Uint8Array(await new Blob(out).arrayBuffer());
    }

    it('decrypts a file arriving in pieces of any size', async () => {
      const size = CHUNK_SIZE * 3 + 999;
      const plain = randomBytes(size);
      const { blob, key, nonce } = await encryptChunkedAttachment(new Blob([plain]));
      const stored = new Uint8Array(await blob.arrayBuffer());
      for (const pieceSize of [4096, 65536, CHUNK_SIZE + TAG_BYTES, stored.length]) {
        expect(await throughStream(stored, key, nonce, size, pieceSize)).toEqual(plain);
      }
    }, 30_000);

    it('decrypts an empty file', async () => {
      const { blob, key, nonce } = await encryptChunkedAttachment(new Blob([]));
      expect(await throughStream(new Uint8Array(await blob.arrayBuffer()), key, nonce, 0, 100)).toEqual(new Uint8Array(0));
    });

    it('refuses tampered, cut-short or overlong data', async () => {
      const size = CHUNK_SIZE + 50;
      const { blob, key, nonce } = await encryptChunkedAttachment(new Blob([randomBytes(size)]));
      const stored = new Uint8Array(await blob.arrayBuffer());
      const flipped = stored.slice();
      flipped[stored.length - 3] ^= 1;
      await expect(throughStream(flipped, key, nonce, size, 4096)).rejects.toThrow();
      await expect(throughStream(stored.slice(0, stored.length - 1), key, nonce, size, 4096)).rejects.toThrow(/cut short/);
      await expect(throughStream(stored.slice(0, CHUNK_SIZE + TAG_BYTES), key, nonce, size, 4096)).rejects.toThrow(/cut short/);
      const longer = new Uint8Array(stored.length + 1);
      longer.set(stored);
      await expect(throughStream(longer, key, nonce, size, 4096)).rejects.toThrow(/Too much/);
    });
  });
});
