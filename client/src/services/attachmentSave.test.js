import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { saveAttachment, decryptedFileStream, STREAM_SAVE_MIN_BYTES } from './attachmentSave';
import { encryptChunkedAttachment } from './chunkedAttachment';
import { loadDecryptedAttachment, getCachedAttachment } from './attachmentCache';
import { canDownloadThroughWorker } from './videoStream';
import { triggerDownload } from '../utils/saveFile';
import { isAndroidApp, saveToDownloads } from '../utils/android';
import { desktop } from '../utils/desktop';

vi.mock('./attachmentCache', () => ({
  loadDecryptedAttachment: vi.fn(async () => 'blob:whole'),
  getCachedAttachment: vi.fn(() => null),
}));
vi.mock('./videoStream', () => ({
  canDownloadThroughWorker: vi.fn(async () => false),
  streamUrl: vi.fn(),
  streamStatus: vi.fn(),
  releaseStream: vi.fn(),
}));
vi.mock('../utils/saveFile', () => ({ triggerDownload: vi.fn() }));
vi.mock('../utils/android', () => ({
  isAndroidApp: vi.fn(() => false),
  saveToDownloads: vi.fn(async () => ({ opened: false })),
  showAndroidToast: vi.fn(),
}));
vi.mock('../utils/desktop', () => ({ desktop: { saveFile: null } }));

const randomBytes = (n) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
};

async function readAll(stream) {
  const pieces = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pieces.push(value);
  }
  return new Uint8Array(await new Blob(pieces).arrayBuffer());
}

// A v2 file whose download (fetch) is `stored`.
async function storedFile(plain) {
  const { blob, key, nonce } = await encryptChunkedAttachment(new Blob([plain]));
  const stored = new Uint8Array(await blob.arrayBuffer());
  vi.stubGlobal('fetch', vi.fn(async () => new Response(stored)));
  return { version: 2, fileUrl: 'https://s3.test/uploads/x.bin', key, nonce, size: plain.length, type: 'application/zip' };
}

const big = { version: 2, fileUrl: 'https://s3.test/uploads/big.bin', key: 'A'.repeat(43), nonce: 'A'.repeat(16), size: STREAM_SAVE_MIN_BYTES, type: 'video/mp4' };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(10))));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  desktop.saveFile = null;
});

describe('saveAttachment', () => {
  it('decrypts a download as it arrives', async () => {
    const plain = randomBytes(300_000);
    const meta = await storedFile(plain);
    const progress = [];
    expect(await readAll(await decryptedFileStream(meta, (f) => progress.push(f)))).toEqual(plain);
    expect(progress.at(-1)).toBe(1);
  });

  it('saves what is already decrypted straight away', async () => {
    getCachedAttachment.mockReturnValueOnce('blob:cached');
    await saveAttachment('u', big, 'film.mp4');
    expect(triggerDownload).toHaveBeenCalledWith('blob:cached', 'film.mp4');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('downloads small files and old v1 ones whole', async () => {
    await saveAttachment('u', { ...big, size: STREAM_SAVE_MIN_BYTES - 1 }, 'a.mp4');
    await saveAttachment('v', { ...big, version: 1 }, 'b.mp4');
    expect(loadDecryptedAttachment).toHaveBeenCalledTimes(2);
    expect(triggerDownload).toHaveBeenCalledWith('blob:whole', 'a.mp4');
  });

  it('saves a big one into Downloads on Android, as it decrypts', async () => {
    isAndroidApp.mockReturnValue(true);
    try {
      await saveAttachment('u', big, 'film.mp4');
    } finally {
      isAndroidApp.mockReturnValue(false);
    }
    expect(saveToDownloads).toHaveBeenCalledWith(expect.any(ReadableStream), 'film.mp4', {
      type: 'video/mp4',
      notify: { title: 'film.mp4', body: 'Download complete. Tap to open it.' },
    });
    expect(loadDecryptedAttachment).not.toHaveBeenCalled();
  });

  it('writes a big one piece by piece in the desktop app, deleting it if the download fails', async () => {
    const plain = randomBytes(STREAM_SAVE_MIN_BYTES / 64);
    const meta = await storedFile(plain);
    const written = [];
    desktop.saveFile = {
      start: vi.fn(async () => 7),
      append: vi.fn(async (id, bytes) => written.push(bytes)),
      finish: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    };
    await saveAttachment('u', { ...meta, size: plain.length }, 'a.zip').catch(() => {});
    // Small: whole, not through the desktop app.
    expect(desktop.saveFile.start).not.toHaveBeenCalled();

    // A big one whose download is cut short.
    await expect(saveAttachment('u', big, 'film.mp4')).rejects.toThrow();
    expect(desktop.saveFile.start).toHaveBeenCalledWith('film.mp4');
    expect(desktop.saveFile.cancel).toHaveBeenCalledWith(7);
    expect(desktop.saveFile.finish).not.toHaveBeenCalled();
  });

  it('does nothing when the Save dialog is cancelled', async () => {
    desktop.saveFile = { start: vi.fn(async () => null), append: vi.fn(), finish: vi.fn(), cancel: vi.fn() };
    await saveAttachment('u', big, 'film.mp4');
    expect(fetch).not.toHaveBeenCalled();
    expect(loadDecryptedAttachment).not.toHaveBeenCalled();
  });

  it('falls back to the whole file in a browser without a worker that can save', async () => {
    canDownloadThroughWorker.mockResolvedValueOnce(false);
    await saveAttachment('u', big, 'film.mp4');
    expect(loadDecryptedAttachment).toHaveBeenCalled();
  });
});
