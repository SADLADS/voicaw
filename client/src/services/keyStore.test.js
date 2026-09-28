import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  generateUserKeys,
  deriveConversationKey,
  importEncryptionPrivateKey,
  encryptMessage,
  decryptMessage,
  dmContext,
} from './encryptionService';

// Node environment (jsdom's ArrayBuffer is another realm to Node's WebCrypto); stub localStorage.
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
};

let keyStore;

beforeEach(async () => {
  vi.resetModules();
  indexedDB.deleteDatabase('voicaw-keys');
  localStorage.clear();
  keyStore = await import('./keyStore');
});

describe('keyStore', () => {
  it('has nothing before login', async () => {
    expect(await keyStore.loadEncryptionKey()).toBeNull();
    expect(await keyStore.loadIdentityKey()).toBeNull();
    expect(await keyStore.loadOwnPublicKeys()).toBeNull();
  });

  it('stores non-extractable private keys that still work, plus own public keys', async () => {
    const alice = await generateUserKeys();
    const bob = await generateUserKeys();
    await keyStore.storeUserKeys(7, alice);

    // Fresh module: must come back out of IndexedDB, not the in-memory cache.
    vi.resetModules();
    keyStore = await import('./keyStore');
    const encryption = await keyStore.loadEncryptionKey();
    const identity = await keyStore.loadIdentityKey();

    expect(encryption.extractable).toBe(false);
    expect(identity.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', encryption)).rejects.toThrow();
    expect(await keyStore.loadOwnPublicKeys()).toEqual({ userId: '7', ...alice.public });

    const aliceSide = await deriveConversationKey(encryption, bob.public.encryptionKey);
    const bobSide = await deriveConversationKey(await importEncryptionPrivateKey(bob.private.encryptionKey), alice.public.encryptionKey);
    expect(await decryptMessage(await encryptMessage('hi', aliceSide, dmContext(7, 8)), bobSide, dmContext(7, 8))).toBe('hi');

    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity, new Uint8Array([1]));
    expect(signature.byteLength).toBe(64);
  });

  it('clears everything on logout, including the old scheme\'s leftovers', async () => {
    await keyStore.storeUserKeys(7, await generateUserKeys());
    localStorage.setItem('privateKey', 'old-pem');

    await keyStore.clearUserKeys();

    expect(localStorage.getItem('privateKey')).toBeNull();
    expect(await keyStore.loadEncryptionKey()).toBeNull();
    expect(await keyStore.loadOwnPublicKeys()).toBeNull();
  });
});
