// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

const guildListeners = vi.hoisted(() => ({ list: [] }));

vi.mock('../../utils/ws-client', () => ({
  setActiveChat: vi.fn(),
  setSideChat: vi.fn(),
  onGuildEvent: (cb) => {
    guildListeners.list.push(cb);
    return () => { guildListeners.list = guildListeners.list.filter((x) => x !== cb); };
  },
}));

vi.mock('../../services/guildService', () => ({
  fetchChannelMessages: vi.fn(),
  sendChannelMessage: vi.fn(),
  editChannelMessage: vi.fn(async () => {}),
  deleteChannelMessage: vi.fn(async () => {}),
  markChannelRead: vi.fn(async () => {}),
  fetchMembers: vi.fn(async () => []),
  fetchChannelMembers: vi.fn(async () => [1, 2, 4]),
  addGuildReaction: vi.fn(),
  removeGuildReaction: vi.fn(async () => {}),
  fetchThread: vi.fn(),
  fetchChannelThreads: vi.fn(async () => []),
  setThreadJoined: vi.fn(async () => {}),
  createThread: vi.fn(),
}));

const idleVoice = vi.hoisted(() => ({ status: 'idle', guildId: null, channelId: null, selfMute: false, selfDeaf: false, speaking: [] }));
vi.mock('../../voice/voiceClient', () => ({
  getVoiceSnapshot: () => idleVoice,
  onVoiceChange: () => () => {},
  joinVoice: vi.fn(),
  leaveVoice: vi.fn(),
  setSelfMute: vi.fn(),
  setSelfDeaf: vi.fn(),
}));
vi.mock('../../utils/mediaDimensions', () => ({ readMediaDimensions: vi.fn(async () => null) }));
vi.mock('../../services/attachmentUpload', () => ({ uploadAttachment: vi.fn(), MAX_ATTACHMENT_BYTES: 1000 }));

// MessageList needs a real browser's layout; the tests look at what it's given.
vi.mock('../MessageList', () => ({
  MessageContent: ({ msg }) => <div>{msg.plaintext}</div>,
  default: ({ messages, onToggleReaction, canModerate, canAddReactions, nameColors }) => (
    <div data-testid="message-list" data-can-moderate={String(canModerate)} data-can-react={String(canAddReactions)} data-colors={JSON.stringify(nameColors)}>
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
import { joinVoice } from '../../voice/voiceClient';
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
  fetchChannelMembers,
  fetchThread,
  fetchChannelThreads,
  setThreadJoined,
  createThread,
} from '../../services/guildService';
import { setActiveChat, setSideChat } from '../../utils/ws-client';

const me = { id: 1, username: 'me' };
const guild = {
  id: 5,
  name: 'Test Guild',
  owner: 1,
  icon_version: 0,
  my_permissions: 2047,
  my_role_ids: [],
  roles: [
    { id: 3, name: 'Mods', color: 0xe91e63, position: 2, permissions: 8, hoist: 1, is_everyone: 0 },
    { id: 2, name: 'Plain', color: null, position: 1, permissions: 0, hoist: 0, is_everyone: 0 },
    { id: 1, name: '@everyone', color: null, position: 0, permissions: 135, hoist: 0, is_everyone: 1 },
  ],
  categories: [],
  channels: [
    // Everything up to Administrator, plus Create Threads and Send Messages in Threads.
    { id: 10, name: 'general', type: 'text', topic: 'Say hi', category_id: null, position: 0, my_permissions: 2047 | (1 << 21) | (1 << 22), private: false },
    {
      id: 11, name: 'lounge', type: 'voice', topic: null, category_id: null, position: 1, my_permissions: 2047 | 4096 | 8192, private: false,
      voice: [{ user_id: 2, username: 'bob', self_mute: true, self_deaf: false }],
    },
    { id: 12, name: 'news', type: 'text', topic: null, category_id: null, position: 2, my_permissions: 1, private: true },
  ],
};
const row = (id, text, senderId = 2) => ({
  id, channel_id: 10, sender_id: senderId, sender_username: senderId === 1 ? 'me' : 'bob', content: text,
  timestamp: 1000 + id, parent_message_id: null, edited: 0, reactions: [],
});
const emojiIndex = buildEmojiIndex(emojiData);

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname}{location.search}</div>;
}

function renderView(path, { layouts = { 5: guild }, user = me, voiceEnabled = true } = {}) {
  const guildList = { mutes: {}, isMuted: () => false, applyMute: vi.fn(), layouts, loadGuild: vi.fn(async () => guild), refreshUnread: vi.fn() };
  render(
    <EmojiContext.Provider value={emojiIndex}>
      <ConfigContext.Provider value={{ s3Endpoint: '', maxPlaintextLength: 5000, voiceEnabled }}>
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
    await waitFor(() => expect(sendChannelMessage).toHaveBeenCalledWith('10', 'hi all', null, null));
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

  it("follows the channel's permissions: no composer or reactions without them", async () => {
    fetchChannelMessages.mockResolvedValue([row(1, 'read only')]);
    renderView('/guild/5/12');
    expect(await screen.findByText('You do not have permission to send messages in #news.')).toBeInTheDocument();
    expect(document.getElementById('dm-input')).toBeNull();
    expect(screen.getByTestId('message-list')).toHaveAttribute('data-can-react', 'false');
    expect(screen.getByTestId('message-list')).toHaveAttribute('data-can-moderate', 'false');
    expect(screen.getByLabelText('Private')).toBeInTheDocument();
  });

  it('colours names by their highest coloured role, and follows role changes', async () => {
    fetchMembers.mockResolvedValue([
      { id: 2, username: 'bob', joined_at: 1, role_ids: [2, 3], status: 'online' },
      { id: 4, username: 'plain', joined_at: 1, role_ids: [2], status: 'online' },
    ]);
    fetchChannelMessages.mockResolvedValue([row(1, 'hello')]);
    renderView('/guild/5/10');
    await waitFor(() => expect(JSON.parse(screen.getByTestId('message-list').dataset.colors)).toEqual({ 2: '#e91e63' }));
    await emit({ type: 'guild_member_update', guildId: 5, userId: 2, roleIds: [2] });
    expect(JSON.parse(screen.getByTestId('message-list').dataset.colors)).toEqual({});
  });

  it("shows who's in a voice channel, and joins it", async () => {
    renderView('/guild/5/11');
    const tile = (await screen.findByText('bob')).closest('li');
    expect(within(tile).getByLabelText('Muted')).toBeInTheDocument();
    expect(fetchChannelMessages).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Join Voice' }));
    expect(joinVoice).toHaveBeenCalledWith(5, 11);
    // A voice channel isn't where the guild reopens.
    expect(localStorage.getItem('guildChannel:5')).toBeNull();
  });

  it("says so when voice isn't set up", async () => {
    renderView('/guild/5/11', { voiceEnabled: false });
    expect(await screen.findByText("Voice isn't set up yet.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join Voice' })).toBeNull();
  });

  it('lists and suggests only the people who can see the channel, and tells the server what is open', async () => {
    fetchMembers.mockResolvedValue([
      { id: 1, username: 'me', joined_at: 1, role_ids: [], status: 'online' },
      { id: 2, username: 'bob', joined_at: 1, role_ids: [], status: 'online' },
      { id: 3, username: 'carol', joined_at: 1, role_ids: [], status: 'online' },
    ]);
    fetchChannelMembers.mockResolvedValue([1, 2]);
    renderView('/guild/5/10', {
      layouts: { 5: { ...guild, my_permissions: 2047 | 16384, roles: guild.roles.map((r) => (r.id === 2 ? { ...r, mentionable: 1 } : r)) } },
    });
    await waitFor(() => expect(fetchChannelMembers).toHaveBeenCalledWith(10));
    expect(setActiveChat).toHaveBeenCalledWith('channel-10');
    await waitFor(() => expect(screen.queryByText('carol')).toBeNull());
    expect(screen.getAllByText('bob').length).toBeGreaterThan(0);

    const input = await waitFor(() => document.getElementById('dm-input'));
    act(() => editorFor(input).insertText('@'));
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'bob', 'me', '@Mods', '@Plain',
      '@@everyoneNotify everyone who can see this channel.', '@@hereNotify everyone online who can see this channel.',
    ]);

    // Someone given access later shows up.
    fetchChannelMembers.mockResolvedValue([1, 2, 3]);
    await emit({ type: 'guild_update', guild: { id: 5 } });
    await waitFor(() => expect(screen.getAllByText('carol').length).toBeGreaterThan(0));
  });

  it("loads a guild it doesn't have yet, and says so if it can't", async () => {
    const guildList = renderView('/guild/6/1', { layouts: {} });
    guildList.loadGuild.mockRejectedValue({ response: { data: { error: 'Guild not found' } } });
    await waitFor(() => expect(guildList.loadGuild).toHaveBeenCalledWith('6'));
  });

  describe('threads', () => {
    const thread = { id: 50, parent_id: 10, name: 'Trip planning', owner_id: 2, starter_message_id: 1, archived: false, joined: false, message_count: 1, created_at: 1000, last_activity: 1000 };

    it('opens ?thread= beside the channel, in place of the member list', async () => {
      fetchThread.mockResolvedValue({ thread, starter: row(1, 'shall we plan the trip?') });
      fetchChannelMessages.mockImplementation(async (channelId) => (channelId === '50' ? [{ ...row(7, 'in the thread'), channel_id: 50 }] : [row(1, 'shall we plan the trip?')]));
      renderView('/guild/5/10?thread=50');
      const pane = await screen.findByRole('complementary', { name: 'Thread' });
      expect(within(pane).getByRole('heading', { name: 'Trip planning' })).toBeInTheDocument();
      expect(fetchThread).toHaveBeenCalledWith('50');
      await waitFor(() => expect(fetchChannelMessages).toHaveBeenCalledWith('50', { limit: 50 }));
      await waitFor(() => expect(within(pane).getAllByTestId('message').map((m) => m.textContent)).toEqual(['bob: in the thread [sent]']));
      expect(within(pane).getByText('shall we plan the trip?')).toBeInTheDocument();
      expect(setSideChat).toHaveBeenCalledWith('channel-50');
      expect(document.querySelector('.member-list')).toBeNull();

      fireEvent.click(within(pane).getByRole('button', { name: 'Join' }));
      await waitFor(() => expect(setThreadJoined).toHaveBeenCalledWith(50, true));
      await emit({ type: 'guild_thread_member', guildId: 5, threadId: 50, joined: true });
      expect(within(pane).queryByRole('button', { name: 'Join' })).toBeNull();

      // Renamed live; closing goes back to the channel alone.
      await emit({ type: 'guild_thread_update', guildId: 5, thread: { ...thread, name: 'Trip!' } });
      expect(within(pane).getByRole('heading', { name: 'Trip!' })).toBeInTheDocument();
      fireEvent.click(within(pane).getByRole('button', { name: 'Close thread' }));
      await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/guild\/5\/10$/));
      expect(screen.queryByRole('complementary', { name: 'Thread' })).toBeNull();
    });

    it("lists the channel's threads from the header, and starts one", async () => {
      fetchChannelThreads.mockResolvedValue([thread, { ...thread, id: 51, name: 'Old one', archived: true }]);
      createThread.mockResolvedValue({ ...thread, id: 60, name: 'New idea' });
      fetchThread.mockResolvedValue({ thread: { ...thread, id: 60, name: 'New idea' }, starter: null });
      renderView('/guild/5/10');
      await screen.findByText(/Welcome to #general/);
      fireEvent.click(screen.getByRole('button', { name: 'Threads' }));
      const panel = await screen.findByRole('dialog', { name: 'Threads' });
      await within(panel).findByText('Trip planning');
      expect(within(panel).getByText('Archived')).toBeInTheDocument();
      expect(within(panel).getByText('Old one')).toBeInTheDocument();
      expect(fetchChannelThreads).toHaveBeenCalledWith(10);

      fireEvent.click(within(panel).getByRole('button', { name: /Create/ }));
      const dialog = await screen.findByRole('dialog', { name: 'Create thread' });
      fireEvent.change(within(dialog).getByLabelText('Thread name'), { target: { value: 'New idea' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create thread' }));
      await waitFor(() => expect(createThread).toHaveBeenCalledWith(10, 'New idea', null));
      await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/guild/5/10?thread=60'));
      expect(await screen.findByRole('heading', { name: 'New idea' })).toBeInTheDocument();
    });
  });
});
