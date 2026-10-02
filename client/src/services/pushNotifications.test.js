import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./keyStore', () => ({ loadEncryptionKey: vi.fn(), loadOwnPublicKeys: vi.fn() }));
vi.mock('./groupCache', () => ({ recallGroup: vi.fn(), rememberGroupName: vi.fn() }));
vi.mock('./settingsStore', () => ({ getSetting: vi.fn() }));
vi.mock('./contactKeys', () => ({ getPinnedContact: vi.fn() }));

import { notificationFromPush } from './pushNotifications';
import { loadEncryptionKey, loadOwnPublicKeys } from './keyStore';
import { recallGroup } from './groupCache';
import { getSetting } from './settingsStore';
import { getPinnedContact } from './contactKeys';
import {
  generateUserKeys, importEncryptionPrivateKey, importIdentityPrivateKey, deriveConversationKey, encryptMessage, dmContext,
} from './encryptionService';
import {
  encryptGroupMessage, generateGroupKey, groupMessageContext, importGroupKey, messageSignatureContext,
  sealGroupName, signGroupName,
} from './groupCrypto';

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

  it('shows mentions of the two people by name', async () => {
    const { options } = await notificationFromPush(
      await dmPushFromAlice(`hey <@${BOB}>, it's <@${ALICE}> (not <@99>)`, { recipientName: 'bob' })
    );
    expect(options.body).toBe("hey @bob, it's @alice (not @unknown-user)");
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

    const noCiphertext = await dmPushFromAlice('hi');
    delete noCiphertext.ciphertext;
    expect((await notificationFromPush(noCiphertext)).options.body).toBe('New message');
  });

  it('shows non-DM pushes (e.g. the test notification) as sent', async () => {
    const { title, options } = await notificationFromPush({ type: 'test', title: 'Voicaw', body: 'Notifications are working.', url: '/settings', tag: 'test' });
    expect(title).toBe('Voicaw');
    expect(options).toMatchObject({ body: 'Notifications are working.', data: { url: '/settings' }, icon: '/logo192.png' });
  });
});

describe('group notifications', () => {
  const GROUP = '11111111-2222-4333-8444-555555555555';
  let epochKey;
  let aliceSigns;

  async function groupPush(text, { name = 'Climbing', signer, extra = {} } = {}) {
    const sealedName = await sealGroupName(
      await signGroupName({ groupId: GROUP, version: 2, renamerId: ALICE, name }, aliceSigns), epochKey, GROUP, 3
    );
    return {
      type: 'group', title: 'Group', body: 'New message from alice', url: `/dm/g/${GROUP}`, tag: `group-${GROUP}`,
      groupId: GROUP, senderId: ALICE, senderName: 'alice', recipientId: BOB, epoch: 3, replyTo: null,
      nameCiphertext: sealedName, nameEpoch: 3,
      ciphertext: await encryptGroupMessage(
        text, epochKey, groupMessageContext(GROUP, 3, ALICE), signer ?? aliceSigns,
        messageSignatureContext({ groupId: GROUP, epoch: 3, senderId: ALICE })
      ),
      ...extra,
    };
  }

  beforeEach(async () => {
    epochKey = await importGroupKey(generateGroupKey());
    aliceSigns = await importIdentityPrivateKey(alice.private.identityKey);
    loadOwnPublicKeys.mockResolvedValue({ userId: String(BOB) });
    recallGroup.mockResolvedValue({
      userId: String(BOB),
      epochs: { 3: epochKey },
      identityKeys: { [ALICE]: alice.public.identityKey, [BOB]: bob.public.identityKey },
      members: [{ id: ALICE, name: 'alice' }, { id: BOB, name: 'bob' }, { id: 9, name: 'cleo' }],
      name: null,
    });
  });

  it("decrypts the group's name and the message with the keys saved on the device", async () => {
    const { title, options } = await notificationFromPush(await groupPush(`ready <@${BOB}>?`));
    expect(recallGroup).toHaveBeenCalledWith(String(BOB), GROUP);
    expect(title).toBe('Climbing');
    expect(options).toMatchObject({ body: 'alice: ready @bob?', tag: `group-${GROUP}`, data: { url: `/dm/g/${GROUP}` } });
  });

  it("titles a group without a name with the others' names", async () => {
    const { title } = await notificationFromPush(await groupPush('hi', { name: '' }));
    expect(title).toBe('alice, cleo');
  });

  it("doesn't show a message whose signature isn't its sender's, nor one when previews are off", async () => {
    const forged = await notificationFromPush(await groupPush('fake', { signer: await importIdentityPrivateKey(bob.private.identityKey) }));
    expect(forged.title).toBe('Climbing');
    expect(forged.options.body).toBe('New message from alice');
    getSetting.mockResolvedValue(false);
    expect((await notificationFromPush(await groupPush('secret'))).options.body).toBe('New message from alice');
  });

  it("keeps a newer name the device has seen over an older one in the push", async () => {
    recallGroup.mockResolvedValue({ ...(await recallGroup()), name: { name: 'Newer', version: 5 } });
    expect((await notificationFromPush(await groupPush('hi'))).title).toBe('Newer');
  });

  it('falls back to the push as sent for a group never opened on this device, or a call', async () => {
    recallGroup.mockResolvedValue(null);
    const { title, options } = await notificationFromPush(await groupPush('hi'));
    expect(title).toBe('Group');
    expect(options.body).toBe('New message from alice');

    recallGroup.mockResolvedValue({ userId: String(BOB), epochs: { 3: epochKey }, identityKeys: { [ALICE]: alice.public.identityKey }, members: [], name: null });
    const push = await groupPush('');
    const call = await notificationFromPush({ type: 'call', title: 'Group call', body: 'alice started a call', groupId: GROUP, nameCiphertext: push.nameCiphertext, nameEpoch: 3 });
    expect(call.title).toBe('Climbing');
    expect(call.options.body).toBe('alice started a call');
  });
});
