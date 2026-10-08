// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import api from '../utils/api';
import { onEmojiUsage } from '../utils/ws-client';
import { loadEncryptionKey, loadOwnPublicKeys } from '../services/keyStore';
import {
  EMOJI_USAGE_BYTES, decryptEmojiUsage, deriveEmojiUsageKey, encryptEmojiUsage, generateUserKeys, importEncryptionPrivateKey,
} from '../services/encryptionService';
import { frequentEmojiIds, getSkinTone, recordEmojiUse, setSkinTone, startEmojiUsageSync } from './emojiUsage';

vi.mock('../utils/api', () => ({ default: { get: vi.fn(), put: vi.fn() } }));
vi.mock('../utils/ws-client', () => ({ onConnectionState: vi.fn(() => () => {}), onEmojiUsage: vi.fn(() => () => {}) }));
vi.mock('../services/keyStore', () => ({ loadEncryptionKey: vi.fn(), loadOwnPublicKeys: vi.fn() }));

const USER = 7;
let server; // what the server holds: { emojiUsage, version }
let key;

const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });
const serverUsage = () => decryptEmojiUsage(server.emojiUsage, key, USER);
const start = () => startEmojiUsageSync(USER, { saveDelay: 5 });

beforeEach(async () => {
  localStorage.clear();
  const keys = await generateUserKeys();
  const priv = await importEncryptionPrivateKey(keys.private.encryptionKey);
  loadEncryptionKey.mockResolvedValue(priv);
  loadOwnPublicKeys.mockResolvedValue({ encryptionKey: keys.public.encryptionKey });
  key = await deriveEmojiUsageKey(priv, keys.public.encryptionKey);
  server = { emojiUsage: null, version: 0 };
  api.get.mockImplementation(async () => ({ data: { ...server } }));
  api.put.mockReset();
  api.put.mockImplementation(async (url, body) => {
    if (body.version !== server.version) {
      const err = new Error('conflict');
      err.response = { status: 409, data: { ...server } };
      throw err;
    }
    server = { emojiUsage: body.emojiUsage, version: server.version + 1 };
    return { data: { ...server } };
  });
});

let stop = null;
afterEach(() => {
  stop?.();
  stop = null;
});

describe('emoji usage', () => {
  it("loads the account's, counts uses and saves them encrypted, a burst at once", async () => {
    server = { emojiUsage: await encryptEmojiUsage({ tada: 2, joy: 1 }, 4, key, USER), version: 3 };
    stop = start();
    await settle();
    expect(frequentEmojiIds()).toEqual(['tada', 'joy']);
    expect(getSkinTone()).toBe(4);

    recordEmojiUse('joy');
    recordEmojiUse('joy');
    recordEmojiUse('custom:10');
    expect(frequentEmojiIds()).toEqual(['joy', 'tada', 'custom:10']); // at once
    await settle();
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put).toHaveBeenCalledWith('/emoji-usage', expect.objectContaining({ version: 3 }));
    expect(server.emojiUsage).not.toContain('joy');
    expect(await serverUsage()).toEqual({ counts: { joy: 3, tada: 2, 'custom:10': 1 }, tone: 4 });

    setSkinTone(1);
    await settle();
    expect((await serverUsage()).tone).toBe(1);
  });

  it("is the account's, not the device's: forgotten on logging out", async () => {
    stop = start();
    await settle();
    recordEmojiUse('tada');
    setSkinTone(2);
    stop();
    stop = null;
    expect(frequentEmojiIds()).toEqual([]);
    expect(getSkinTone()).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it('is always the same size, and only opens with the same account', async () => {
    const small = await encryptEmojiUsage({ a: 1 }, undefined, key, USER);
    const big = await encryptEmojiUsage(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`emoji_${i}`, i + 1])), 3, key, USER);
    expect(small.length).toBe(big.length);
    expect(small.length).toBeLessThan(12000); // server/emojiUsage.js MAX_LENGTH
    // Too many: the least used are left out.
    const many = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`some_long_emoji_name_${i}`, i + 1]));
    const fitted = await decryptEmojiUsage(await encryptEmojiUsage(many, 0, key, USER), key, USER);
    expect(Object.keys(fitted.counts).length).toBeLessThan(1000);
    expect(fitted.counts.some_long_emoji_name_999).toBe(1000);
    expect(fitted.counts.some_long_emoji_name_0).toBeUndefined();
    expect(EMOJI_USAGE_BYTES).toBe(8192);
    await expect(decryptEmojiUsage(small, key, USER + 1)).rejects.toThrow();
  });

  it("takes another device's newer save and adds this one's uses on top", async () => {
    stop = start();
    await settle();
    // Another device saved meanwhile.
    server = { emojiUsage: await encryptEmojiUsage({ tada: 5 }, 2, key, USER), version: 1 };
    recordEmojiUse('tada');
    recordEmojiUse('joy');
    await settle();
    expect(server.version).toBe(2);
    expect(await serverUsage()).toEqual({ counts: { tada: 6, joy: 1 }, tone: 2 });
    expect(frequentEmojiIds()).toEqual(['tada', 'joy']);

    // And the event from another device's save.
    const handler = onEmojiUsage.mock.calls.at(-1)[0];
    handler({ emojiUsage: await encryptEmojiUsage({ tada: 6, joy: 1, heart: 9 }, 2, key, USER), version: 3 });
    await settle();
    expect(frequentEmojiIds()).toEqual(['heart', 'tada', 'joy']);
  });

  it("doesn't count twice when its own save's event beats the reply", async () => {
    stop = start();
    await settle();
    const handler = onEmojiUsage.mock.calls.at(-1)[0];
    const save = api.put.getMockImplementation();
    api.put.mockImplementationOnce(async (url, body) => {
      const res = await save(url, body);
      handler({ ...res.data });
      await settle();
      return res;
    });
    recordEmojiUse('tada');
    recordEmojiUse('tada');
    await settle();
    await settle();
    expect(frequentEmojiIds()).toEqual(['tada']);
    expect((await serverUsage()).counts).toEqual({ tada: 2 });
    recordEmojiUse('tada');
    await settle();
    expect((await serverUsage()).counts).toEqual({ tada: 3 });
  });

  it("moves what this device kept before into the account, the account's tone first", async () => {
    localStorage.setItem('emojiFrequent', JSON.stringify({ joy: 4, tada: 1 }));
    localStorage.setItem('emojiSkinTone', '5');
    server = { emojiUsage: await encryptEmojiUsage({ tada: 2 }, 1, key, USER), version: 1 };
    stop = start();
    await settle();
    expect(await serverUsage()).toEqual({ counts: { joy: 4, tada: 3 }, tone: 1 });
    expect(getSkinTone()).toBe(1);
    expect(localStorage.getItem('emojiFrequent')).toBeNull();
    expect(localStorage.getItem('emojiSkinTone')).toBeNull();
  });

  it("takes this device's old tone when the account has none", async () => {
    localStorage.setItem('emojiSkinTone', '5');
    stop = start();
    await settle();
    expect(getSkinTone()).toBe(5);
    expect((await serverUsage()).tone).toBe(5);
  });
});
