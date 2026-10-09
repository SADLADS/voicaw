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

let searchIndex;
let privacy;

beforeEach(async () => {
  vi.resetModules();
  storage.clear();
  await new Promise((resolve) => { indexedDB.deleteDatabase('voicaw-search').onsuccess = resolve; });
  privacy = await import('../utils/privacy');
  searchIndex = await import('./searchIndex');
});

// A conversation the "server" holds: rows with ids, and a source over it as a chat hook gives.
function conversation(count, { key = 'u1/dm/2', text = (i) => `message number ${i}` } = {}) {
  const rows = [];
  let nextId = 1;
  const add = (body, extra = {}) => {
    // Ids are shared with other conversations on the server: leave holes.
    nextId += 1 + (nextId % 3);
    const row = { id: nextId, sender_id: nextId % 2 ? 1 : 2, timestamp: 1000 + nextId, body, edited_at: null, ...extra };
    rows.push(row);
    return row;
  };
  for (let i = 1; i <= count; i += 1) add(text(i));
  const calls = { pages: 0, decrypted: 0 };
  const source = {
    key,
    async fetchPage(before, limit) {
      calls.pages += 1;
      return rows.filter((r) => before == null || r.id < before).sort((a, b) => b.id - a.id).slice(0, limit).reverse();
    },
    async toEntries(page) {
      calls.decrypted += page.length;
      return page.filter((r) => !r.system).map((r) => ({ i: r.id, s: r.sender_id, t: r.timestamp, p: r.body }));
    },
    async fetchRanges(ranges) {
      return ranges.map(([from, to]) => {
        const inside = rows.filter((r) => r.id >= from && r.id <= to);
        return { rows: inside.length, edited: inside.reduce((m, r) => Math.max(m, r.edited_at ?? 0), 0) };
      });
    },
  };
  return { rows, add, source, calls };
}

const search = (source, content, options) => searchIndex.searchConversation(source, { content }, options);

describe('searchIndex', () => {
  it('finds words by prefix, phrases exactly, newest or oldest first, and counts them all', async () => {
    const chat = conversation(450, { text: (i) => (i % 50 === 0 ? `Café meeting ${i}` : `hello ${i}`) });
    const result = await search(chat.source, 'cafe meet', { limit: 3 });
    expect(result.total).toBe(9);
    expect(result.messages.map((m) => m.plaintext)).toEqual(['Café meeting 450', 'Café meeting 400', 'Café meeting 350']);
    const oldest = await search(chat.source, '"café meeting"', { sort: 'asc', limit: 2 });
    expect(oldest.messages.map((m) => m.plaintext)).toEqual(['Café meeting 50', 'Café meeting 100']);
    expect((await search(chat.source, '"cafe meet"')).total).toBe(0);
    expect(Object.keys(result.messages[0]).sort()).toEqual(['id', 'plaintext', 'reactions', 'sender_id', 'timestamp']);
  });

  it('reads the history once, then only what is new', async () => {
    const chat = conversation(450);
    await search(chat.source, 'number');
    const read = chat.calls.decrypted;
    expect(read).toBe(450);
    chat.add('a new arrival');
    const result = await search(chat.source, 'arrival');
    expect(result.total).toBe(1);
    expect(chat.calls.decrypted - read).toBe(1);
  });

  it('drops deleted messages and finds edits made since', async () => {
    const chat = conversation(450);
    expect((await search(chat.source, '"number 7"')).total).toBe(1);
    chat.rows.splice(chat.rows.findIndex((r) => r.body === 'message number 7'), 1);
    const edited = chat.rows.find((r) => r.body === 'message number 300');
    edited.body = 'rewritten';
    edited.edited_at = 5000;
    const before = chat.calls.decrypted;
    expect((await search(chat.source, '"number 7"')).total).toBe(0);
    expect((await search(chat.source, 'rewritten')).total).toBe(1);
    expect((await search(chat.source, '"number 300"')).total).toBe(0);
    // Only the two changed ranges were read again.
    expect(chat.calls.decrypted - before).toBeLessThanOrEqual(400);
  });

  it('reads a changed range again when it was the only one, or the newest', async () => {
    const chat = conversation(30);
    expect((await search(chat.source, 'number')).total).toBe(30);
    chat.rows.splice(0, 1);
    expect((await search(chat.source, 'number')).total).toBe(29);
    const big = conversation(450);
    await search(big.source, 'number');
    big.rows.at(-1).body = 'changed';
    big.rows.at(-1).edited_at = 9;
    expect((await search(big.source, 'number')).total).toBe(449);
    expect((await search(big.source, 'changed')).total).toBe(1);
  });

  it('carries on where an interrupted read stopped', async () => {
    const chat = conversation(900);
    const controller = new AbortController();
    const fetchPage = chat.source.fetchPage;
    let pages = 0;
    chat.source.fetchPage = async (...args) => {
      pages += 1;
      if (pages === 4) controller.abort();
      return fetchPage(...args);
    };
    await expect(search(chat.source, 'number', { signal: controller.signal })).rejects.toThrow();
    chat.source.fetchPage = fetchPage;
    const read = chat.calls.decrypted;
    const result = await search(chat.source, 'number');
    expect(result.total).toBe(900);
    expect(chat.calls.decrypted - read).toBeLessThan(900);
  });

  it('skips rows it cannot read but still counts them for changes', async () => {
    const chat = conversation(10);
    chat.add('call', { system: 'call' });
    chat.add('after the call');
    expect((await search(chat.source, 'call')).total).toBe(1);
    expect((await search(chat.source, 'call')).total).toBe(1);
  });

  it('keeps nothing readable on the disk', async () => {
    const chat = conversation(5, { text: () => 'secret plans' });
    await search(chat.source, 'plans');
    const db = await new Promise((resolve) => { indexedDB.open('voicaw-search').onsuccess = (e) => resolve(e.target.result); });
    const all = await new Promise((resolve) => { db.transaction('segments').objectStore('segments').getAll().onsuccess = (e) => resolve(e.target.result); });
    db.close();
    expect(all.length).toBe(1);
    expect(new TextDecoder().decode(all[0].data)).not.toContain('secret');
  });

  it('keeps no copy with the setting off, reading everything each time', async () => {
    privacy.setPrivacyPref('searchCopy', false);
    const chat = conversation(250, { text: (i) => (i % 100 === 0 ? `ping ${i}` : `x ${i}`) });
    expect((await search(chat.source, 'ping', { sort: 'asc', limit: 1 })).messages.map((m) => m.plaintext)).toEqual(['ping 100']);
    expect((await search(chat.source, 'ping')).messages.map((m) => m.plaintext)).toEqual(['ping 200', 'ping 100']);
    expect(chat.calls.decrypted).toBe(500);
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain('voicaw-search');
  });

  it('keeps conversations apart, and forgets them all on clearing', async () => {
    const a = conversation(3, { key: 'u1/dm/2', text: () => 'apple' });
    const b = conversation(3, { key: 'u1/group/x', text: () => 'banana' });
    expect((await search(a.source, 'banana')).total).toBe(0);
    expect((await search(b.source, 'banana')).total).toBe(3);
    await searchIndex.clearSearchIndex();
    const read = a.calls.decrypted;
    expect((await search(a.source, 'apple')).total).toBe(3);
    expect(a.calls.decrypted - read).toBe(3);
  });

  it('filters by author, mention and has:', async () => {
    const chat = conversation(0);
    chat.add('hi <@7> look https://example.com');
    chat.add('![photo.png](https://s3/x#v=1&k=abc&t=image/png)');
    chat.add('poll:v1:{"q":"Lunch?","o":[{"id":"aaaa1111","t":"Pizza"}]}');
    const run = (params) => searchIndex.searchConversation(chat.source, params);
    expect((await run({ mentions: [7] })).total).toBe(1);
    expect((await run({ has: ['link'] })).total).toBe(1);
    expect((await run({ has: ['image', 'file'] })).total).toBe(1);
    expect((await run({ content: 'photo' })).total).toBe(1);
    expect((await run({ content: 'abc' })).total).toBe(0);
    expect((await run({ content: 'pizza', has: ['poll'] })).total).toBe(1);
    expect((await run({ author_id: [chat.rows[0].sender_id] })).messages.every((m) => m.sender_id === chat.rows[0].sender_id)).toBe(true);
  });
});
