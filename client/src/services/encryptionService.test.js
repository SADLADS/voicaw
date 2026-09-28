import { describe, it, expect } from 'vitest';
import {
  generateUserKeys,
  verifyEncryptionKey,
  wrapKeyBackup,
  unwrapKeyBackup,
  importEncryptionPrivateKey,
  deriveConversationKey,
  dmContext,
  encryptMessage,
  decryptMessage,
  decryptMessagesBatch,
  toBase64,
} from './encryptionService';

const randomExportKey = () => toBase64(crypto.getRandomValues(new Uint8Array(64)));

async function conversationKeys() {
  const alice = await generateUserKeys();
  const bob = await generateUserKeys();
  const aliceKey = await deriveConversationKey(await importEncryptionPrivateKey(alice.private.encryptionKey), bob.public.encryptionKey);
  const bobKey = await deriveConversationKey(await importEncryptionPrivateKey(bob.private.encryptionKey), alice.public.encryptionKey);
  return { alice, bob, aliceKey, bobKey };
}

describe('user keys', () => {
  it('generates an identity key that signs the encryption key', async () => {
    const keys = await generateUserKeys();

    expect(Object.keys(keys.public).sort()).toEqual(['encryptionKey', 'encryptionKeySignature', 'identityKey']);
    expect(await verifyEncryptionKey(keys.public)).toBe(true);
  });

  it('rejects an encryption key signed by someone else, or swapped in', async () => {
    const alice = await generateUserKeys();
    const mallory = await generateUserKeys();

    expect(await verifyEncryptionKey({ ...alice.public, encryptionKey: mallory.public.encryptionKey })).toBe(false);
    expect(await verifyEncryptionKey({ ...mallory.public, identityKey: alice.public.identityKey })).toBe(false);
    expect(await verifyEncryptionKey({ ...alice.public, encryptionKeySignature: 'AAAA' })).toBe(false);
  });
});

describe('key backup', () => {
  it('round-trips the keys with the same exportKey', async () => {
    const keys = await generateUserKeys();
    const exportKey = randomExportKey();

    const backup = await wrapKeyBackup(exportKey, keys);
    expect(JSON.parse(backup).v).toBe(1);
    expect(backup).not.toContain(keys.private.encryptionKey);

    expect(await unwrapKeyBackup(exportKey, backup)).toEqual({ public: keys.public, private: keys.private });
  });

  it('cannot be opened with another exportKey (wrong password) or if tampered with', async () => {
    const keys = await generateUserKeys();
    const exportKey = randomExportKey();
    const backup = await wrapKeyBackup(exportKey, keys);

    await expect(unwrapKeyBackup(randomExportKey(), backup)).rejects.toThrow();

    const parsed = JSON.parse(backup);
    const ct = Uint8Array.from(atob(parsed.ct), (c) => c.charCodeAt(0));
    ct[5] ^= 1;
    await expect(unwrapKeyBackup(exportKey, JSON.stringify({ ...parsed, ct: toBase64(ct) }))).rejects.toThrow();
    await expect(unwrapKeyBackup(exportKey, JSON.stringify({ ...parsed, v: 2 }))).rejects.toThrow(/version/);
  });

  it('accepts OPAQUE-style base64url export keys', async () => {
    const keys = await generateUserKeys();
    const exportKey = toBase64(crypto.getRandomValues(new Uint8Array(64))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const backup = await wrapKeyBackup(exportKey, keys);
    expect((await unwrapKeyBackup(exportKey, backup)).private).toEqual(keys.private);
  });
});

describe('direct messages', () => {
  it('both people derive the same conversation key', async () => {
    const { aliceKey, bobKey } = await conversationKeys();
    const envelope = await encryptMessage('hi bob', aliceKey, dmContext(1, 2));

    expect(envelope.startsWith('v1.')).toBe(true);
    expect(await decryptMessage(envelope, bobKey, dmContext(1, 2))).toBe('hi bob');
  });

  it('binds sender and recipient: a message cannot be passed off as from the other person', async () => {
    const { aliceKey, bobKey } = await conversationKeys();
    const fromAlice = await encryptMessage('I owe you £100', aliceKey, dmContext(1, 2));

    await expect(decryptMessage(fromAlice, bobKey, dmContext(2, 1))).rejects.toThrow();
    await expect(decryptMessage(fromAlice, bobKey, dmContext(1, 3))).rejects.toThrow();
  });

  it('a third party derives a different key and cannot decrypt', async () => {
    const { alice, aliceKey } = await conversationKeys();
    const mallory = await generateUserKeys();
    const malloryKey = await deriveConversationKey(await importEncryptionPrivateKey(mallory.private.encryptionKey), alice.public.encryptionKey);
    const envelope = await encryptMessage('secret', aliceKey, dmContext(1, 2));

    await expect(decryptMessage(envelope, malloryKey, dmContext(1, 2))).rejects.toThrow();
  });

  it('rejects unversioned or unknown formats', async () => {
    const { aliceKey } = await conversationKeys();
    await expect(decryptMessage('AAAA', aliceKey, dmContext(1, 2))).rejects.toThrow(/format/);
    await expect(decryptMessage('v2.AAAA', aliceKey, dmContext(1, 2))).rejects.toThrow(/format/);
  });

  it('decrypts pages including replies in either direction', async () => {
    const { aliceKey, bobKey } = await conversationKeys();
    const q = await encryptMessage('question?', aliceKey, dmContext(1, 2));
    const a = await encryptMessage('answer', bobKey, dmContext(2, 1));

    const rows = [
      { id: 10, sender_id: 1, recipient_id: 2, content: q },
      { id: 11, sender_id: 2, recipient_id: 1, content: a, parent_message_id: 10, parent_content: q, parent_sender_id: 1 },
      { id: 12, sender_id: 1, recipient_id: 2, content: 'garbage' },
    ];
    const out = await decryptMessagesBatch(rows, aliceKey);

    expect(out.map((m) => m.plaintext)).toEqual(['question?', 'answer', null]);
    expect(out[1].parent_plaintext).toBe('question?');
  });
});
