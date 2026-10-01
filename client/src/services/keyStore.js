import { importEncryptionPrivateKey, importIdentityPrivateKey } from './encryptionService';

// This device's copy of the logged-in user's keys, in IndexedDB. Private keys are stored as
// non-extractable CryptoKeys: page scripts (and the service worker) can use them, but can
// never read the raw key material back out. The user's own public keys are kept too, taken
// from their own (verified) key backup rather than from the server, so safety numbers are
// computed from the real keys.

const DB_NAME = 'voicaw-keys';
const STORE = 'keys';
const IDENTITY = 'identity-private';
const ENCRYPTION = 'encryption-private';
const OWN_PUBLIC = 'own-public';
// Entries/keys from the previous key scheme, removed whenever keys are (re)stored or cleared.
const LEGACY_ENTRIES = ['identity'];
const LEGACY_LOCAL_STORAGE_KEY = 'privateKey';

const cache = new Map();

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function load(name) {
  if (cache.has(name)) return cache.get(name);
  const value = (await withStore('readonly', (store) => store.get(name))) ?? null;
  if (value) cache.set(name, value);
  return value;
}

function removeLegacyLocalStorage() {
  if (typeof localStorage !== 'undefined') localStorage.removeItem(LEGACY_LOCAL_STORAGE_KEY);
}

// `userKeys` as produced by generateUserKeys / unwrapKeyBackup; `userId` is the account.
export async function storeUserKeys(userId, userKeys) {
  const identity = await importIdentityPrivateKey(userKeys.private.identityKey);
  const encryption = await importEncryptionPrivateKey(userKeys.private.encryptionKey);
  const ownPublic = { userId: String(userId), ...userKeys.public };

  await withStore('readwrite', (store) => {
    store.put(identity, IDENTITY);
    store.put(encryption, ENCRYPTION);
    LEGACY_ENTRIES.forEach((name) => store.delete(name));
    return store.put(ownPublic, OWN_PUBLIC);
  });
  removeLegacyLocalStorage();

  cache.clear();
  cache.set(IDENTITY, identity);
  cache.set(ENCRYPTION, encryption);
  cache.set(OWN_PUBLIC, ownPublic);
}

// ECDH private key for DMs, or null if this device isn't logged in.
export function loadEncryptionKey() {
  return load(ENCRYPTION);
}

// ECDSA identity private key (signing), or null.
export function loadIdentityKey() {
  return load(IDENTITY);
}

// { userId, identityKey, encryptionKey, encryptionKeySignature } for the logged-in user.
export function loadOwnPublicKeys() {
  return load(OWN_PUBLIC);
}

export async function clearUserKeys() {
  cache.clear();
  removeLegacyLocalStorage();
  await withStore('readwrite', (store) => {
    [IDENTITY, ENCRYPTION, OWN_PUBLIC, ...LEGACY_ENTRIES].forEach((name) => store.delete(name));
  });
}
