// Per-device settings the service worker needs too (it can't read localStorage), kept in
// IndexedDB. Values are small JSON-able values keyed by name.

const DB_NAME = 'voicaw-settings';
const STORE = 'settings';

export const DEFAULTS = {
  // Show decrypted message text in notifications (otherwise just who it's from).
  notificationPreviews: true,
};

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

export async function getSetting(name) {
  try {
    const value = await withStore('readonly', (store) => store.get(name));
    return value === undefined ? DEFAULTS[name] : value;
  } catch {
    return DEFAULTS[name];
  }
}

export async function setSetting(name, value) {
  await withStore('readwrite', (store) => store.put(value, name));
}
