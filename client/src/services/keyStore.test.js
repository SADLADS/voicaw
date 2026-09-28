import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  generateECDH_P256_PEM,
  deriveSharedKey,
  encryptMessage,
  decryptMessage,
} from './encryptionService';

// Stays in the node environment (like encryptionService.test.js): jsdom's ArrayBuffer
// is a different realm from Node's WebCrypto, so importKey rejects it. Stub localStorage instead.
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
};

let keyStore;

beforeEach(async () => {
  // Fresh module (and so an empty in-memory cache) plus an empty IndexedDB per test.
  vi.resetModules();
  indexedDB.deleteDatabase('voicaw-keys');
  localStorage.clear();
  keyStore = await import('./keyStore');
});

describe('keyStore', () => {
  it('returns null when no key has been stored', async () => {
    expect(await keyStore.loadPrivateKey()).toBeNull();
  });

  it('stores the key as a non-extractable CryptoKey that still derives the right shared key', async () => {
    const alice = await generateECDH_P256_PEM();
    const bob = await generateECDH_P256_PEM();

    await keyStore.storePrivateKey(alice.privatePEM);

    // Reload the module so the key has to come back out of IndexedDB, not the cache.
    vi.resetModules();
    keyStore = await import('./keyStore');
    const stored = await keyStore.loadPrivateKey();

    expect(stored.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', stored)).rejects.toThrow();

    const aliceShared = await deriveSharedKey(stored, bob.publicPEM);
    const bobShared = await deriveSharedKey(bob.privatePEM, alice.publicPEM);
    const ciphertext = await encryptMessage('hi bob', aliceShared);
    expect(await decryptMessage(ciphertext, bobShared)).toBe('hi bob');
  });

  it('migrates a legacy PEM out of localStorage', async () => {
    const alice = await generateECDH_P256_PEM();
    localStorage.setItem('privateKey', alice.privatePEM);

    const key = await keyStore.loadPrivateKey();

    expect(key).toBeInstanceOf(CryptoKey);
    expect(localStorage.getItem('privateKey')).toBeNull();
  });

  it('clearPrivateKey removes the key from IndexedDB and localStorage', async () => {
    const alice = await generateECDH_P256_PEM();
    await keyStore.storePrivateKey(alice.privatePEM);
    localStorage.setItem('privateKey', 'stale');

    await keyStore.clearPrivateKey();

    expect(localStorage.getItem('privateKey')).toBeNull();
    expect(await keyStore.loadPrivateKey()).toBeNull();
  });
});
