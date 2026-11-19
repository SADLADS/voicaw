import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadDecryptedAttachment, MAX_DOWNLOAD_BYTES } from './attachmentCache';

afterEach(() => vi.unstubAllGlobals());

const meta = (fields) => ({ version: 2, fileUrl: 'https://s3.test/uploads/a.bin', key: 'KEY', nonce: 'AAAAAAAAAAAAAAAA', type: 'image/png', ...fields });

describe('loadDecryptedAttachment: sizes it trusts', () => {
  it("refuses a file whose sender claims it's bigger than any file can be, without downloading", async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(loadDecryptedAttachment('https://s3.test/uploads/huge.bin#v=2', meta({ size: 4 * 1024 ** 3 }))).rejects.toThrow(/too big/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses one the server says is bigger, before reading it", async () => {
    const cancel = vi.fn(async () => {});
    const body = { getReader: () => ({ read: vi.fn(), cancel }) };
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, body, headers: new Headers({ 'Content-Length': String(MAX_DOWNLOAD_BYTES + 1) }),
    })));
    await expect(loadDecryptedAttachment('https://s3.test/uploads/big.bin#v=1', meta({ version: 1, size: null }))).rejects.toThrow(/too big/);
    expect(body.getReader().read).not.toHaveBeenCalled();
  });

  it('stops a download without a length once it goes past the limit', async () => {
    const chunk = new Uint8Array(64 * 1024 * 1024);
    let sent = 0;
    const cancel = vi.fn(async () => {});
    const reader = {
      read: vi.fn(async () => {
        sent += chunk.length;
        return sent > MAX_DOWNLOAD_BYTES + chunk.length * 2 ? { done: true } : { done: false, value: chunk };
      }),
      cancel,
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body: { getReader: () => reader }, headers: new Headers() })));
    await expect(loadDecryptedAttachment('https://s3.test/uploads/endless.bin#v=1', meta({ version: 1, size: null }))).rejects.toThrow(/too big/);
    expect(cancel).toHaveBeenCalled();
  });
});
