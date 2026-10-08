// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

const guildListeners = vi.hoisted(() => ({ list: [] }));

vi.mock('../../utils/ws-client', () => ({
  setActiveChat: vi.fn(),
  onGuildEvent: (cb) => {
    guildListeners.list.push(cb);
    return () => { guildListeners.list = guildListeners.list.filter((x) => x !== cb); };
  },
}));

vi.mock('../../services/guildService', () => ({
  fetchChannelMessages: vi.fn(async () => []),
  sendChannelMessage: vi.fn(),
  editChannelMessage: vi.fn(async () => {}),
  deleteChannelMessage: vi.fn(async () => {}),
  markChannelRead: vi.fn(async () => {}),
  fetchMembers: vi.fn(async () => []),
  fetchChannelMembers: vi.fn(async () => [1, 2]),
  addGuildReaction: vi.fn(),
  removeGuildReaction: vi.fn(async () => {}),
  fetchDocuments: vi.fn(),
  fetchDocument: vi.fn(),
  createDocument: vi.fn(),
  saveDocument: vi.fn(),
  deleteDocument: vi.fn(async () => {}),
  addDocumentReaction: vi.fn(),
  removeDocumentReaction: vi.fn(async () => {}),
}));

vi.mock('../../voice/voiceClient', () => ({
  getVoiceSnapshot: () => ({ status: 'idle', speaking: [] }),
  onVoiceChange: () => () => {},
}));
vi.mock('../../utils/mediaDimensions', () => ({ readMediaDimensions: vi.fn(async () => null), MAX_INLINE_IMAGE_BYTES: 50 * 1024 * 1024 }));
vi.mock('../../services/attachmentUpload', () => ({ uploadAttachment: vi.fn(), maxAttachmentBytes: () => 1000, DEFAULT_MAX_UPLOAD_BYTES: 1000 }));

// MessageList needs a real browser's layout; the tests look at what it's given.
vi.mock('../MessageList', () => ({
  default: ({ messages }) => (
    <div data-testid="message-list">
      {messages.map((m) => <div key={m.clientKey ?? m.id} data-testid="reply">{m.plaintext}</div>)}
    </div>
  ),
  DocumentMarkdown: ({ text }) => <div data-testid="document-body">{text}</div>,
}));

import GuildView from '../guild/GuildView';
import emojiData from '@emoji-mart/data/sets/15/twitter.json';
import { buildEmojiIndex } from '../../emoji/emojiIndex';
import { EmojiContext } from '../../emoji/emojiContext';
import { ConfigContext, InteractionContext, LayoutContext } from '../../contexts';
import {
  addDocumentReaction,
  createDocument,
  fetchChannelMessages,
  fetchDocument,
  fetchDocuments,
  markChannelRead,
  saveDocument,
} from '../../services/guildService';
import { PERMISSIONS as P } from '../../utils/permissions';

const me = { id: 1, username: 'me' };
const ALL = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ADD_REACTIONS | P.CREATE_DOCUMENTS;
const guildWith = (permissions) => ({
  id: 5,
  name: 'Test Guild',
  owner: 9,
  my_permissions: permissions,
  my_role_ids: [],
  roles: [{ id: 1, name: '@everyone', color: null, position: 0, permissions, hoist: 0, is_everyone: 1 }],
  categories: [],
  channels: [
    { id: 20, name: 'handbook', type: 'doc', topic: 'How we work', category_id: null, position: 0, my_permissions: permissions, private: false },
  ],
});

const card = (id, title, extra = {}) => ({
  id, channel_id: 20, title, cover: null, content_start: `# ${title}\n\nAbout **${title}**.`,
  created_by: 2, created_at: 1000 + id, updated_by: 2, updated_at: 1000 + id, version: 1,
  reactions: [], reply_count: 0, last_reply_at: null, last_reply_id: null, ...extra,
});
const full = (doc) => ({ ...doc, content: doc.content_start });

const emojiIndex = buildEmojiIndex(emojiData);

function Where() {
  const { pathname, search } = useLocation();
  return <div data-testid="where">{pathname}{search}</div>;
}

function renderView(path, { permissions = ALL } = {}) {
  const guild = guildWith(permissions);
  const guildList = { mutes: {}, isMuted: () => false, applyMute: vi.fn(), layouts: { 5: guild }, loadGuild: vi.fn(async () => guild), refreshUnread: vi.fn() };
  render(
    <EmojiContext.Provider value={emojiIndex}>
      <ConfigContext.Provider value={{ s3Endpoint: '', maxPlaintextLength: 5000 }}>
        <InteractionContext.Provider value={{ isMobile: false }}>
          <LayoutContext.Provider value={{ guildList }}>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path="/guild/:guildId/:channelId?" element={<><GuildView user={me} /><Where /></>} />
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
const where = () => screen.getByTestId('where').textContent;

beforeEach(() => {
  vi.clearAllMocks();
  guildListeners.list = [];
  fetchDocuments.mockResolvedValue([card(2, 'Second', { reply_count: 3, last_reply_id: 77 }), card(1, 'First')]);
});

describe('document channels', () => {
  it('shows the feed, newest first, with excerpts and reply counts, and marks the channel read', async () => {
    renderView('/guild/5/20');
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Second', 'First']));
    expect(screen.getByText('Second About Second.')).toBeTruthy();
    expect(screen.getByText(/3 replies/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /New document/ })).toBeTruthy();
    await waitFor(() => expect(markChannelRead).toHaveBeenCalledWith(20, 77));
    // No member list in a document channel.
    expect(screen.queryByRole('button', { name: /member list/ })).toBeNull();
  });

  it('offers New document only with Create Documents', async () => {
    renderView('/guild/5/20', { permissions: P.VIEW_CHANNEL | P.SEND_MESSAGES });
    await screen.findByText('Second');
    expect(screen.queryByRole('button', { name: /New document/ })).toBeNull();
  });

  it('keeps the feed current', async () => {
    renderView('/guild/5/20');
    await screen.findByText('Second');
    emit({ type: 'guild_document_upsert', guildId: 5, channelId: 20, document: card(3, 'Third') });
    expect(screen.getAllByRole('heading', { level: 3 })[0].textContent).toBe('Third');
    emit({ type: 'guild_document_delete', guildId: 5, channelId: 20, documentId: 1, replyIds: [] });
    expect(screen.queryByText('First')).toBeNull();
    emit({ type: 'guild_message_new', guildId: 5, message: { id: 90, channel_id: 20, document_id: 3, timestamp: 2000, content: 'hi' } });
    expect(screen.getByText(/1 reply$/)).toBeTruthy();
  });

  it('reacts to a document from its card without opening it', async () => {
    fetchDocuments.mockResolvedValue([card(2, 'Second', { reactions: [{ id: 5, user_id: 2, emoji: '👍', timestamp: 1 }] }), card(1, 'First')]);
    addDocumentReaction.mockResolvedValue({ id: 6, document_id: 2, user_id: 1, emoji: '👍', timestamp: 2 });
    renderView('/guild/5/20');
    fireEvent.click(await screen.findByRole('button', { name: /👍 1/ }));
    await waitFor(() => expect(addDocumentReaction).toHaveBeenCalledWith(2, '👍'));
    await waitFor(() => expect(screen.getByRole('button', { name: /👍 2/ })).toBeTruthy());
    expect(where()).toBe('/guild/5/20');
    // A card without reactions still offers one, with Add Reactions.
    expect(screen.getAllByRole('button', { name: 'Add reaction' })).toHaveLength(2);
  });

  it('offers no new reactions on cards without Add Reactions', async () => {
    renderView('/guild/5/20', { permissions: P.VIEW_CHANNEL | P.SEND_MESSAGES });
    await screen.findByText('Second');
    expect(screen.queryByRole('button', { name: 'Add reaction' })).toBeNull();
  });

  it('opens a document with its replies, and reacts to it', async () => {
    const doc = full(card(2, 'Second', { reactions: [{ id: 5, user_id: 2, emoji: '👍', timestamp: 1 }] }));
    fetchDocument.mockResolvedValue(doc);
    fetchChannelMessages.mockResolvedValue([{ id: 70, channel_id: 20, document_id: 2, sender_id: 2, content: 'Nice doc', timestamp: 1, reactions: [] }]);
    addDocumentReaction.mockResolvedValue({ id: 6, document_id: 2, user_id: 1, emoji: '👍', timestamp: 2 });
    renderView('/guild/5/20');
    fireEvent.click(await screen.findByRole('button', { name: 'Open Second' }));
    expect(where()).toBe('/guild/5/20?doc=2');

    expect(await screen.findByRole('heading', { level: 1, name: 'Second' })).toBeTruthy();
    expect(screen.getByTestId('document-body').textContent).toBe(doc.content);
    await waitFor(() => expect(screen.getAllByTestId('reply').map((r) => r.textContent)).toEqual(['Nice doc']));
    expect(fetchChannelMessages).toHaveBeenCalledWith(20, expect.objectContaining({ document: 2 }));
    // Someone else's document: no Edit without Manage Messages.
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /👍 1/ }));
    await waitFor(() => expect(addDocumentReaction).toHaveBeenCalledWith(2, '👍'));
    await waitFor(() => expect(screen.getByRole('button', { name: /👍 2/ })).toBeTruthy());
    // The websocket echo isn't counted twice.
    emit({ type: 'guild_document_reaction_add', guildId: 5, channelId: 20, reaction: { id: 6, document_id: 2, user_id: 1, emoji: '👍', timestamp: 2 } });
    expect(screen.getByRole('button', { name: /👍 2/ })).toBeTruthy();

    emit({ type: 'guild_document_delete', guildId: 5, channelId: 20, documentId: 2, replyIds: [70] });
    expect(screen.getByText(/This document was deleted/)).toBeTruthy();
  });

  it('writes a new document and opens it', async () => {
    createDocument.mockImplementation(async (_channelId, body) => ({ ...full(card(4, body.title)), content: body.content, created_by: 1 }));
    fetchDocument.mockImplementation(async (id) => ({ ...full(card(id, 'My doc')), created_by: 1 }));
    renderView('/guild/5/20');
    fireEvent.click(await screen.findByRole('button', { name: /New document/ }));
    expect(where()).toBe('/guild/5/20?doc=new');

    const title = await screen.findByRole('textbox', { name: 'Title' });
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText('Give the document a title.')).toBeTruthy();

    fireEvent.change(title, { target: { value: '  My   doc ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(createDocument).toHaveBeenCalledWith(20, { title: 'My doc', cover: null, content: '' }));
    await waitFor(() => expect(where()).toBe('/guild/5/20?doc=4'));
    // Your own: you can edit it.
    expect(await screen.findByRole('button', { name: /Edit/ })).toBeTruthy();
  });

  it('refuses to overwrite a newer save until you choose', async () => {
    const mine = { ...full(card(2, 'Mine')), created_by: 1 };
    fetchDocument.mockResolvedValue(mine);
    const theirs = { ...mine, title: 'Theirs', content: 'Their text', version: 2 };
    saveDocument.mockRejectedValueOnce({ response: { status: 409, data: { error: 'conflict', document: theirs } } });
    saveDocument.mockResolvedValueOnce({ ...theirs, title: 'Theirs', version: 3 });
    renderView('/guild/5/20?doc=2&edit=1');

    const title = await screen.findByRole('textbox', { name: 'Title' });
    fireEvent.change(title, { target: { value: 'Mine, edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Someone else saved this document/)).toBeTruthy();
    expect(saveDocument).toHaveBeenCalledWith(2, expect.objectContaining({ version: 1, title: 'Mine, edited' }));

    fireEvent.click(screen.getByRole('button', { name: 'Load their version' }));
    expect(screen.getByRole('textbox', { name: 'Title' }).value).toBe('Theirs');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveDocument).toHaveBeenLastCalledWith(2, expect.objectContaining({ version: 2, content: 'Their text' })));
    await waitFor(() => expect(where()).toBe('/guild/5/20?doc=2'));
  });
});
