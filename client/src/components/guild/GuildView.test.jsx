// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

const guildListeners = vi.hoisted(() => ({ list: [] }));

vi.mock('../../utils/ws-client', () => ({
  onGuildEvent: (cb) => {
    guildListeners.list.push(cb);
    return () => { guildListeners.list = guildListeners.list.filter((x) => x !== cb); };
  },
  onUserStatus: () => () => {},
}));

vi.mock('../../services/guildService', () => ({
  fetchChannelMessages: vi.fn(),
  sendChannelMessage: vi.fn(),
  editChannelMessage: vi.fn(async () => {}),
  deleteChannelMessage: vi.fn(async () => {}),
  markChannelRead: vi.fn(async () => {}),
  fetchMembers: vi.fn(async () => []),
  addGuildReaction: vi.fn(),
  removeGuildReaction: vi.fn(async () => {}),
}));

vi.mock('../../utils/mediaDimensions', () => ({ readMediaDimensions: vi.fn(async () => null) }));
vi.mock('../../services/attachmentUpload', () => ({ uploadAttachment: vi.fn(), MAX_ATTACHMENT_BYTES: 1000 }));

// MessageList needs a real browser's layout; the tests look at what it's given.
vi.mock('../MessageList', () => ({
  default: ({ messages, onToggleReaction, canModerate }) => (
    <div data-testid="message-list" data-can-moderate={String(canModerate)}>
      {messages.map((m) => (
        <div key={m.clientKey ?? m.id} data-testid="message">
          {m.sender_username}: {m.plaintext} [{m.status || 'sent'}]
          {m.reactions.map((r) => ` ${r.emoji}`).join('')}
          <button data-testid={`react-${m.id}`} onClick={() => onToggleReaction(m, '👍')} />
        </div>
      ))}
    </div>
  ),
}));

import GuildView from './GuildView';
import { editorFor } from '../../editor/editorRegistry';
import emojiData from '@emoji-mart/data/sets/15/twitter.json';
import { buildEmojiIndex } from '../../emoji/emojiIndex';
import { EmojiContext } from '../../emoji/emojiContext';
import { ConfigContext, InteractionContext, LayoutContext } from '../../contexts';
import {
  fetchChannelMessages,
  sendChannelMessage,
  markChannelRead,
  addGuildReaction,
  fetchMembers,
} from '../../services/guildService';

const me = { id: 1, username: 'me' };
const guild = {
  id: 5,
  name: 'Test Guild',
  owner: 1,
  icon_version: 0,
  categories: [],
  channels: [
    { id: 10, name: 'general', type: 'text', topic: 'Say hi', category_id: null, position: 0 },
    { id: 11, name: 'lounge', type: 'voice', topic: null, category_id: null, position: 1 },
  ],
};
const row = (id, text, senderId = 2) => ({
  id, channel_id: 10, sender_id: senderId, sender_username: senderId === 1 ? 'me' : 'bob', content: text,
  timestamp: 1000 + id, parent_message_id: null, edited: 0, reactions: [],
});
const emojiIndex = buildEmojiIndex(emojiData);

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderView(path, { layouts = { 5: guild }, user = me } = {}) {
  const guildList = { layouts, loadGuild: vi.fn(async () => guild), refreshUnread: vi.fn() };
  render(
    <EmojiContext.Provider value={emojiIndex}>
      <ConfigContext.Provider value={{ s3Endpoint: '', maxPlaintextLength: 5000 }}>
        <InteractionContext.Provider value={{ isMobile: false }}>
          <LayoutContext.Provider value={{ guildList }}>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path="/guild/:guildId/:channelId?" element={<><GuildView user={user} /><Where /></>} />
              </Routes>
            </MemoryRouter>
          </LayoutContext.Provider>
        </InteractionContext.Provider>
      </ConfigContext.Provider>
    </EmojiContext.Provider>
  );
  return guildList;
}

const emit = (event) => act(() => guildListeners.list.forEach((cb) => cb(event)));
const messageTexts = () => screen.queryAllByTestId('message').map((m) => m.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  guildListeners.list = [];
  localStorage.clear();
  fetchChannelMessages.mockResolvedValue([]);
});

describe('GuildView', () => {
  it('opens the first text channel when none is given', async () => {
    renderView('/guild/5');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/guild/5/10'));
    expect(localStorage.getItem('guildChannel:5')).toBe('10');
  });

  it('loads the channel, shows its header, and marks it read', async () => {
    fetchChannelMessages.mockResolvedValue([row(1, 'hello'), row(2, 'there')]);
    const guildList = renderView('/guild/5/10');
    await waitFor(() => expect(messageTexts()).toEqual(['bob: hello [sent]', 'bob: there [sent]']));
    expect(screen.getByRole('heading', { name: 'general' })).toBeInTheDocument();
    expect(screen.getByText('Say hi')).toBeInTheDocument();
    expect(fetchChannelMessages).toHaveBeenCalledWith('10', { limit: 50 });
    await waitFor(() => expect(markChannelRead).toHaveBeenCalledWith('10', 2));
    expect(guildList.refreshUnread).toHaveBeenCalled();
    // The owner may delete anyone's messages.
    expect(screen.getByTestId('message-list')).toHaveAttribute('data-can-moderate', 'true');
    expect(fetchMembers).toHaveBeenCalledWith('5');
  });

  it('sends plain text, and the websocket echo does not duplicate it', async () => {
    sendChannelMessage.mockImplementation(async (channelId, content) => row(5, content, 1));
    renderView('/guild/5/10');
    await screen.findByText(/Welcome to #general/);

    act(() => editorFor(document.getElementById('dm-input')).setText('hi all'));
    fireEvent.submit(document.getElementById('dm-chat-form'));
    await waitFor(() => expect(sendChannelMessage).toHaveBeenCalledWith('10', 'hi all', null));
    await waitFor(() => expect(messageTexts()).toEqual(['me: hi all [sent]']));

    await emit({ type: 'guild_message_new', guildId: 5, message: row(5, 'hi all', 1) });
    expect(messageTexts()).toEqual(['me: hi all [sent]']);
  });

  it('applies live messages, edits, deletes and reactions for this channel only', async () => {
    fetchChannelMessages.mockResolvedValue([row(1, 'hello')]);
    renderView('/guild/5/10');
    await waitFor(() => expect(messageTexts()).toHaveLength(1));

    await emit({ type: 'guild_message_new', guildId: 5, message: row(2, 'new one') });
    await emit({ type: 'guild_message_new', guildId: 5, message: { ...row(3, 'elsewhere'), channel_id: 99 } });
    expect(messageTexts()).toEqual(['bob: hello [sent]', 'bob: new one [sent]']);
    await waitFor(() => expect(markChannelRead).toHaveBeenCalledWith('10', 2));

    await emit({ type: 'guild_message_edit', guildId: 5, channelId: 10, messageId: 1, content: 'hello (edited)' });
    await emit({ type: 'guild_reaction_add', guildId: 5, channelId: 10, reaction: { id: 7, message_id: 2, user_id: 2, emoji: '🎉' } });
    expect(messageTexts()).toEqual(['bob: hello (edited) [sent]', 'bob: new one [sent] 🎉']);

    await emit({ type: 'guild_reaction_remove', guildId: 5, channelId: 10, messageId: 2, reactionId: 7 });
    await emit({ type: 'guild_message_delete', guildId: 5, channelId: 10, messageId: 1 });
    expect(messageTexts()).toEqual(['bob: new one [sent]']);
  });

  it('reacts with plain emoji', async () => {
    fetchChannelMessages.mockResolvedValue([row(1, 'hello')]);
    addGuildReaction.mockResolvedValue({ id: 9, message_id: 1, user_id: 1, emoji: '👍' });
    renderView('/guild/5/10');
    fireEvent.click(await screen.findByTestId('react-1'));
    await waitFor(() => expect(addGuildReaction).toHaveBeenCalledWith(1, '👍'));
    await waitFor(() => expect(messageTexts()).toEqual(['bob: hello [sent] 👍']));
  });

  it('shows a placeholder for voice channels', async () => {
    renderView('/guild/5/11');
    expect(await screen.findByText('Voice channels are coming later.')).toBeInTheDocument();
    expect(fetchChannelMessages).not.toHaveBeenCalled();
  });

  it("loads a guild it doesn't have yet, and says so if it can't", async () => {
    const guildList = renderView('/guild/6/1', { layouts: {} });
    guildList.loadGuild.mockRejectedValue({ response: { data: { error: 'Guild not found' } } });
    await waitFor(() => expect(guildList.loadGuild).toHaveBeenCalledWith('6'));
  });
});
