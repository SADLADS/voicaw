import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Node environment (WebCrypto), with a stub localStorage for the privacy setting.
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
};

let copy;
let privacy;

beforeEach(async () => {
  vi.resetModules();
  storage.clear();
  await new Promise((resolve) => { indexedDB.deleteDatabase('voicaw-offline').onsuccess = resolve; });
  privacy = await import('../utils/privacy');
  copy = await import('./offlineCopy');
});

const CHAT = 'u1/dm/2';
const message = (id, extra = {}) => ({ id, sender_id: 1, timestamp: id, plaintext: `message ${id}`, reactions: [], ...extra });
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => message(from + i));
const ids = (result) => result.messages.map((m) => m.id);

describe('offline copy of a chat', () => {
  it('gives back what was shown, newest first in pages, without the ciphertext', async () => {
    await copy.saveChat(CHAT, range(1, 120).map((m) => ({ ...m, content: 'v1.secret', status: 'sent' })));
    const newest = await copy.loadChat(CHAT, { limit: 50 });
    expect(ids(newest)).toEqual(range(71, 120).map((m) => m.id));
    expect(newest.hasMore).toBe(true);
    expect(newest.messages[0]).toEqual(message(71));
    const older = await copy.loadChat(CHAT, { before: 71, limit: 50 });
    expect(ids(older)).toEqual(range(21, 70).map((m) => m.id));
    const oldest = await copy.loadChat(CHAT, { before: 21, limit: 50 });
    expect(ids(oldest)).toEqual(range(1, 20).map((m) => m.id));
    expect(oldest.hasMore).toBe(false);
    expect(oldest.complete).toBe(false);
  });

  it('says when the start of the conversation is saved', async () => {
    await copy.saveChat(CHAT, range(5, 9), { complete: true });
    expect((await copy.loadChat(CHAT)).complete).toBe(true);
  });

  it('is null for a chat never saved', async () => {
    expect(await copy.loadChat(CHAT)).toBeNull();
  });

  it('skips messages still being sent', async () => {
    await copy.saveChat(CHAT, [...range(1, 3), { id: 'temp-1', plaintext: 'sending' }]);
    expect(ids(await copy.loadChat(CHAT))).toEqual([1, 2, 3]);
  });

  it('follows edits and deletes in what the chat shows', async () => {
    let shown = range(1, 10);
    let previous = await copy.saveChat(CHAT, shown);
    shown = shown.filter((m) => m.id !== 4).map((m) => (m.id === 6 ? { ...m, plaintext: 'edited' } : m));
    previous = await copy.saveChat(CHAT, shown, { previous });
    const saved = await copy.loadChat(CHAT);
    expect(ids(saved)).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10]);
    expect(saved.messages.find((m) => m.id === 6).plaintext).toBe('edited');
    expect(previous.get(6)).toBe(shown[4]);
  });

  it('keeps older parts saved before, and drops what was deleted since in the part shown', async () => {
    await copy.saveChat(CHAT, range(1, 100));
    // Opened again later: only the newest are shown, and 95 was deleted meanwhile.
    await copy.saveChat(CHAT, [...range(91, 94), ...range(96, 110)]);
    const newest = await copy.loadChat(CHAT, { limit: 200 });
    expect(newest.messages).toHaveLength(109);
    expect(ids(newest)).not.toContain(95);
  });

  it('never passes over a gap: offline, only the newest run shows', async () => {
    await copy.saveChat(CHAT, range(1, 20));
    // Opened again much later: the newest page doesn't reach what was saved before.
    await copy.saveChat(CHAT, range(500, 520));
    const newest = await copy.loadChat(CHAT, { limit: 50 });
    expect(ids(newest)).toEqual(range(500, 520).map((m) => m.id));
    expect(newest.hasMore).toBe(false);
  });

  it('drops older parts the server says changed', async () => {
    await copy.saveChat(CHAT, range(1, 500));
    // Now open with only 401-500 shown; in 1-200 something was deleted, in 201-400 nothing.
    await copy.saveChat(CHAT, range(401, 500));
    const fetchRanges = vi.fn(async (ranges) => ranges.map(([f, t]) => ({ rows: f === 1 ? t - f : t - f + 1, edited: 0 })));
    await copy.checkChat(CHAT, 401, fetchRanges);
    expect(fetchRanges).toHaveBeenCalledWith([[1, 200], [201, 400]]);
    const all = await copy.loadChat(CHAT, { limit: 1000 });
    expect(ids(all)[0]).toBe(201);
    expect(all.messages).toHaveLength(300);
  });

  it('drops older parts edited since', async () => {
    await copy.saveChat(CHAT, range(1, 300).map((m) => ({ ...m, edited_at: m.id === 10 ? 50 : null })));
    await copy.checkChat(CHAT, 201, async (ranges) => ranges.map(() => ({ rows: 200, edited: 60 })));
    const all = await copy.loadChat(CHAT, { limit: 1000 });
    expect(ids(all)[0]).toBe(201);
  });

  it('keeps nothing with the setting off', async () => {
    privacy.setPrivacyPref('offlineCopy', false);
    await copy.saveChat(CHAT, range(1, 3));
    await copy.saveDoc(1, '/dms-list', [{ id: 2 }]);
    expect(await copy.loadChat(CHAT)).toBeNull();
    expect(await copy.loadDoc(1, '/dms-list')).toBeUndefined();
  });

  it('keeps lists per account', async () => {
    await copy.saveDoc(1, '/dms-list', [{ id: 2 }]);
    expect(await copy.loadDoc(1, '/dms-list')).toEqual([{ id: 2 }]);
    expect(await copy.loadDoc(3, '/dms-list')).toBeUndefined();
  });

  it('counts its size and forgets everything when cleared', async () => {
    await copy.saveChat(CHAT, range(1, 10));
    await copy.saveDoc(1, '/profile', { id: 1 });
    const size = await copy.offlineCopySize();
    expect(size.messages).toBe(10);
    expect(size.chats).toBe(1);
    expect(size.bytes).toBeGreaterThan(0);
    await copy.clearOfflineCopy();
    expect(await copy.loadChat(CHAT)).toBeNull();
    expect(await copy.loadDoc(1, '/profile')).toBeUndefined();
    expect((await copy.offlineCopySize()).messages).toBe(0);
  });

  it('stores no message in the clear', async () => {
    await copy.saveChat(CHAT, [message(1, { plaintext: 'very secret words' })]);
    const db = await new Promise((resolve) => { indexedDB.open('voicaw-offline').onsuccess = (e) => resolve(e.target.result); });
    const records = await new Promise((resolve) => { db.transaction('messages').objectStore('messages').getAll().onsuccess = (e) => resolve(e.target.result); });
    db.close();
    expect(new TextDecoder().decode(records[0].data)).not.toContain('secret');
  });
});
