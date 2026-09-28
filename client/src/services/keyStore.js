import { importPrivateKey } from './encryptionService';

// The user's ECDH private key is kept in IndexedDB as a non-extractable CryptoKey,
// so page scripts can use it to derive shared keys but can never read the raw key
// material back out (unlike the PEM string we used to keep in localStorage).

const DB_NAME = 'voicaw-keys';
const STORE = 'keys';
const IDENTITY_KEY = 'identity';
const LEGACY_STORAGE_KEY = 'privateKey';

let cachedKey = null;

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
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function storePrivateKey(privatePEM) {
  const key = await importPrivateKey(privatePEM);
  await withStore('readwrite', store => store.put(key, IDENTITY_KEY));
  cachedKey = key;
  return key;
}

// Returns the stored CryptoKey, or null if the user has no key on this device.
export async function loadPrivateKey() {
  if (cachedKey) return cachedKey;

  const stored = await withStore('readonly', store => store.get(IDENTITY_KEY));
  if (stored) {
    cachedKey = stored;
    return stored;
  }

  // Sessions from before this change still have the PEM in localStorage: move it over.
  // (Not in the service worker, which has no localStorage.)
  if (typeof localStorage === 'undefined') return null;
  const legacyPEM = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacyPEM) {
    const key = await storePrivateKey(legacyPEM);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return key;
  }

  return null;
}

export async function clearPrivateKey() {
  cachedKey = null;
  localStorage.removeItem(LEGACY_STORAGE_KEY);
  await withStore('readwrite', store => store.delete(IDENTITY_KEY));
}
