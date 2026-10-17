import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { generateUserKeys } from './encryptionService';
import { checkContactKeys, acceptContactKeys, setContactVerified, getPinnedContact } from './contactKeys';
import { setSetting } from './settingsStore';

const ME = 1;
const asContact = (id, keys) => ({
  id,
  identity_key: keys.public.identityKey,
  encryption_key: keys.public.encryptionKey,
  encryption_key_signature: keys.public.encryptionKeySignature,
});

let bob;

beforeEach(async () => {
  await new Promise((r) => { const req = indexedDB.deleteDatabase('voicaw-contacts'); req.onsuccess = r; req.onerror = r; });
  await setSetting('server', null);
  bob = await generateUserKeys();
});

describe('contact keys (trust on first use)', () => {
  it('trusts and remembers a contact the first time', async () => {
    const result = await checkContactKeys(ME, asContact(2, bob));

    expect(result).toEqual({ status: 'trusted', encryptionKey: bob.public.encryptionKey });
    expect(await getPinnedContact(ME, 2)).toMatchObject({ identityKey: bob.public.identityKey, verified: false });
  });

  it('blocks when the server later presents a different identity key', async () => {
    await checkContactKeys(ME, asContact(2, bob));
    const mallory = await generateUserKeys();

    expect(await checkContactKeys(ME, asContact(2, mallory))).toEqual({ status: 'changed', encryptionKey: null });
    // ...and keeps remembering the original.
    expect((await getPinnedContact(ME, 2)).identityKey).toBe(bob.public.identityKey);
  });

  it('never uses keys whose signature does not check out', async () => {
    const mallory = await generateUserKeys();
    const forged = { ...asContact(2, bob), encryption_key: mallory.public.encryptionKey };

    expect(await checkContactKeys(ME, forged)).toEqual({ status: 'invalid', encryptionKey: null });
    expect(await getPinnedContact(ME, 2)).toBeNull();
  });

  it('lets the user accept a changed key (unverified)', async () => {
    await checkContactKeys(ME, asContact(2, bob));
    await setContactVerified(ME, 2, true);
    const newBob = await generateUserKeys();

    await acceptContactKeys(ME, asContact(2, newBob));

    expect(await checkContactKeys(ME, asContact(2, newBob))).toEqual({ status: 'trusted', encryptionKey: newBob.public.encryptionKey });
  });

  it('remembers verification', async () => {
    await checkContactKeys(ME, asContact(2, bob));
    await setContactVerified(ME, 2, true);
    expect((await checkContactKeys(ME, asContact(2, bob))).status).toBe('verified');
    await setContactVerified(ME, 2, false);
    expect((await checkContactKeys(ME, asContact(2, bob))).status).toBe('trusted');
  });

  it('keeps separate trust per logged-in account on the same device', async () => {
    await checkContactKeys(ME, asContact(2, bob));
    await setContactVerified(ME, 2, true);
    expect((await checkContactKeys(99, asContact(2, bob))).status).toBe('trusted');
  });

  // User ids are only unique on one server (utils/server.js; the service worker reads the
  // choice from settingsStore, as this test's environment does).
  it('keeps separate trust per server', async () => {
    await checkContactKeys(ME, asContact(2, bob));
    await setContactVerified(ME, 2, true);
    await setSetting('server', { api: 'https://chat.example.com/api/', ws: 'wss://chat.example.com/api/socket' });
    expect(await getPinnedContact(ME, 2)).toBeNull();
    const mallory = await generateUserKeys();
    expect((await checkContactKeys(ME, asContact(2, mallory))).status).toBe('trusted');
    await setSetting('server', null);
    expect((await checkContactKeys(ME, asContact(2, bob))).status).toBe('verified');
  });
});
