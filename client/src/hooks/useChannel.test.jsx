// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

let emit;
vi.mock('../utils/ws-client', () => ({
  onGuildEvent: vi.fn((listener) => { emit = listener; return () => {}; }),
  setActiveChat: vi.fn(),
  setSideChat: vi.fn(),
}));
vi.mock('../services/guildService', () => ({
  fetchChannelMessages: vi.fn(async () => [
    { id: 1, channel_id: 5, sender_id: 2, content: 'first', timestamp: 100 },
    { id: 2, channel_id: 5, sender_id: 7, content: 'menu', timestamp: 300, components: [{ type: 1, components: [] }] },
  ]),
  sendChannelMessage: vi.fn(),
  editChannelMessage: vi.fn(),
  deleteChannelMessage: vi.fn(),
  markChannelRead: vi.fn(async () => {}),
  fetchChannelPins: vi.fn(async () => []),
  setChannelMessagePinned: vi.fn(),
}));

import { useChannel } from './useChannel';
import { requestDismiss } from '../utils/botComponents';
import { markChannelRead } from '../services/guildService';

const EPHEMERAL = 2 ** 52 + 1;

async function load() {
  const hook = renderHook(() => useChannel({ channelId: 5, user: { id: 1 } }));
  await waitFor(() => expect(hook.result.current.messages).toHaveLength(2));
  return hook;
}

beforeEach(() => vi.clearAllMocks());

describe('useChannel', () => {
  it('keeps where the unread messages started, as reading the channel on opening said', async () => {
    markChannelRead.mockResolvedValueOnce(2);
    const { result } = await load();
    expect(markChannelRead).toHaveBeenCalledWith(5, 2);
    await waitFor(() => expect(result.current.firstUnread).toEqual({ id: 2 }));
    // Reading a live message doesn't change it.
    markChannelRead.mockResolvedValueOnce(3);
    act(() => emit({ type: 'guild_message_new', guildId: 1, message: { id: 3, channel_id: 5, sender_id: 2, content: 'hi', timestamp: 400 } }));
    await waitFor(() => expect(markChannelRead).toHaveBeenCalledTimes(2));
    expect(result.current.firstUnread).toEqual({ id: 2 });
  });

  it("doesn't for a document's replies (the channel's unread may be under other documents)", async () => {
    markChannelRead.mockResolvedValueOnce(2);
    const { result } = renderHook(() => useChannel({ channelId: 5, documentId: 9, user: { id: 1 } }));
    await waitFor(() => expect(markChannelRead).toHaveBeenCalled());
    await act(async () => {});
    expect(result.current.firstUnread).toBeNull();
  });
});

describe('useChannel and bots', () => {
  it('puts an ephemeral reply in time order, edits it, and drops it on delete or Dismiss', async () => {
    const { result } = await load();
    const message = { id: EPHEMERAL, channel_id: 5, sender_id: 7, content: 'only you', timestamp: 200, ephemeral: true };
    act(() => emit({ type: 'guild_ephemeral_message', guildId: 1, channelId: 5, message }));
    expect(result.current.messages.map((m) => m.id)).toEqual([1, EPHEMERAL, 2]);
    expect(result.current.messages[1].plaintext).toBe('only you');
    // Another channel's: not here.
    act(() => emit({ type: 'guild_ephemeral_message', guildId: 1, channelId: 6, message: { ...message, id: EPHEMERAL + 1 } }));
    expect(result.current.messages).toHaveLength(3);

    act(() => emit({ type: 'guild_ephemeral_edit', guildId: 1, channelId: 5, message: { ...message, content: 'changed', edited: 1 } }));
    expect(result.current.messages[1].plaintext).toBe('changed');
    act(() => emit({ type: 'guild_ephemeral_delete', guildId: 1, channelId: 5, messageId: EPHEMERAL }));
    expect(result.current.messages.map((m) => m.id)).toEqual([1, 2]);

    act(() => emit({ type: 'guild_ephemeral_message', guildId: 1, channelId: 5, message }));
    act(() => requestDismiss(EPHEMERAL));
    expect(result.current.messages.map((m) => m.id)).toEqual([1, 2]);
  });

  it('takes new components from a bot\'s edit', async () => {
    const { result } = await load();
    const components = [{ type: 1, components: [{ type: 2, style: 3, label: 'Done', custom_id: 'x', disabled: true }] }];
    act(() => emit({ type: 'guild_message_edit', guildId: 1, channelId: 5, messageId: 2, content: 'updated', components }));
    expect(result.current.messages[1]).toMatchObject({ plaintext: 'updated', components });
  });
});
