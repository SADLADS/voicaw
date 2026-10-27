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
  encryptReaction, reactionContext,
} from './encryptionService';
import {
  encryptGroupMessage, encryptGroupReaction, generateGroupKey, groupMessageContext, groupReactionContext, importGroupKey,
  messageSignatureContext, reactionSignatureContext, sealGroupName, signGroupName,
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

  it("leaves guild messages' and bot DMs' text out when previews are off", async () => {
    const guild = { type: 'guild', title: 'alice (#general, Club)', body: 'meet at 8', tag: 'channel-1' };
    const botDm = { type: 'bot_dm', title: 'slotto', body: 'Your daily spin is ready', tag: 'bot-dm-2' };
    expect((await notificationFromPush(guild)).options.body).toBe('meet at 8');
    expect((await notificationFromPush(botDm)).options.body).toBe('Your daily spin is ready');

    getSetting.mockResolvedValue(false);
    const hidden = await notificationFromPush(guild);
    expect(hidden.title).toBe('alice (#general, Club)');
    expect(hidden.options.body).toBe('New message');
    expect((await notificationFromPush(botDm)).options.body).toBe('New message');
    // Not a message: shown as sent.
    expect((await notificationFromPush({ type: 'test', title: 'Voicaw', body: 'Notifications are working.' })).options.body)
      .toBe('Notifications are working.');
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

describe('reaction notifications', () => {
  const MESSAGE = 41;

  // Alice reacted with `emoji` to Bob's (this device's) DM saying `text`.
  async function dmReactionPush(emoji, { text = 'see you at 8', extra = {} } = {}) {
    const key = await deriveConversationKey(await importEncryptionPrivateKey(alice.private.encryptionKey), bob.public.encryptionKey);
    return {
      type: 'reaction', chat: 'dm', title: 'alice', body: 'Reacted to your message', url: `/dm/${ALICE}`, tag: `reaction-dm-${MESSAGE}`,
      messageId: MESSAGE, reactorId: ALICE, senderId: BOB, recipientId: ALICE, authorName: 'bob',
      reaction: await encryptReaction(emoji, key, reactionContext(MESSAGE, ALICE, BOB, ALICE)),
      ciphertext: await encryptMessage(text, key, dmContext(BOB, ALICE)),
      ...extra,
    };
  }

  it('words a guild reaction from its emoji and the message, without the text when previews are off', async () => {
    const push = { type: 'reaction', chat: 'guild', title: 'alice (#general, Club)', body: 'Reacted 👍 to your message: hi', emoji: '<:party:12>', preview: 'Lunch?', tag: 'reaction-guild-5', url: '/guild/1/2' };
    const { title, options } = await notificationFromPush(push);
    expect(title).toBe('alice (#general, Club)');
    expect(options).toMatchObject({ body: 'Reacted :party: to your message: Lunch?', tag: 'reaction-guild-5', data: { url: '/guild/1/2' } });
    getSetting.mockResolvedValue(false);
    expect((await notificationFromPush(push)).options.body).toBe('Reacted :party: to your message');
  });

  it('opens a DM reaction with the key this device checked, and the message for a preview', async () => {
    const { title, options } = await notificationFromPush(await dmReactionPush('🍕', { text: `ok <@${BOB}>` }));
    expect(getPinnedContact).toHaveBeenCalledWith(BOB, ALICE);
    expect(title).toBe('alice');
    expect(options).toMatchObject({ body: 'Reacted 🍕 to your message: ok @bob', tag: `reaction-dm-${MESSAGE}` });
    getSetting.mockResolvedValue(false);
    expect((await notificationFromPush(await dmReactionPush('🍕'))).options.body).toBe('Reacted 🍕 to your message');
  });

  it('shows nothing for a poll vote or an added answer', async () => {
    expect(await notificationFromPush(await dmReactionPush('poll:aaaa1111'))).toBeNull();
    expect(await notificationFromPush(await dmReactionPush('poll:+{"id":"bbbb2222","t":"Soup","r":0}'))).toBeNull();
  });

  it("shows nothing for a reaction it can't open: unchecked key, swapped people, another message", async () => {
    getPinnedContact.mockResolvedValueOnce(null);
    expect(await notificationFromPush(await dmReactionPush('👍'))).toBeNull();
    expect(await notificationFromPush(await dmReactionPush('👍', { extra: { senderId: ALICE, recipientId: BOB } }))).toBeNull();
    expect(await notificationFromPush(await dmReactionPush('👍', { extra: { messageId: MESSAGE + 1 } }))).toBeNull();
    loadEncryptionKey.mockResolvedValueOnce(null);
    expect(await notificationFromPush(await dmReactionPush('👍'))).toBeNull();
  });

  describe('in groups', () => {
    const GROUP = '11111111-2222-4333-8444-555555555555';
    let epochKey;

    // Alice (or `signer`) reacted with `emoji` to Bob's group message saying `text`.
    async function groupReactionPush(emoji, { signer, text = 'Pizza?' } = {}) {
      const aliceSigns = await importIdentityPrivateKey(alice.private.identityKey);
      return {
        type: 'reaction', chat: 'group', title: 'Group', body: 'alice reacted to your message', url: `/dm/g/${GROUP}`,
        tag: `reaction-group-${MESSAGE}`, groupId: GROUP, epoch: 3, messageId: MESSAGE, reactorId: ALICE, reactorName: 'alice',
        senderId: BOB, replyTo: null, edited: false,
        reaction: await encryptGroupReaction(
          emoji, epochKey, groupReactionContext(GROUP, MESSAGE, ALICE), signer ?? aliceSigns,
          reactionSignatureContext({ groupId: GROUP, epoch: 3, messageId: MESSAGE, reactorId: ALICE })
        ),
        ciphertext: await encryptGroupMessage(
          text, epochKey, groupMessageContext(GROUP, 3, BOB), await importIdentityPrivateKey(bob.private.identityKey),
          messageSignatureContext({ groupId: GROUP, epoch: 3, senderId: BOB })
        ),
      };
    }

    beforeEach(async () => {
      epochKey = await importGroupKey(generateGroupKey());
      loadOwnPublicKeys.mockResolvedValue({ userId: String(BOB) });
      recallGroup.mockResolvedValue({
        userId: String(BOB),
        epochs: { 3: epochKey },
        identityKeys: { [ALICE]: alice.public.identityKey, [BOB]: bob.public.identityKey },
        members: [{ id: ALICE, name: 'Alice A.' }, { id: BOB, name: 'bob' }, { id: 9, name: 'cleo' }],
        name: { name: 'Climbing', version: 2 },
      });
    });

    it("opens a signed reaction with the group's saved keys", async () => {
      const { title, options } = await notificationFromPush(await groupReactionPush('🧗'));
      expect(title).toBe('Climbing');
      expect(options.body).toBe('Alice A. reacted 🧗 to your message: Pizza?');
    });

    it("shows nothing for a vote, a reaction not signed by its reactor, someone else's message or an unknown group", async () => {
      expect(await notificationFromPush(await groupReactionPush('poll:aaaa1111'))).toBeNull();
      expect(await notificationFromPush(await groupReactionPush('🧗', { signer: await importIdentityPrivateKey(bob.private.identityKey) }))).toBeNull();
      expect(await notificationFromPush({ ...(await groupReactionPush('🧗')), senderId: 9 })).toBeNull();
      recallGroup.mockResolvedValue(null);
      expect(await notificationFromPush(await groupReactionPush('🧗'))).toBeNull();
    });
  });

  it("words admins' notifications on the device, with how many are waiting", async () => {
    const admin = (extra) => notificationFromPush({ type: 'admin', title: 'New report', body: '2 waiting', url: '/settings/reports#reports', tag: 'admin-report', ...extra });
    let n = await admin({ kind: 'report', count: 2 });
    expect(n.title).toBe('New report');
    expect(n.options).toMatchObject({ body: '2 open reports', tag: 'admin-report', data: { url: '/settings/reports#reports' } });
    n = await admin({ kind: 'signup', count: 1, name: 'newcomer' });
    expect([n.title, n.options.body]).toEqual(['New sign-up request', 'newcomer asked for an account']);
    n = await admin({ kind: 'tester', count: 1 });
    expect([n.title, n.options.body]).toEqual(['New Android tester request', '1 request waiting to be added']);
    n = await admin({ kind: 'something-new', count: 1 });
    expect([n.title, n.options.body]).toEqual(['New report', '2 waiting']);
  });
});

describe('"pinned a message" and "poll ended" notifications', () => {
  const MESSAGE = 52;
  const POLL = 'poll:v1:{"q":"Lunch?","multi":false,"o":[{"id":"aaaa1111","t":"Pizza"}]}';

  // Alice's push about Bob's (this device's) DM saying `text`.
  async function dmSystemPush(system, text, extra = {}) {
    const key = await deriveConversationKey(await importEncryptionPrivateKey(alice.private.encryptionKey), bob.public.encryptionKey);
    return {
      type: 'dm', system, title: 'alice', body: 'Pinned a message', url: `/dm/${ALICE}`, tag: `dm-${ALICE}`,
      senderId: ALICE, recipientId: BOB, recipientName: 'bob', actorName: 'alice',
      messageId: MESSAGE, messageSenderId: BOB, messageRecipientId: ALICE,
      messageCiphertext: await encryptMessage(text, key, dmContext(BOB, ALICE)),
      ...extra,
    };
  }

  it("words a DM pin with the pinned message's text, opened with the checked key", async () => {
    const { title, options } = await notificationFromPush(await dmSystemPush('pin', 'see you at 8'));
    expect(getPinnedContact).toHaveBeenCalledWith(BOB, ALICE);
    expect(title).toBe('alice');
    expect(options).toMatchObject({ body: 'Pinned a message: see you at 8', tag: `dm-${ALICE}` });
    // Without previews, an unchecked key or a message from another conversation: no text.
    expect((await notificationFromPush(await dmSystemPush('pin', 'x', { messageRecipientId: 9 }))).options.body).toBe('Pinned a message');
    getPinnedContact.mockResolvedValue(null);
    expect((await notificationFromPush(await dmSystemPush('pin', 'x'))).options.body).toBe('Pinned a message');
    getSetting.mockResolvedValue(false);
    expect((await notificationFromPush(await dmSystemPush('pin', 'x'))).options.body).toBe('Pinned a message');
  });

  it("words a closed poll with its question, the author's own as theirs", async () => {
    expect((await notificationFromPush(await dmSystemPush('poll_end', POLL, { mine: true }))).options.body).toBe('Your poll “Lunch?” has closed');
    expect((await notificationFromPush(await dmSystemPush('poll_end', POLL, { actorName: 'cleo' }))).options.body).toBe("cleo's poll “Lunch?” has closed");
    getSetting.mockResolvedValue(false);
    expect((await notificationFromPush(await dmSystemPush('poll_end', POLL, { mine: true }))).options.body).toBe('Your poll has closed');
  });

  it("words a guild's from its preview, leaving it out when previews are off", async () => {
    const pin = { type: 'guild', system: 'pin', title: 'ann (#general, Guild)', body: 'Pinned a message: hi', preview: 'hi', actorName: 'ann' };
    expect((await notificationFromPush(pin)).options.body).toBe('Pinned a message: hi');
    const poll = { type: 'guild', system: 'poll_end', title: 'ann (#general, Guild)', preview: 'Lunch?', actorName: 'ann', mine: false };
    expect((await notificationFromPush(poll)).options.body).toBe("ann's poll “Lunch?” has closed");
    getSetting.mockResolvedValue(false);
    expect((await notificationFromPush(pin)).options.body).toBe('Pinned a message');
  });

  it('opens a group one with the saved keys, only if signed by its sender', async () => {
    const GROUP = '11111111-2222-4333-8444-555555555555';
    const epochKey = await importGroupKey(generateGroupKey());
    loadOwnPublicKeys.mockResolvedValue({ userId: String(BOB) });
    recallGroup.mockResolvedValue({
      userId: String(BOB),
      epochs: { 3: epochKey },
      identityKeys: { [ALICE]: alice.public.identityKey, [BOB]: bob.public.identityKey },
      members: [{ id: ALICE, name: 'Alice A.' }, { id: BOB, name: 'bob' }],
      name: { name: 'Climbing', version: 2 },
    });
    const push = async (signer) => ({
      type: 'group', system: 'pin', title: 'Group', body: 'alice pinned a message', url: `/dm/g/${GROUP}`, tag: `group-${GROUP}`,
      groupId: GROUP, senderId: ALICE, senderName: 'alice', actorName: 'Alice A.', recipientId: BOB, epoch: 3,
      messageId: MESSAGE, messageSenderId: BOB, replyTo: null, edited: false,
      messageCiphertext: await encryptGroupMessage(
        'Pizza?', epochKey, groupMessageContext(GROUP, 3, BOB), signer,
        messageSignatureContext({ groupId: GROUP, epoch: 3, senderId: BOB })
      ),
    });
    const { title, options } = await notificationFromPush(await push(await importIdentityPrivateKey(bob.private.identityKey)));
    expect(title).toBe('Climbing');
    expect(options.body).toBe('Alice A. pinned a message: Pizza?');
    const forged = await notificationFromPush(await push(await importIdentityPrivateKey(alice.private.identityKey)));
    expect(forged.options.body).toBe('Alice A. pinned a message');
  });
});
