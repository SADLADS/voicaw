import { describe, it, expect } from 'vitest';
import {
  generateUserKeys,
  verifyEncryptionKey,
  wrapKeyBackup,
  unwrapKeyBackup,
  importEncryptionPrivateKey,
  deriveConversationKey,
  deriveNotesKey,
  dmContext,
  encryptMessage,
  decryptMessage,
  decryptMessagesBatch,
  encryptReaction,
  decryptReaction,
  reactionContext,
  toBase64,
  generateCallKey,
  callKeyContext,
  encryptCallKey,
  decryptCallKey,
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

  it('notes: only your own key pair opens them, and their key is no DM key', async () => {
    const alice = await generateUserKeys();
    const mallory = await generateUserKeys();
    const alicePrivate = await importEncryptionPrivateKey(alice.private.encryptionKey);
    const notesKey = await deriveNotesKey(alicePrivate, alice.public.encryptionKey);
    const envelope = await encryptMessage('my note', notesKey, dmContext(1, 1));

    // Same derivation later (another device, after logging in again) opens it.
    const again = await deriveNotesKey(await importEncryptionPrivateKey(alice.private.encryptionKey), alice.public.encryptionKey);
    expect(await decryptMessage(envelope, again, dmContext(1, 1))).toBe('my note');

    // A DM key from the same ECDH (a DM to yourself) is a different key.
    const dmKey = await deriveConversationKey(alicePrivate, alice.public.encryptionKey);
    await expect(decryptMessage(envelope, dmKey, dmContext(1, 1))).rejects.toThrow();

    // Someone else, even with Alice's public key, derives something else.
    const malloryKey = await deriveNotesKey(await importEncryptionPrivateKey(mallory.private.encryptionKey), alice.public.encryptionKey);
    await expect(decryptMessage(envelope, malloryKey, dmContext(1, 1))).rejects.toThrow();
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

describe('reactions', () => {
  it('round-trips between the two people, always at the same length', async () => {
    const { aliceKey, bobKey } = await conversationKeys();
    const ctx = reactionContext(7, 2, 1, 2);

    const short = await encryptReaction('👍', bobKey, ctx);
    const long = await encryptReaction('👨🏽‍👩🏽‍👧🏽', bobKey, ctx);
    expect(short).toHaveLength(383);
    expect(long).toHaveLength(383);
    expect(await decryptReaction(short, aliceKey, ctx)).toBe('👍');
    expect(await decryptReaction(long, aliceKey, ctx)).toBe('👨🏽‍👩🏽‍👧🏽');
  });

  it("can't be moved to another message or re-attributed", async () => {
    const { aliceKey, bobKey } = await conversationKeys();
    const envelope = await encryptReaction('❤️', bobKey, reactionContext(7, 2, 1, 2));

    await expect(decryptReaction(envelope, aliceKey, reactionContext(8, 2, 1, 2))).rejects.toThrow();
    await expect(decryptReaction(envelope, aliceKey, reactionContext(7, 1, 1, 2))).rejects.toThrow();
  });

  it('rejects empty or oversized reactions', async () => {
    const { aliceKey } = await conversationKeys();
    await expect(encryptReaction('', aliceKey, 'x')).rejects.toThrow();
    await expect(encryptReaction('a'.repeat(257), aliceKey, 'x')).rejects.toThrow();
  });

  it('are decrypted with their messages', async () => {
    const { aliceKey, bobKey } = await conversationKeys();
    const msg = { id: 5, sender_id: 1, recipient_id: 2, content: await encryptMessage('hi', aliceKey, dmContext(1, 2)) };
    msg.reactions = [
      { id: 1, user_id: 2, content: await encryptReaction('😂', bobKey, reactionContext(5, 2, 1, 2)) },
      { id: 2, user_id: 2, content: await encryptReaction('😂', bobKey, reactionContext(6, 2, 1, 2)) },
    ];

    const [out] = await decryptMessagesBatch([msg], aliceKey);
    expect(out.reactions).toEqual([{ id: 1, user_id: 2, emoji: '😂' }]);
  });
});

describe('call keys', () => {
  it('reach the other person, and only for that call and those roles', async () => {
    const { aliceKey, bobKey } = await conversationKeys();
    const key = generateCallKey();
    expect(key).toHaveLength(32);
    const envelope = await encryptCallKey(key, aliceKey, callKeyContext('call-1', 1, 2));
    expect(envelope.length).toBeLessThan(200); // the server's limit
    expect(await decryptCallKey(envelope, bobKey, callKeyContext('call-1', 1, 2))).toEqual(key);

    // The server can't reuse it for another call, or swap who's calling whom.
    await expect(decryptCallKey(envelope, bobKey, callKeyContext('call-2', 1, 2))).rejects.toThrow();
    await expect(decryptCallKey(envelope, bobKey, callKeyContext('call-1', 2, 1))).rejects.toThrow();
  });

  it('are different every call', () => {
    expect(generateCallKey()).not.toEqual(generateCallKey());
  });
});
