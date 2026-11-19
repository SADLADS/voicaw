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
  encryptDmMessage,
  openDmMessage,
  messageMisplaced,
  markRepeatedMessages,
  MESSAGE_TIME_TOLERANCE_S,
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

describe('message headers (v2 DMs)', () => {
  const now = () => Math.floor(Date.now() / 1000);

  it('carry a random id, the time, the reply and the edited message, inside the encryption', async () => {
    const { aliceKey, bobKey } = await conversationKeys();
    const envelope = await encryptDmMessage('line one\nline two', aliceKey, dmContext(1, 2), { replyTo: 7 });
    expect(envelope.startsWith('v2.')).toBe(true);
    const { text, sent } = await openDmMessage(envelope, bobKey, dmContext(1, 2));
    expect(text).toBe('line one\nline two');
    expect(sent).toMatchObject({ replyTo: 7, editOf: null });
    expect(sent.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(Math.abs(sent.at - now())).toBeLessThan(5);
    await expect(openDmMessage(envelope, bobKey, dmContext(2, 1))).rejects.toThrow();
    // A v1 message has no header.
    const old = await encryptMessage('older', aliceKey, dmContext(1, 2));
    expect(await openDmMessage(old, bobKey, dmContext(1, 2))).toEqual({ text: 'older', sent: null });
    // The version is in the additional data: it can't be read as a v1 message.
    await expect(decryptMessage(`v1.${envelope.slice(3)}`, bobKey, dmContext(1, 2))).rejects.toThrow();
  });

  it('show when the server moves a message, points a reply elsewhere, or passes one off as an edit', async () => {
    const t = now();
    const sent = { id: 'AAAAAAAAAAAAAAAA', at: t, replyTo: 7, editOf: null };
    const row = { id: 20, parent_message_id: 7, edited: 0, timestamp: t + 30 };
    expect(messageMisplaced(sent, row)).toBe(false);
    expect(messageMisplaced(null, row)).toBe(false); // older envelope: nothing to check
    expect(messageMisplaced(sent, { ...row, parent_message_id: 8 })).toBe(true);
    expect(messageMisplaced(sent, { ...row, parent_message_id: null })).toBe(true);
    // An old message delivered again as new.
    expect(messageMisplaced(sent, { ...row, timestamp: t + MESSAGE_TIME_TOLERANCE_S + 60 })).toBe(true);
    // A message shown as another's edit, or an edit shown as an original.
    expect(messageMisplaced(sent, { ...row, edited: 1, edited_at: t })).toBe(true);
    const edit = { ...sent, editOf: 20 };
    expect(messageMisplaced(edit, { ...row, edited: 1, edited_at: t + 10 })).toBe(false);
    expect(messageMisplaced(edit, { ...row, id: 21, edited: 1, edited_at: t })).toBe(true);
    expect(messageMisplaced(edit, row)).toBe(true);
    // A live edit, checked against now.
    expect(messageMisplaced(edit, { ...row, edited: 1 }, { now: t })).toBe(false);
  });

  it('mark the same message delivered twice', async () => {
    const { aliceKey } = await conversationKeys();
    const envelope = await encryptDmMessage('pay me', aliceKey, dmContext(1, 2));
    const t = now();
    const rows = await decryptMessagesBatch([
      { id: 30, sender_id: 1, recipient_id: 2, content: envelope, timestamp: t },
      { id: 31, sender_id: 1, recipient_id: 2, content: envelope, timestamp: t },
    ], aliceKey);
    expect(rows.map((r) => Boolean(r.misplaced))).toEqual([false, true]);
    // Across pages, against what's already shown.
    expect(markRepeatedMessages([rows[0]], new Map([[rows[0].sent_id, 29]]))[0].misplaced).toBe(true);
  });
});

describe('reactions', () => {
  it('round-trips between the two people, always at the same length', async () => {
    const { aliceKey, bobKey } = await conversationKeys();
    const ctx = reactionContext(7, 2, 1, 2);

    const short = await encryptReaction('👍', bobKey, ctx);
    const long = await encryptReaction('👨🏽‍👩🏽‍👧🏽', bobKey, ctx);
    expect(short).toHaveLength(723);
    expect(long).toHaveLength(723);
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
    await expect(encryptReaction('a'.repeat(513), aliceKey, 'x')).rejects.toThrow();
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
