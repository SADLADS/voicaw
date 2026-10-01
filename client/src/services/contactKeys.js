import { verifyEncryptionKey } from './encryptionService';

// What this device knows about other users' keys ("trust on first use"). The server hands
// out everyone's public keys, so without this a malicious server could swap in its own key
// and read (and re-encrypt) a conversation unnoticed. The first identity key seen for a
// contact is remembered; if the server later presents a different one, the conversation is
// blocked until the user accepts it. Users can also mark a contact "verified" after
// comparing safety numbers. Stored per logged-in account, readable by the service worker.

const DB_NAME = 'voicaw-contacts';
const STORE = 'contacts';

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

const pinId = (myUserId, contactId) => `${myUserId}:${contactId}`;

// The contact's keys as published by the server (a row from /api/dms-list).
function publishedKeys(contact) {
  return {
    identityKey: contact.identity_key,
    encryptionKey: contact.encryption_key,
    encryptionKeySignature: contact.encryption_key_signature,
  };
}

// { identityKey, encryptionKey, verified } remembered for this contact, or null.
export async function getPinnedContact(myUserId, contactId) {
  return (await withStore('readonly', (store) => store.get(pinId(myUserId, contactId)))) ?? null;
}

async function savePin(myUserId, contactId, pin) {
  await withStore('readwrite', (store) => store.put(pin, pinId(myUserId, contactId)));
}

// Checks the keys the server gave us for `contact`. Returns { status, encryptionKey }:
//   'invalid'  - the encryption key isn't signed by the identity key (never use)
//   'changed'  - identity key differs from the one remembered (blocked until accepted)
//   'trusted'  - matches what we remember (or first time seen)
//   'verified' - matches, and the user has verified the safety number
// `encryptionKey` is the one to use (only for trusted/verified).
export async function checkContactKeys(myUserId, contact) {
  const keys = publishedKeys(contact);
  if (!keys.identityKey || !(await verifyEncryptionKey(keys))) {
    return { status: 'invalid', encryptionKey: null };
  }

  const pin = await getPinnedContact(myUserId, contact.id);
  if (!pin) {
    await savePin(myUserId, contact.id, { identityKey: keys.identityKey, encryptionKey: keys.encryptionKey, verified: false });
    return { status: 'trusted', encryptionKey: keys.encryptionKey };
  }

  if (pin.identityKey !== keys.identityKey) {
    return { status: 'changed', encryptionKey: null };
  }

  // Same identity, new encryption key: fine, it's signed by that identity.
  if (pin.encryptionKey !== keys.encryptionKey) {
    await savePin(myUserId, contact.id, { ...pin, encryptionKey: keys.encryptionKey });
  }
  return { status: pin.verified ? 'verified' : 'trusted', encryptionKey: keys.encryptionKey };
}

// The user accepts a contact's new identity key (after a 'changed' warning). Not verified.
export async function acceptContactKeys(myUserId, contact) {
  const keys = publishedKeys(contact);
  if (!(await verifyEncryptionKey(keys))) throw new Error('Keys are not validly signed');
  await savePin(myUserId, contact.id, { identityKey: keys.identityKey, encryptionKey: keys.encryptionKey, verified: false });
}

// After comparing safety numbers (or to undo that).
export async function setContactVerified(myUserId, contactId, verified) {
  const pin = await getPinnedContact(myUserId, contactId);
  if (!pin) throw new Error('Unknown contact');
  await savePin(myUserId, contactId, { ...pin, verified });
}
