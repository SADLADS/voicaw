import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import api from '../utils/api';
import { onDictionary } from '../utils/ws-client';
import { loadEncryptionKey, loadOwnPublicKeys } from '../services/keyStore';
import {
  DICTIONARY_PAD_BYTES, decryptDictionary, deriveDictionaryKey, encryptDictionary, generateUserKeys, importEncryptionPrivateKey,
} from '../services/encryptionService';
import { addWord, dictionaryWords, hasWord, removeWord, startDictionarySync } from './personalDictionary';

vi.mock('../utils/api', () => ({ default: { get: vi.fn(), put: vi.fn() } }));
vi.mock('../utils/ws-client', () => ({ onConnectionState: vi.fn(() => () => {}), onDictionary: vi.fn(() => () => {}) }));
vi.mock('../services/keyStore', () => ({ loadEncryptionKey: vi.fn(), loadOwnPublicKeys: vi.fn() }));

const USER = 7;
let server; // what the server holds: { dictionary, version }
let key;

const settle = () => new Promise((resolve) => { setTimeout(resolve, 20); });
const serverWords = async () => (server.dictionary ? decryptDictionary(server.dictionary, key, USER) : []);

beforeEach(async () => {
  const keys = await generateUserKeys();
  const priv = await importEncryptionPrivateKey(keys.private.encryptionKey);
  loadEncryptionKey.mockResolvedValue(priv);
  loadOwnPublicKeys.mockResolvedValue({ encryptionKey: keys.public.encryptionKey });
  key = await deriveDictionaryKey(priv, keys.public.encryptionKey);
  server = { dictionary: null, version: 0 };
  api.get.mockImplementation(async () => ({ data: { ...server } }));
  api.put.mockImplementation(async (url, body) => {
    if (body.version !== server.version) {
      const err = new Error('conflict');
      err.response = { status: 409, data: { ...server } };
      throw err;
    }
    server = { dictionary: body.dictionary, version: server.version + 1 };
    return { data: { ...server } };
  });
});

let stop = null;
afterEach(() => {
  stop?.();
  stop = null;
});

describe('the personal dictionary', () => {
  it('loads, adds and removes words (any case), saving them encrypted', async () => {
    server = { dictionary: await encryptDictionary(['Voicaw'], key, USER), version: 3 };
    stop = startDictionarySync(USER);
    await settle();
    expect(dictionaryWords()).toEqual(['Voicaw']);
    expect(hasWord('voicaw')).toBe(true);

    addWord('Otto');
    expect(hasWord('OTTO')).toBe(true); // at once, before it's saved
    await settle();
    expect(server.version).toBe(4);
    expect(server.dictionary).not.toContain('Otto');
    expect(await serverWords()).toEqual(['Otto', 'Voicaw']);

    removeWord('voicaw');
    await settle();
    expect(await serverWords()).toEqual(['Otto']);
  });

  it('pads what it saves, and only opens with the same account', async () => {
    const small = await encryptDictionary(['a'], key, USER);
    const more = await encryptDictionary(['alpha', 'beta', 'gamma'], key, USER);
    expect(small.length).toBe(more.length);
    expect(DICTIONARY_PAD_BYTES).toBe(1024);
    await expect(decryptDictionary(small, key, USER + 1)).rejects.toThrow();
  });

  it('adds its change on top of a newer copy saved by another device', async () => {
    stop = startDictionarySync(USER);
    await settle();
    // Another device saves first.
    server = { dictionary: await encryptDictionary(['Elsewhere'], key, USER), version: 1 };
    addWord('Here');
    await settle();
    expect(await serverWords()).toEqual(['Elsewhere', 'Here']);
    expect(server.version).toBe(2);
    expect(dictionaryWords()).toEqual(['Elsewhere', 'Here']);
  });

  it("takes your other devices' changes, and forgets it all on logging out", async () => {
    stop = startDictionarySync(USER);
    await settle();
    const listener = onDictionary.mock.calls.at(-1)[0];
    listener({ dictionary: await encryptDictionary(['Remote'], key, USER), version: 1 });
    await settle();
    expect(dictionaryWords()).toEqual(['Remote']);
    stop();
    stop = null;
    expect(dictionaryWords()).toEqual([]);
  });
});
