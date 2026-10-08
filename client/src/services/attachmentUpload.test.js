import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import api from '../utils/api';
import { uploadAttachment, maxAttachmentBytes } from './attachmentUpload';
import { parseAttachmentUrl } from './attachmentCrypto';
import { decryptChunkedAttachment, decryptPoster, encryptedSize, CHUNK_SIZE, TAG_BYTES } from './chunkedAttachment';

vi.mock('../utils/api', () => ({ default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const PART_BYTES = 32 * (CHUNK_SIZE + TAG_BYTES); // the server's
const randomBytes = (n) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
};

// Not toEqual: on 16 MB it builds a diff the size of the file.
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// What was PUT where, and URLs whose PUT fails (as many times as given).
let puts;
let failing;
class FakeXhr {
  constructor() {
    this.upload = {};
  }

  open(method, url) {
    this.url = url;
  }

  setRequestHeader() {}

  send(body) {
    setTimeout(async () => {
      if (failing.get(this.url) > 0) {
        failing.set(this.url, failing.get(this.url) - 1);
        this.onerror();
        return;
      }
      const bytes = body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : body;
      puts.set(this.url, bytes);
      this.upload.onprogress?.({ loaded: bytes.length });
      this.status = 200;
      this.onload();
    });
  }
}

let nextUpload = 1;
beforeEach(() => {
  puts = new Map();
  failing = new Map();
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  vi.useFakeTimers({ toFake: ['setTimeout'], shouldAdvanceTime: true, advanceTimeDelta: 1000 });
  api.get.mockImplementation(async (url, { params }) => {
    const n = nextUpload++;
    return { data: { uploadUrl: `https://put.test/${n}`, fileUrl: `https://s3.test/uploads/file${n}.bin`, size: params.size } };
  });
  api.post.mockImplementation(async (url, body) => {
    if (url === '/upload_file/multipart') {
      return {
        data: { name: 'big.bin', fileUrl: 'https://s3.test/uploads/big.bin', partSize: PART_BYTES, partCount: Math.ceil(body.size / PART_BYTES) },
      };
    }
    const part = /\/parts\/(\d+)$/.exec(url);
    if (part) return { data: { url: `https://part.test/${part[1]}` } };
    return { data: {} };
  });
  api.delete.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('uploadAttachment', () => {
  it('sends a small file in one request, encrypted in chunks, with its thumbnail', async () => {
    const plain = randomBytes(1000);
    const progress = [];
    const url = await uploadAttachment(
      new File([plain], 'cat.png', { type: 'image/png' }),
      (bytes) => progress.push(bytes),
      { width: 10, height: 20, thumbnail: new Blob([new Uint8Array([7, 8])]) },
    );
    const meta = parseAttachmentUrl(url);
    expect(meta).toMatchObject({ version: 2, type: 'image/png', size: 1000, width: 10, height: 20 });
    expect(api.post).not.toHaveBeenCalled();
    const stored = [...puts.values()];
    expect(stored).toHaveLength(2); // the thumbnail, then the file
    expect(await decryptChunkedAttachment(stored[1].buffer, meta.key, meta.nonce, 1000)).toEqual(plain);
    expect(new Uint8Array(await decryptPoster(stored[0].buffer, meta.key))).toEqual(new Uint8Array([7, 8]));
    expect(meta.posterUrl).toBe('https://s3.test/uploads/file1.bin');
    expect(progress.at(-1)).toBe(encryptedSize(1000));
  });

  it('sends a big file in parts that put back together decrypt to it, retrying a failed part', async () => {
    const size = 2 * 32 * CHUNK_SIZE + 5000; // three parts
    const plain = randomBytes(size);
    failing.set('https://part.test/2', 1);
    const progress = [];
    const url = await uploadAttachment(new File([plain], 'film.mp4', { type: 'video/mp4' }), (bytes) => progress.push(bytes), {
      width: 640, height: 360, duration: 12.3,
    });
    const meta = parseAttachmentUrl(url);
    expect(meta).toMatchObject({ version: 2, fileUrl: 'https://s3.test/uploads/big.bin', size, duration: 12.3 });
    expect(api.post).toHaveBeenCalledWith('/upload_file/multipart', { type: 'application/octet-stream', size: encryptedSize(size) });
    expect(api.post).toHaveBeenCalledWith('/upload_file/multipart/big.bin/complete');
    const parts = [1, 2, 3].map((n) => puts.get(`https://part.test/${n}`));
    expect(parts.every(Boolean)).toBe(true);
    expect(parts.map((p) => p.length)).toEqual([PART_BYTES, PART_BYTES, encryptedSize(size) - 2 * PART_BYTES]);
    const stored = new Uint8Array(await new Blob(parts).arrayBuffer());
    const back = await decryptChunkedAttachment(stored.buffer, meta.key, meta.nonce, size);
    expect(sameBytes(new Uint8Array(back), plain)).toBe(true);
    expect(progress.at(-1)).toBe(encryptedSize(size));
    expect(api.delete).not.toHaveBeenCalled();
  }, 30_000);

  it('abandons the upload when a part keeps failing', async () => {
    failing.set('https://part.test/1', 99);
    await expect(uploadAttachment(new File([randomBytes(20 * 1024 * 1024)], 'big.zip'))).rejects.toThrow();
    expect(api.delete).toHaveBeenCalledWith('/upload_file/multipart/big.bin');
    expect(api.post).not.toHaveBeenCalledWith('/upload_file/multipart/big.bin/complete');
  }, 30_000);
});

describe('maxAttachmentBytes', () => {
  it('leaves room for the encryption within the limit', () => {
    const limit = 500 * 1024 * 1024;
    expect(encryptedSize(maxAttachmentBytes(limit))).toBeLessThanOrEqual(limit);
    expect(maxAttachmentBytes(limit)).toBeGreaterThan(limit - CHUNK_SIZE - 64 * 1024);
  });
});
