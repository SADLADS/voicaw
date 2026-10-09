// What this device knows about each group DM after checking it (groupKeys.openGroup), in
// IndexedDB so the conversation list and the service worker (notifications) can read group
// names and messages without opening the group again:
// { userId, epochs: { epoch: CryptoKey }, identityKeys: { userId: key from the checked log },
//   members: [{ id, name }] (current members, for a title when the group has no name),
//   name: { name, version, signed, picture } (the newest name seen, to refuse an older one;
//   `picture`: the group picture it names, { id, key } or null) }
// Epoch keys are non-extractable CryptoKeys, like the private keys in keyStore.js (which can
// open every one of them anyway). Logging out forgets it all.

const DB_NAME = 'voicaw-groups';
const STORE = 'groups';

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

// The group as `userId` last checked it on this device, or null.
export async function recallGroup(userId, groupId) {
  try {
    const entry = await withStore('readonly', (store) => store.get(groupId));
    return entry && String(entry.userId) === String(userId) ? entry : null;
  } catch {
    return null;
  }
}

// Saves what openGroup checked: `keys` (Map epoch -> CryptoKey), `identityKeys` (Map),
// `members` (kept from before if not given), `name` (or null when it couldn't be read). Keeps epoch keys from before and the
// newer of the two names.
export async function rememberGroup(userId, groupId, { keys, identityKeys, members, name }) {
  try {
    const old = await recallGroup(userId, groupId);
    const epochs = { ...old?.epochs };
    for (const [epoch, key] of keys) epochs[epoch] = key;
    const keepOld = old?.name && (!name || old.name.version > name.version);
    await withStore('readwrite', (store) => store.put({
      userId: String(userId),
      epochs,
      identityKeys: Object.fromEntries(identityKeys),
      members: members ?? old?.members ?? [],
      name: keepOld ? old.name : name && { name: name.name, version: name.version, signed: name.signed, picture: name.picture ?? null },
    }, groupId));
  } catch (err) {
    console.warn('Could not save group keys on this device', err);
  }
}

// After a name was read without opening the group (the conversation list).
export async function rememberGroupName(userId, groupId, name) {
  try {
    const old = await recallGroup(userId, groupId);
    // (A name saved before pictures existed is saved again, picture included.)
    if (!old || (old.name && (old.name.version > name.version || (old.name.version === name.version && old.name.picture !== undefined)))) return;
    await withStore('readwrite', (store) => store.put({ ...old, name: { name: name.name, version: name.version, signed: name.signed, picture: name.picture ?? null } }, groupId));
  } catch (err) {
    console.warn('Could not save the group name on this device', err);
  }
}

export async function forgetGroup(groupId) {
  try {
    await withStore('readwrite', (store) => store.delete(groupId));
  } catch {
    // Nothing saved.
  }
}

export async function forgetGroups() {
  await withStore('readwrite', (store) => store.clear());
}
