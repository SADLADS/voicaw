import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./dmService', () => ({
  sendMessageToUser: vi.fn(async (to, content) => ({ id: 7, content })),
  setLinkPreviews: vi.fn(),
}));
vi.mock('./groupService', () => ({ setGroupLinkPreviews: vi.fn() }));
vi.mock('./guildService', () => ({ sendChannelMessage: vi.fn(async () => ({ id: 9 })) }));
vi.mock('./groupSend', () => ({ sendGroupText: vi.fn(async () => ({ message: { id: 8, epoch: 2, content: 'c' }, key: 'epoch-key' })) }));
vi.mock('./encryptionService', () => ({
  deriveConversationKey: vi.fn(async (mine, theirs) => `dm:${theirs}`),
  deriveNotesKey: vi.fn(async () => 'notes-key'),
  dmContext: (a, b) => `${a}>${b}`,
  encryptMessage: vi.fn(async (text, key, context) => `enc(${text}|${key}|${context})`),
}));
vi.mock('./keyStore', () => ({
  loadEncryptionKey: vi.fn(async () => 'my-key'),
  loadIdentityKey: vi.fn(async () => 'id-key'),
  loadOwnPublicKeys: vi.fn(async () => ({ encryptionKey: 'my-public' })),
}));
vi.mock('./contactKeys', () => ({ checkContactKeys: vi.fn() }));
vi.mock('./linkPreviewService', () => ({ previewsFor: vi.fn(async () => []) }));

const { sendToChat } = await import('./chatSend');
const { sendMessageToUser } = await import('./dmService');
const { sendChannelMessage } = await import('./guildService');
const { sendGroupText } = await import('./groupSend');
const { checkContactKeys } = await import('./contactKeys');

const me = { id: 1 };
const bob = { id: 2, encryption_key: 'from-server' };

describe('sendToChat (the share screen)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('encrypts a DM with the key the device trusts, never the server\'s as it is', async () => {
    checkContactKeys.mockResolvedValue({ status: 'trusted', encryptionKey: 'pinned' });
    await sendToChat(me, { kind: 'dm', person: bob }, 'hi', { nonce: 'n1' });
    expect(checkContactKeys).toHaveBeenCalledWith(1, bob);
    expect(sendMessageToUser).toHaveBeenCalledWith(2, 'enc(hi|dm:pinned|1>2)', null, [], 'n1');
  });

  it('refuses a DM whose keys changed', async () => {
    checkContactKeys.mockResolvedValue({ status: 'changed', encryptionKey: null });
    await expect(sendToChat(me, { kind: 'dm', person: bob }, 'hi')).rejects.toThrow();
    expect(sendMessageToUser).not.toHaveBeenCalled();
  });

  it('sends your notes to yourself, with the notes key', async () => {
    await sendToChat(me, { kind: 'notes' }, 'note');
    expect(checkContactKeys).not.toHaveBeenCalled();
    expect(sendMessageToUser).toHaveBeenCalledWith(1, 'enc(note|notes-key|1>1)', null, [], undefined);
  });

  it('sends to a group and a guild channel', async () => {
    await sendToChat(me, { kind: 'group', group: { id: 'g1' } }, 'to group', { nonce: 'n2' });
    expect(sendGroupText).toHaveBeenCalledWith(me, 'g1', 'to group', { nonce: 'n2' });
    await sendToChat(me, { kind: 'channel', channel: { id: 5 } }, 'to guild', { nonce: 'n3' });
    expect(sendChannelMessage).toHaveBeenCalledWith(5, 'to guild', null, null, 'n3');
  });
});
