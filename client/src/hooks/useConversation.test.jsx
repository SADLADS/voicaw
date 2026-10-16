// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// The offline copy's part of a DM: online it follows what's shown, and only a server that
// can't be reached makes the chat come from it.
vi.mock('../utils/ws-client', () => {
  const off = () => () => {};
  return {
    onNewDm: off, onDeleteDm: off, onEditDm: off, onReactionAdd: off, onReactionRemove: off,
    onDmPin: off, onDmLinkPreviews: off, setActiveChat: vi.fn(),
  };
});
vi.mock('../services/dmService', () => ({
  fetchMessagesForUser: vi.fn(),
  fetchMessageRanges: vi.fn(async (_id, ranges) => ranges.map(() => ({ rows: 0, edited: 0 }))),
  markMessagesRead: vi.fn(async () => null),
  sendMessageToUser: vi.fn(),
  editMessage: vi.fn(),
  deleteMessage: vi.fn(),
  fetchPins: vi.fn(),
  setMessagePinned: vi.fn(),
  setLinkPreviews: vi.fn(),
  fetchEditHistory: vi.fn(),
}));
vi.mock('../services/keyStore', () => ({ loadEncryptionKey: vi.fn(async () => 'my-key'), loadOwnPublicKeys: vi.fn() }));
vi.mock('../services/contactKeys', () => ({
  checkContactKeys: vi.fn(async () => ({ status: 'trusted', encryptionKey: 'their-key' })),
  acceptContactKeys: vi.fn(),
}));
vi.mock('../services/encryptionService', () => ({
  deriveConversationKey: vi.fn(async () => 'shared'),
  deriveNotesKey: vi.fn(),
  decryptMessagesBatch: vi.fn(async (rows) => rows.map((r) => ({ ...r, plaintext: `text ${r.id}`, reactions: [] }))),
  encryptMessage: vi.fn(),
  decryptMessage: vi.fn(),
  decryptMessageRow: vi.fn(),
  decryptReaction: vi.fn(),
  dmContext: vi.fn(),
  reactionContext: vi.fn(),
}));

const { fetchMessagesForUser, markMessagesRead } = await import('../services/dmService');
const { catchUp } = await import('../utils/catchUp');
const { useConversation } = await import('./useConversation');
const copy = await import('../services/offlineCopy');

const user = { id: 1, username: 'me' };
const chatUser = { id: 2, identity_key: 'k', encryption_key: 'e', encryption_key_signature: 's' };
const rows = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i, sender_id: 2, recipient_id: 1, content: 'v1.x', timestamp: from + i }));
const unreachable = () => Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });

beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.clear();
  await copy.clearOfflineCopy();
});

const open = () => renderHook(() => useConversation({ id: 2, user, chatUser }));

describe('useConversation and the offline copy', () => {
  it('saves what it showed, and shows it read-only when the server is out of reach', async () => {
    fetchMessagesForUser.mockResolvedValue(rows(1, 5));
    const online = open();
    await waitFor(() => expect(online.result.current.messages).toHaveLength(5));
    expect(online.result.current.offlineCopy).toBe(false);
    await waitFor(async () => expect((await copy.loadChat('1/dm/2'))?.messages).toHaveLength(5), { timeout: 3000 });
    online.unmount();

    fetchMessagesForUser.mockRejectedValue(unreachable());
    const offline = open();
    await waitFor(() => expect(offline.result.current.messages).toHaveLength(5));
    expect(offline.result.current.offlineCopy).toBe(true);
    expect(offline.result.current.messages[0]).toMatchObject({ id: 1, plaintext: 'text 1' });
    expect(offline.result.current.messages[0].content).toBeUndefined();
    expect(offline.result.current.error).toBeNull();
  });

  it('says so when nothing was saved', async () => {
    fetchMessagesForUser.mockRejectedValue(unreachable());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = open();
    await waitFor(() => expect(result.current.error).toMatch(/saved on this device/));
  });

  it("doesn't use the copy when the server refuses", async () => {
    await copy.saveChat('1/dm/2', rows(1, 3).map((r) => ({ ...r, plaintext: 'old' })));
    fetchMessagesForUser.mockRejectedValue(Object.assign(new Error('Forbidden'), { response: { status: 403 } }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = open();
    await waitFor(() => expect(result.current.error).toBe('Forbidden'));
    expect(result.current.messages).toHaveLength(0);
  });
});

describe('useConversation catching up', () => {
  it('fetches what the websocket missed when told to (a notification opening the chat)', async () => {
    fetchMessagesForUser.mockResolvedValue(rows(1, 5));
    const { result } = open();
    await waitFor(() => expect(result.current.messages).toHaveLength(5));
    markMessagesRead.mockClear();

    // Sent while the phone slept: only a fetch finds it.
    fetchMessagesForUser.mockResolvedValue(rows(1, 6));
    catchUp();
    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6]));
    expect(result.current.messages[5].plaintext).toBe('text 6');
    expect(markMessagesRead).toHaveBeenCalledWith(2);
  });

  it("doesn't fetch from the server while showing the offline copy", async () => {
    await copy.saveChat('1/dm/2', rows(1, 3).map((r) => ({ ...r, plaintext: 'old' })));
    fetchMessagesForUser.mockRejectedValue(unreachable());
    const { result } = open();
    await waitFor(() => expect(result.current.offlineCopy).toBe(true));
    fetchMessagesForUser.mockClear();
    catchUp();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMessagesForUser).not.toHaveBeenCalled();
  });
});
