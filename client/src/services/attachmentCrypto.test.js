import { describe, it, expect } from 'vitest';
import {
  encryptAttachment,
  decryptAttachment,
  buildAttachmentUrl,
  parseAttachmentUrl,
  ENCRYPTION_OVERHEAD_BYTES,
} from './attachmentCrypto';

describe('attachmentCrypto', () => {
  it('round-trips a file through encrypt/decrypt with the key from the URL', async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(5000));
    const file = new File([bytes], 'photo.png', { type: 'image/png' });

    const { blob, key } = await encryptAttachment(file);
    expect(blob.type).toBe('application/octet-stream');
    expect(blob.size).toBe(file.size + ENCRYPTION_OVERHEAD_BYTES);

    const url = buildAttachmentUrl('https://s3.test/uploads/abc.bin', { key, type: file.type, size: file.size });
    const meta = parseAttachmentUrl(url);
    expect(meta).toEqual({
      fileUrl: 'https://s3.test/uploads/abc.bin', key, type: 'image/png', size: 5000, width: null, height: null, spoiler: false,
    });

    const plain = await decryptAttachment(await blob.arrayBuffer(), meta.key);
    expect(new Uint8Array(plain)).toEqual(bytes);
  });

  it('uses a different key and ciphertext for every upload of the same file', async () => {
    const file = new File(['same contents'], 'a.txt', { type: 'text/plain' });
    const a = await encryptAttachment(file);
    const b = await encryptAttachment(file);

    expect(a.key).not.toBe(b.key);
    expect(new Uint8Array(await a.blob.arrayBuffer())).not.toEqual(new Uint8Array(await b.blob.arrayBuffer()));
  });

  it('fails to decrypt with the wrong key or tampered data', async () => {
    const file = new File(['secret'], 'a.txt', { type: 'text/plain' });
    const { blob, key } = await encryptAttachment(file);
    const { key: otherKey } = await encryptAttachment(file);
    const encrypted = new Uint8Array(await blob.arrayBuffer());

    await expect(decryptAttachment(encrypted, otherKey)).rejects.toThrow();

    encrypted[encrypted.length - 1] ^= 1;
    await expect(decryptAttachment(encrypted, key)).rejects.toThrow();
  });

  it('produces URL-safe keys of a fixed length (the composer relies on it for length checks)', async () => {
    const { key } = await encryptAttachment(new File(['x'], 'x.txt'));
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('returns null for URLs that are not encrypted attachments', () => {
    expect(parseAttachmentUrl('https://media.voicaw.com/uploads/old.png')).toBeNull();
    expect(parseAttachmentUrl('https://example.com/page#section')).toBeNull();
    expect(parseAttachmentUrl('https://s3.test/x.bin#v=2&k=abc')).toBeNull();
    expect(parseAttachmentUrl(undefined)).toBeNull();
  });

  it('defaults a missing type and tolerates a missing size', () => {
    expect(parseAttachmentUrl('https://s3.test/x.bin#v=1&k=abc')).toEqual({
      fileUrl: 'https://s3.test/x.bin',
      key: 'abc',
      type: 'application/octet-stream',
      size: null,
      width: null,
      height: null,
      spoiler: false,
    });
  });

  it('marks spoilers in the fragment, and only when asked', () => {
    const spoiler = buildAttachmentUrl('https://s3.test/x.bin', { key: 'k', type: 'image/png', size: 1, spoiler: true });
    expect(spoiler).toContain('&sp=1');
    expect(parseAttachmentUrl(spoiler)).toMatchObject({ spoiler: true, key: 'k' });

    const plain = buildAttachmentUrl('https://s3.test/x.bin', { key: 'k', type: 'image/png', size: 1 });
    expect(plain).not.toContain('sp=');
    expect(parseAttachmentUrl(plain).spoiler).toBe(false);
  });

  it('carries media dimensions when both are known, and ignores bad ones', () => {
    const withDims = buildAttachmentUrl('https://s3.test/x.bin', { key: 'k', type: 'image/png', size: 1, width: 800, height: 600 });
    expect(parseAttachmentUrl(withDims)).toMatchObject({ width: 800, height: 600 });

    const noDims = buildAttachmentUrl('https://s3.test/x.bin', { key: 'k', type: 'image/png', size: 1 });
    expect(noDims).not.toContain('w=');
    expect(parseAttachmentUrl(noDims)).toMatchObject({ width: null, height: null });

    expect(parseAttachmentUrl('https://s3.test/x.bin#v=1&k=k&w=800')).toMatchObject({ width: null, height: null });
    expect(parseAttachmentUrl('https://s3.test/x.bin#v=1&k=k&w=0&h=5')).toMatchObject({ width: null, height: null });
    expect(parseAttachmentUrl('https://s3.test/x.bin#v=1&k=k&w=-1&h=5')).toMatchObject({ width: null, height: null });
  });
});
