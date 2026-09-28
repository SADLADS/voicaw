import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./keyStore', () => ({ loadEncryptionKey: vi.fn() }));
vi.mock('./settingsStore', () => ({ getSetting: vi.fn() }));
vi.mock('./contactKeys', () => ({ getPinnedContact: vi.fn() }));

import { notificationFromPush } from './pushNotifications';
import { loadEncryptionKey } from './keyStore';
import { getSetting } from './settingsStore';
import { getPinnedContact } from './contactKeys';
import {
  generateUserKeys, importEncryptionPrivateKey, deriveConversationKey, encryptMessage, dmContext,
} from './encryptionService';

const ALICE = 7; // sender
const BOB = 3; // this device
let alice;
let bob;

async function dmPushFromAlice(text, extra = {}) {
  const key = await deriveConversationKey(await importEncryptionPrivateKey(alice.private.encryptionKey), bob.public.encryptionKey);
  return {
    type: 'dm', title: 'alice', body: 'New message', url: `/dm/${ALICE}`, tag: `dm-${ALICE}`,
    senderId: ALICE, recipientId: BOB, timestamp: 1700000000,
    ciphertext: await encryptMessage(text, key, dmContext(ALICE, BOB)), ...extra,
  };
}

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  alice ??= await generateUserKeys();
  bob ??= await generateUserKeys();
  loadEncryptionKey.mockResolvedValue(await importEncryptionPrivateKey(bob.private.encryptionKey));
  getPinnedContact.mockResolvedValue({ identityKey: alice.public.identityKey, encryptionKey: alice.public.encryptionKey, verified: false });
  getSetting.mockResolvedValue(true);
});

describe('notificationFromPush', () => {
  it('decrypts the preview with the sender key this device remembered, one notification per chat', async () => {
    const { title, options } = await notificationFromPush(await dmPushFromAlice('see you at 8'));

    expect(getPinnedContact).toHaveBeenCalledWith(BOB, ALICE);
    expect(title).toBe('alice');
    expect(options).toMatchObject({
      body: 'see you at 8', tag: `dm-${ALICE}`, renotify: true, timestamp: 1700000000000, data: { url: `/dm/${ALICE}` },
    });
  });

  it('summarises attachments instead of showing their URLs and keys', async () => {
    const { options } = await notificationFromPush(
      await dmPushFromAlice('look ![cat.png](https://s3.test/uploads/a.bin#v=1&k=SECRET)')
    );
    expect(options.body).toBe('look 📎 cat.png');
  });

  it('truncates long previews', async () => {
    const { options } = await notificationFromPush(await dmPushFromAlice('x'.repeat(500)));
    expect(options.body).toHaveLength(200);
    expect(options.body.endsWith('…')).toBe(true);
  });

  it('shows no preview for a sender whose key this device has not checked yet', async () => {
    getPinnedContact.mockResolvedValue(null);
    const { options } = await notificationFromPush(await dmPushFromAlice('hi'));
    expect(options.body).toBe('New message');
  });

  it('fails closed if the server swapped sender and recipient', async () => {
    const push = await dmPushFromAlice('hi');
    getPinnedContact.mockResolvedValue({ encryptionKey: alice.public.encryptionKey });
    const { options } = await notificationFromPush({ ...push, senderId: BOB, recipientId: ALICE });
    expect(options.body).toBe('New message');
  });

  it('falls back when previews are off, the device is logged out, or there is no ciphertext', async () => {
    getSetting.mockResolvedValueOnce(false);
    expect((await notificationFromPush(await dmPushFromAlice('secret'))).options.body).toBe('New message');

    loadEncryptionKey.mockResolvedValueOnce(null);
    expect((await notificationFromPush(await dmPushFromAlice('hi'))).options.body).toBe('New message');

    const { ciphertext, ...noCiphertext } = await dmPushFromAlice('hi');
    expect((await notificationFromPush(noCiphertext)).options.body).toBe('New message');
  });

  it('shows non-DM pushes (e.g. the test notification) as sent', async () => {
    const { title, options } = await notificationFromPush({ type: 'test', title: 'Voicaw', body: 'Notifications are working.', url: '/settings', tag: 'test' });
    expect(title).toBe('Voicaw');
    expect(options).toMatchObject({ body: 'Notifications are working.', data: { url: '/settings' }, icon: '/logo192.png' });
  });
});
