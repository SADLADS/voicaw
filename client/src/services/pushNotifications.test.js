import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./keyStore', () => ({ loadPrivateKey: vi.fn() }));
vi.mock('./settingsStore', () => ({ getSetting: vi.fn() }));

import { notificationFromPush } from './pushNotifications';
import { loadPrivateKey } from './keyStore';
import { getSetting } from './settingsStore';
import { generateECDH_P256_PEM, deriveSharedKey, encryptMessage, importPrivateKey } from './encryptionService';

let alice; // sender
let bob; // recipient (this device)

async function dmPushFromAlice(text, extra = {}) {
  const key = await deriveSharedKey(alice.privatePEM, bob.publicPEM);
  return {
    type: 'dm', title: 'alice', url: '/dm/1', tag: 'dm-1', senderId: 1, timestamp: 1700000000,
    ciphertext: await encryptMessage(text, key), senderPublicKey: alice.publicPEM, ...extra,
  };
}

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  alice ??= await generateECDH_P256_PEM();
  bob ??= await generateECDH_P256_PEM();
  loadPrivateKey.mockResolvedValue(await importPrivateKey(bob.privatePEM));
  getSetting.mockResolvedValue(true);
});

describe('notificationFromPush', () => {
  it('decrypts the message on the device for the preview, one notification per conversation', async () => {
    const { title, options } = await notificationFromPush(await dmPushFromAlice('see you at 8'));

    expect(title).toBe('alice');
    expect(options).toMatchObject({
      body: 'see you at 8', tag: 'dm-1', renotify: true, timestamp: 1700000000000, data: { url: '/dm/1' },
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

  it('falls back to a generic body when previews are turned off', async () => {
    getSetting.mockResolvedValue(false);
    const { options } = await notificationFromPush(await dmPushFromAlice('secret'));
    expect(options.body).toBe('New message');
  });

  it('falls back when this device has no key (logged out) or decryption fails', async () => {
    loadPrivateKey.mockResolvedValueOnce(null);
    expect((await notificationFromPush(await dmPushFromAlice('hi'))).options.body).toBe('New message');

    const mallory = await generateECDH_P256_PEM();
    loadPrivateKey.mockResolvedValueOnce(await importPrivateKey(mallory.privatePEM));
    expect((await notificationFromPush(await dmPushFromAlice('hi'))).options.body).toBe('New message');
  });

  it('falls back when the push had no room for the ciphertext', async () => {
    const { options } = await notificationFromPush({ type: 'dm', title: 'alice', tag: 'dm-1', url: '/dm/1' });
    expect(options.body).toBe('New message');
  });

  it('shows non-DM pushes (e.g. the test notification) as sent', async () => {
    const { title, options } = await notificationFromPush({ type: 'test', title: 'Voicaw', body: 'Notifications are working.', url: '/settings', tag: 'test' });
    expect(title).toBe('Voicaw');
    expect(options).toMatchObject({ body: 'Notifications are working.', data: { url: '/settings' }, icon: '/logo192.png' });
  });
});
