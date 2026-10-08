// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';

const dmListeners = vi.hoisted(() => ({ newDm: [], deleteDm: [], editDm: [], reactionAdd: [], reactionRemove: [], pin: [] }));

vi.mock('../utils/ws-client', () => ({
  setActiveChat: vi.fn(),
  onNewDm: (cb) => {
    dmListeners.newDm.push(cb);
    return () => { dmListeners.newDm = dmListeners.newDm.filter((x) => x !== cb); };
  },
  onDeleteDm: (cb) => {
    dmListeners.deleteDm.push(cb);
    return () => { dmListeners.deleteDm = dmListeners.deleteDm.filter((x) => x !== cb); };
  },
  onEditDm: (cb) => {
    dmListeners.editDm.push(cb);
    return () => { dmListeners.editDm = dmListeners.editDm.filter((x) => x !== cb); };
  },
  onReactionAdd: (cb) => {
    dmListeners.reactionAdd.push(cb);
    return () => { dmListeners.reactionAdd = dmListeners.reactionAdd.filter((x) => x !== cb); };
  },
  onReactionRemove: (cb) => {
    dmListeners.reactionRemove.push(cb);
    return () => { dmListeners.reactionRemove = dmListeners.reactionRemove.filter((x) => x !== cb); };
  },
  onDmPin: (cb) => {
    dmListeners.pin.push(cb);
    return () => { dmListeners.pin = dmListeners.pin.filter((x) => x !== cb); };
  },
  onDmLinkPreviews: () => () => {},
}));

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock('../services/dmService', () => ({
  fetchMessagesForUser: vi.fn(),
  sendMessageToUser: vi.fn(),
  markMessagesRead: vi.fn(),
  addReaction: vi.fn(),
  removeReaction: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  editMessage: vi.fn(async () => {}),
  fetchPins: vi.fn(async () => []),
  setMessagePinned: vi.fn(),
}));

vi.mock('../services/encryptionService', () => {
  const decryptMessage = vi.fn(async (content) => `dec(${content})`);
  const dmContext = (sender, recipient) => `ctx:${sender}->${recipient}`;
  return {
    encryptMessage: vi.fn(async (text) => `enc(${text})`),
    decryptMessage,
    deriveConversationKey: vi.fn(async () => 'shared-key'),
    dmContext,
    reactionContext: (messageId, reactorId) => `rctx:${messageId}:${reactorId}`,
    encryptReaction: vi.fn(async (emoji) => `renc(${emoji})`),
    decryptReaction: vi.fn(async (content) => content.replace(/^renc\((.*)\)$/, '$1')),
    decryptMessageRow: vi.fn(async (m, key) => ({
      ...m,
      plaintext: await decryptMessage(m.content, key, dmContext(m.sender_id, m.recipient_id)),
      parent_plaintext: null,
    })),
    decryptMessagesBatch: vi.fn(async (messages) =>
      messages.map((m) => ({ ...m, plaintext: m.plaintext ?? `dec:${m.content}` }))
    ),
  };
});

vi.mock('../utils/mediaDimensions', () => ({
  readMediaDimensions: vi.fn(async () => null),
  MAX_INLINE_IMAGE_BYTES: 50 * 1024 * 1024,
}));

vi.mock('../services/attachmentUpload', () => ({
  uploadAttachment: vi.fn(),
  maxAttachmentBytes: () => 1000,
  DEFAULT_MAX_UPLOAD_BYTES: 1000,
}));

vi.mock('../services/keyStore', () => ({
  loadEncryptionKey: vi.fn(async () => 'my-encryption-key'),
}));

vi.mock('../services/contactKeys', () => ({
  checkContactKeys: vi.fn(),
  acceptContactKeys: vi.fn(async () => {}),
}));

vi.mock('./SafetyNumberDialog', () => ({
  default: ({ contact }) => <div role="dialog">Safety number with {contact.username}</div>,
}));

// Stub MessageList (its scrolling/layout needs a real browser) so these tests exercise
// Dm's own state machine (fetch/send/receive) rather than virtualization.
vi.mock('./MessageList', () => ({
  MessageContent: ({ msg }) => <div>{msg.plaintext}</div>,
  default: ({
    messages, loadMoreMessages, hasMore, onToggleReaction, onOpenReactionPicker, onOpenActions, focusedMsgId,
    handleEdit, handleDelete, editingMessageId, setEditingMessageContent, handleSaveEdit, onTogglePin,
  }) => (
    <div data-testid="message-list" data-has-more={String(hasMore)} data-focused={focusedMsgId ?? ''}>
      <span data-testid="editing">{editingMessageId ?? ''}</span>
      <input data-testid="edit-text" onChange={(e) => setEditingMessageContent(e.target.value)} />
      <button data-testid="save-edit" onClick={() => handleSaveEdit(editingMessageId)} />
      <button data-testid="load-older" onClick={() => loadMoreMessages()} />
      {messages.map((m) => (
        <div key={m.clientKey ?? m.id}>
          {m.plaintext} [{m.status || 'sent'}]{m.pinned_at ? ' [pinned]' : ''}
          {m.reactions?.length > 0 && (
            <span data-testid={`reactions-${m.id}`}>{m.reactions.map((r) => `${r.emoji}:${r.user_id}`).join(' ')}</span>
          )}
          <button data-testid={`toggle-thumbs-${m.id}`} onClick={() => onToggleReaction(m, '👍')} />
          <button data-testid={`react-${m.id}`} onClick={(e) => onOpenReactionPicker(m, e.currentTarget)} />
          <button data-testid={`hold-${m.id}`} onClick={() => onOpenActions(m)} />
          <button data-testid={`edit-${m.id}`} onClick={() => handleEdit(m)} />
          <button data-testid={`delete-${m.id}`} onClick={(e) => handleDelete(m, e)} />
          <button data-testid={`pin-${m.id}`} onClick={() => onTogglePin(m)} />
        </div>
      ))}
    </div>
  ),
}));

import Dm from './Dm';
import { editorFor } from '../editor/editorRegistry';
import { clearDrafts, saveDraft } from '../services/draftStore';
import api from '../utils/api';

// The message box is an editor (contenteditable), which jsdom can't type into: tests drive
// it through its handle.
const box = () => document.getElementById('dm-input');
const boxText = () => editorFor(box()).getText();
const setBoxText = (text) => act(() => { editorFor(box()).setText(text); });
import emojiData from '@emoji-mart/data/sets/15/twitter.json';
import { buildEmojiIndex } from '../emoji/emojiIndex';
import { EmojiContext } from '../emoji/emojiContext';
import { resetEmojiUsage } from '../emoji/emojiUsage';
import { CustomEmojiContext } from '../emoji/customEmojiContext';
import { ConfigContext, InteractionContext } from '../contexts';
import { LayoutContext } from '../contexts';
import {
  fetchMessagesForUser, sendMessageToUser, markMessagesRead, addReaction, removeReaction, deleteMessage, editMessage,
  fetchPins, setMessagePinned,
} from '../services/dmService';
import { deriveConversationKey, encryptMessage, decryptMessage, encryptReaction } from '../services/encryptionService';
import { checkContactKeys, acceptContactKeys } from '../services/contactKeys';
import { uploadAttachment } from '../services/attachmentUpload';
import { readMediaDimensions } from '../utils/mediaDimensions';

const currentUser = { id: 1, username: 'me' };
const chatUserFull = {
  id: 2, username: 'bob', identity_key: 'bob-identity', encryption_key: 'bob-enc', encryption_key_signature: 'bob-sig',
};
const chatUserNoKey = { id: 3, username: 'nokey' };
const carol = { ...chatUserFull, id: 4, username: 'carol' };

// Lets a test move to another route without remounting the page.
let navigateTo;
function NavigateHandle() {
  navigateTo = useNavigate();
  return null;
}

const emojiIndex = buildEmojiIndex(emojiData);

const noCustomEmoji = { guilds: [], byId: new Map() };

function renderDm({ path, users, user = currentUser, layoutOverrides = {}, isMobile = false, customEmoji = noCustomEmoji } = {}) {
  return render(
    <CustomEmojiContext.Provider value={customEmoji}>
    <EmojiContext.Provider value={emojiIndex}>
    <ConfigContext.Provider value={{ s3Endpoint: 'https://s3.test', maxPlaintextLength: 5000 }}>
      <InteractionContext.Provider value={{ isMobile }}>
        <LayoutContext.Provider
          value={{ unreadDms: {}, users, errorUsers: null, fetchUnreadMessages: vi.fn(), ...layoutOverrides }}
        >
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/dm/:id?" element={<Dm user={user} />} />
            </Routes>
            <NavigateHandle />
          </MemoryRouter>
        </LayoutContext.Provider>
      </InteractionContext.Provider>
    </ConfigContext.Provider>
    </EmojiContext.Provider>
    </CustomEmojiContext.Provider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dmListeners.newDm = [];
  dmListeners.deleteDm = [];
  dmListeners.editDm = [];
  dmListeners.reactionAdd = [];
  dmListeners.reactionRemove = [];
  dmListeners.pin = [];
  localStorage.clear();
  resetEmojiUsage();
  clearDrafts();
  fetchPins.mockResolvedValue([]);
  fetchMessagesForUser.mockResolvedValue([]);
  deriveConversationKey.mockResolvedValue('shared-key');
  checkContactKeys.mockImplementation(async (me, contact) =>
    contact.identity_key
      ? { status: 'trusted', encryptionKey: contact.encryption_key }
      : { status: 'invalid', encryptionKey: null }
  );
  let blobCount = 0;
  URL.createObjectURL = vi.fn(() => `blob:local-${++blobCount}`);
  URL.revokeObjectURL = vi.fn();
});

describe('Dm', () => {
  it('shows the empty state when there is no active conversation', () => {
    renderDm({ path: '/dm', users: [] });

    expect(screen.getByText('No recent conversations found.')).toBeInTheDocument();
  });

  it("blocks a conversation whose keys can't be verified, without loading it", async () => {
    renderDm({ path: '/dm/3', users: [chatUserNoKey] });

    expect(await screen.findByText(/encryption keys can't be verified/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Accept/ })).not.toBeInTheDocument();
    expect(document.getElementById('dm-input')).toBeNull();
    expect(fetchMessagesForUser).not.toHaveBeenCalled();
  });

  it('fetches and displays decrypted messages for a valid conversation', async () => {
    fetchMessagesForUser.mockResolvedValue([
      { id: 10, sender_id: 2, recipient_id: 1, content: 'ENC1', timestamp: 1000 },
      { id: 11, sender_id: 1, recipient_id: 2, content: 'ENC2', timestamp: 1001 },
    ]);

    renderDm({ path: '/dm/2', users: [chatUserFull] });

    expect(await screen.findByText('dec:ENC1 [sent]')).toBeInTheDocument();
    expect(screen.getByText('dec:ENC2 [sent]')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
  });

  it('optimistically shows a pending message then marks it sent once the server responds', async () => {
    let resolveSend;
    sendMessageToUser.mockReturnValue(
      new Promise((resolve) => { resolveSend = resolve; })
    );

    renderDm({ path: '/dm/2', users: [chatUserFull] });
    await screen.findByText('No messages yet. Start the conversation!');

    setBoxText('hello bob');
    fireEvent.submit(document.getElementById('dm-chat-form'));

    expect(await screen.findByText('hello bob [pending]')).toBeInTheDocument();

    await act(async () => {
      resolveSend({ id: 99, sender_id: 1, recipient_id: 2, content: 'ENCX', timestamp: 2000 });
    });

    expect(await screen.findByText('hello bob [sent]')).toBeInTheDocument();
    expect(screen.queryByText('hello bob [pending]')).not.toBeInTheDocument();
  });

  it('appends an incoming new_dm websocket event for the active conversation', async () => {
    renderDm({ path: '/dm/2', users: [chatUserFull] });
    await screen.findByText('No messages yet. Start the conversation!');
    await waitFor(() => expect(dmListeners.newDm.length).toBeGreaterThan(0));

    await act(async () => {
      dmListeners.newDm[dmListeners.newDm.length - 1]({
        id: 55,
        sender_id: 2,
        recipient_id: 1,
        content: 'ENC-HELLO',
        timestamp: 3000,
      });
    });

    expect(await screen.findByText('dec(ENC-HELLO) [sent]')).toBeInTheDocument();
  });

  it('saves an edit, encrypted', async () => {
    fetchMessagesForUser.mockResolvedValue([{ id: 11, sender_id: 1, recipient_id: 2, content: 'ENC2', timestamp: 1 }]);
    renderDm({ path: '/dm/2', users: [chatUserFull] });
    await screen.findByText('dec:ENC2 [sent]');

    fireEvent.click(screen.getByTestId('edit-11'));
    expect(screen.getByTestId('editing')).toHaveTextContent('11');
    fireEvent.change(screen.getByTestId('edit-text'), { target: { value: 'fixed' } });
    fireEvent.click(screen.getByTestId('save-edit'));

    await waitFor(() => expect(editMessage).toHaveBeenCalledWith(11, 'enc(fixed)', []));
    expect(await screen.findByText('fixed [sent]')).toBeInTheDocument();
    expect(screen.getByTestId('editing')).toBeEmptyDOMElement();
  });

  it('saving an edit left empty or only whitespace just cancels it', async () => {
    fetchMessagesForUser.mockResolvedValue([{ id: 11, sender_id: 1, recipient_id: 2, content: 'ENC2', timestamp: 1 }]);
    renderDm({ path: '/dm/2', users: [chatUserFull] });
    await screen.findByText('dec:ENC2 [sent]');

    for (const value of ['', '  \n\t ']) {
      fireEvent.click(screen.getByTestId('edit-11'));
      fireEvent.change(screen.getByTestId('edit-text'), { target: { value: 'x' } });
      fireEvent.change(screen.getByTestId('edit-text'), { target: { value } });
      fireEvent.click(screen.getByTestId('save-edit'));
      expect(screen.getByTestId('editing')).toBeEmptyDOMElement();
    }
    expect(editMessage).not.toHaveBeenCalled();
    expect(screen.getByText('dec:ENC2 [sent]')).toBeInTheDocument();
  });

  it('on a phone, edits in the message box and saves with Save', async () => {
    fetchMessagesForUser.mockResolvedValue([{ id: 11, sender_id: 1, recipient_id: 2, content: 'ENC2', timestamp: 1 }]);
    renderDm({ path: '/dm/2', users: [chatUserFull], isMobile: true });
    await screen.findByText('dec:ENC2 [sent]');
    setBoxText('half typed');

    fireEvent.click(screen.getByTestId('edit-11'));
    // Not the inline editor: the message box, with the bar above it.
    expect(screen.getByTestId('editing')).toBeEmptyDOMElement();
    expect(screen.getByText('Editing message')).toBeInTheDocument();
    expect(boxText()).toBe('dec:ENC2');
    expect(box()).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();

    setBoxText('fixed');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(editMessage).toHaveBeenCalledWith(11, 'enc(fixed)', []));
    expect(sendMessageToUser).not.toHaveBeenCalled();
    expect(await screen.findByText('fixed [sent]')).toBeInTheDocument();
    expect(screen.queryByText('Editing message')).not.toBeInTheDocument();
    expect(boxText()).toBe('');
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it("on a phone, the editing bar's × stops editing and empties the box, keeping it focused", async () => {
    fetchMessagesForUser.mockResolvedValue([{ id: 11, sender_id: 1, recipient_id: 2, content: 'ENC2', timestamp: 1 }]);
    renderDm({ path: '/dm/2', users: [chatUserFull], isMobile: true });
    await screen.findByText('dec:ENC2 [sent]');

    fireEvent.click(screen.getByTestId('edit-11'));
    expect(box()).toHaveFocus();
    const close = screen.getByRole('button', { name: 'Stop editing' });
    // Pressing it mustn't take the focus (the keyboard would go down).
    expect(fireEvent.mouseDown(close)).toBe(false);
    fireEvent.click(close);

    expect(screen.queryByText('Editing message')).not.toBeInTheDocument();
    expect(boxText()).toBe('');
    expect(box()).toHaveFocus();
    expect(editMessage).not.toHaveBeenCalled();
  });

  it('marks messages read for the active conversation', async () => {
    renderDm({ path: '/dm/2', users: [chatUserFull] });

    await waitFor(() => expect(markMessagesRead).toHaveBeenCalledWith(2));
  });
});

describe('Dm focus', () => {
  const emptyChat = () => screen.findByText('No messages yet. Start the conversation!');

  it('focuses the message box when a conversation opens, and when switching to another', async () => {
    renderDm({ path: '/dm/2', users: [chatUserFull, carol] });
    await emptyChat();
    await waitFor(() => expect(box()).toHaveFocus());

    box().blur();
    act(() => navigateTo('/dm/4'));
    await waitFor(() => expect(box()).toHaveAttribute('aria-label', 'Message carol'));
    expect(box()).toHaveFocus();
  });

  it("doesn't focus it on a phone (that would open the keyboard)", async () => {
    renderDm({ path: '/dm/2', users: [chatUserFull, carol], isMobile: true });
    await emptyChat();
    expect(box()).not.toHaveFocus();
  });

  it("doesn't take the focus from another text box", async () => {
    const search = document.createElement('input');
    document.body.append(search);
    renderDm({ path: '/dm/2', users: [chatUserFull, carol] });
    await emptyChat();
    search.focus();
    act(() => navigateTo('/dm/4'));
    await waitFor(() => expect(box()).toHaveAttribute('aria-label', 'Message carol'));
    expect(search).toHaveFocus();
    search.remove();
  });
});

describe('Dm drafts', () => {
  const emptyChat = () => screen.findByText('No messages yet. Start the conversation!');

  it('keeps what was typed when leaving the page and coming back', async () => {
    const first = renderDm({ path: '/dm/2', users: [chatUserFull, carol] });
    await emptyChat();
    setBoxText('half a thought');
    first.unmount();

    const second = renderDm({ path: '/dm/4', users: [chatUserFull, carol] });
    await emptyChat();
    expect(boxText()).toBe('');
    second.unmount();

    renderDm({ path: '/dm/2', users: [chatUserFull, carol] });
    await emptyChat();
    expect(boxText()).toBe('half a thought');
  });

  it('swaps drafts when switching conversation, and sending forgets it', async () => {
    sendMessageToUser.mockResolvedValue({ id: 99, sender_id: 1, recipient_id: 2, content: 'ENCX', timestamp: 2000 });
    renderDm({ path: '/dm/2', users: [chatUserFull, carol] });
    await emptyChat();
    setBoxText('for bob');

    act(() => navigateTo('/dm/4'));
    await waitFor(() => expect(box()).toHaveAttribute('aria-label', 'Message carol'));
    expect(boxText()).toBe('');
    setBoxText('for carol');

    act(() => navigateTo('/dm/2'));
    await waitFor(() => expect(boxText()).toBe('for bob'));
    fireEvent.submit(document.getElementById('dm-chat-form'));
    expect(await screen.findByText('for bob [sent]')).toBeInTheDocument();

    act(() => navigateTo('/dm/4'));
    await waitFor(() => expect(boxText()).toBe('for carol'));
    act(() => navigateTo('/dm/2'));
    await waitFor(() => expect(box()).toHaveAttribute('aria-label', 'Message bob'));
    expect(boxText()).toBe('');
  });

  it("leaves out unsent attachments, which don't come along", async () => {
    renderDm({ path: '/dm/2', users: [chatUserFull, carol] });
    await emptyChat();
    setBoxText('look: ');
    fireEvent.paste(box(), { clipboardData: { files: [new File(['x'], 'cat.png', { type: 'image/png' })], getData: () => '' } });
    await waitFor(() => expect(boxText()).toBe('look: ![cat.png](attachment:1)'));

    act(() => navigateTo('/dm/4'));
    await waitFor(() => expect(box()).toHaveAttribute('aria-label', 'Message carol'));
    act(() => navigateTo('/dm/2'));

    await waitFor(() => expect(boxText()).toBe('look: '));
    expect(screen.queryByRole('img', { name: 'cat.png' })).not.toBeInTheDocument();
  });

  it("putting a draft back doesn't tell the other person you're typing", async () => {
    saveDraft(4, 'still here');

    renderDm({ path: '/dm/4', users: [carol] });
    await emptyChat();

    expect(boxText()).toBe('still here');
    expect(api.post).not.toHaveBeenCalledWith('/typing', expect.anything());
  });
});

describe('Dm attachments', () => {
  const png = () => new File(['png-bytes'], 'cat.png', { type: 'image/png' });
  const pdf = () => new File(['pdf-bytes'], 'report.pdf', { type: 'application/pdf' });

  async function openChat() {
    renderDm({ path: '/dm/2', users: [chatUserFull] });
    await screen.findByText('No messages yet. Start the conversation!');
    return document.getElementById('dm-input');
  }

  const paste = (textarea, files) => fireEvent.paste(textarea, { clipboardData: { files, getData: () => '' } });

  it('inserts placeholders and shows previews on paste, without uploading anything', async () => {
    const textarea = await openChat();

    paste(textarea, [png(), pdf()]);

    await waitFor(() =>
      expect(boxText()).toBe('![cat.png](attachment:1) ![report.pdf](attachment:2)')
    );
    expect(screen.getByRole('img', { name: 'cat.png' })).toHaveAttribute('src', 'blob:local-1');
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  it('accepts dropped files of any type', async () => {
    await openChat();
    const wrapper = document.querySelector('.dm-chat-wrapper');

    fireEvent.drop(wrapper, { dataTransfer: { files: [pdf()], types: ['Files'] } });

    await waitFor(() => expect(boxText()).toBe('![report.pdf](attachment:1)'));
  });

  it('removing a preview also removes its placeholder from the text', async () => {
    const textarea = await openChat();
    setBoxText('look: ');
    paste(textarea, [png()]);
    await waitFor(() => expect(boxText()).toBe('look: ![cat.png](attachment:1)'));

    fireEvent.click(screen.getByRole('button', { name: 'Remove cat.png' }));

    expect(boxText()).toBe('look: ');
    expect(screen.queryByRole('img', { name: 'cat.png' })).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-1');
  });

  it('rejects files over the size limit', async () => {
    const textarea = await openChat();

    paste(textarea, [new File(['x'.repeat(2000)], 'huge.mov', { type: 'video/quicktime' })]);

    expect(await screen.findByRole('alert')).toHaveTextContent('huge.mov is over the');
    expect(boxText()).toBe('');
  });

  it('uploads on send and sends the message with the real attachment URLs', async () => {
    const finalUrl = 'https://s3.test/uploads/abc.bin#v=1&k=KEY&t=image%2Fpng&s=9';
    let finishUpload;
    uploadAttachment.mockReturnValue(new Promise((resolve) => { finishUpload = resolve; }));
    sendMessageToUser.mockResolvedValue({ id: 99, sender_id: 1, recipient_id: 2, timestamp: 2000 });

    const textarea = await openChat();
    setBoxText('hi ');
    paste(textarea, [png()]);
    await waitFor(() => expect(boxText()).toBe('hi ![cat.png](attachment:1)'));

    fireEvent.submit(document.getElementById('dm-chat-form'));

    // Pending while uploading, still showing the placeholder text.
    expect(await screen.findByText('hi ![cat.png](attachment:1) [pending]')).toBeInTheDocument();
    expect(uploadAttachment).toHaveBeenCalledWith(expect.any(File), expect.any(Function), null, false);
    expect(uploadAttachment.mock.calls[0][0].name).toBe('cat.png');
    expect(sendMessageToUser).not.toHaveBeenCalled();
    expect(boxText()).toBe('');

    await act(async () => finishUpload(finalUrl));

    expect(await screen.findByText(`hi ![cat.png](${finalUrl}) [sent]`)).toBeInTheDocument();
    expect(encryptMessage).toHaveBeenCalledWith(`hi ![cat.png](${finalUrl})`, 'shared-key', 'ctx:1->2');
    expect(sendMessageToUser).toHaveBeenCalledWith(2, `enc(hi ![cat.png](${finalUrl}))`, null, ['abc.bin']);
  });

  it('sends image dimensions with the upload so receivers can reserve space', async () => {
    readMediaDimensions.mockResolvedValueOnce({ width: 800, height: 600 });
    uploadAttachment.mockResolvedValue('https://s3.test/uploads/abc.bin#v=1&k=K&t=image%2Fpng&s=9&w=800&h=600');
    sendMessageToUser.mockResolvedValue({ id: 99, sender_id: 1, recipient_id: 2, timestamp: 2000 });

    const textarea = await openChat();
    paste(textarea, [png()]);
    await waitFor(() => expect(readMediaDimensions).toHaveBeenCalled());
    await act(async () => {});
    fireEvent.submit(document.getElementById('dm-chat-form'));

    await waitFor(() => expect(uploadAttachment).toHaveBeenCalled());
    expect(uploadAttachment.mock.calls[0][2]).toEqual({ width: 800, height: 600 });
  });

  it('does not upload drafts whose placeholder was deleted before sending', async () => {
    sendMessageToUser.mockResolvedValue({ id: 99, sender_id: 1, recipient_id: 2, timestamp: 2000 });
    const textarea = await openChat();
    paste(textarea, [png()]);
    await waitFor(() => expect(boxText()).toBe('![cat.png](attachment:1)'));

    setBoxText('never mind');
    fireEvent.submit(document.getElementById('dm-chat-form'));

    expect(await screen.findByText('never mind [sent]')).toBeInTheDocument();
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-1');
  });

  it('marks the message failed and says why when an upload fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    uploadAttachment.mockRejectedValue(new Error('Upload failed (403)'));

    const textarea = await openChat();
    paste(textarea, [png()]);
    await waitFor(() => expect(boxText()).toBe('![cat.png](attachment:1)'));
    fireEvent.submit(document.getElementById('dm-chat-form'));

    expect(await screen.findByText('![cat.png](attachment:1) [failed]')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Upload failed (403)');
    expect(sendMessageToUser).not.toHaveBeenCalled();
  });

  it('refuses to send when the attachment links would push the message over the limit', async () => {
    const textarea = await openChat();
    setBoxText('x'.repeat(4950));
    paste(textarea, [png()]);
    await waitFor(() => expect(boxText()).toContain('(attachment:1)'));

    fireEvent.submit(document.getElementById('dm-chat-form'));

    expect(await screen.findByRole('alert')).toHaveTextContent('too long once attachment links are added');
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(boxText()).toContain('(attachment:1)');
  });
});

describe('Dm history loading', () => {
  const page = (fromId, count) =>
    Array.from({ length: count }, (_, i) => ({
      id: fromId + i,
      sender_id: 2,
      recipient_id: 1,
      content: `ENC${fromId + i}`,
      timestamp: 1000 + fromId + i,
    }));

  it('fetches the newest page exactly once when opening a chat', async () => {
    fetchMessagesForUser.mockResolvedValue(page(100, 3));

    renderDm({ path: '/dm/2', users: [chatUserFull] });

    expect(await screen.findByText('dec:ENC102 [sent]')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMessagesForUser).toHaveBeenCalledTimes(1);
    expect(fetchMessagesForUser).toHaveBeenCalledWith('2', { limit: 50 });
  });

  const shownIds = () =>
    [...screen.getByTestId('message-list').querySelectorAll('div')].map((d) => d.textContent.match(/ENC(\d+)/)?.[1]).filter(Boolean).map(Number);

  it('prepends older messages above the ones already shown', async () => {
    fetchMessagesForUser.mockResolvedValueOnce(page(100, 3));
    renderDm({ path: '/dm/2', users: [chatUserFull] });
    await screen.findByText('dec:ENC100 [sent]');

    fetchMessagesForUser.mockResolvedValueOnce(page(97, 3));
    fireEvent.click(screen.getByTestId('load-older'));

    expect(await screen.findByText('dec:ENC97 [sent]')).toBeInTheDocument();
    expect(fetchMessagesForUser).toHaveBeenLastCalledWith('2', { before: 100, limit: 50 });
    expect(shownIds()).toEqual([97, 98, 99, 100, 101, 102]);
  });

  it('ignores load-older requests while one is already in flight', async () => {
    fetchMessagesForUser.mockResolvedValueOnce(page(100, 3));
    renderDm({ path: '/dm/2', users: [chatUserFull] });
    await screen.findByText('dec:ENC100 [sent]');

    let resolveOlder;
    fetchMessagesForUser.mockReturnValueOnce(new Promise((r) => { resolveOlder = r; }));
    fireEvent.click(screen.getByTestId('load-older'));
    fireEvent.click(screen.getByTestId('load-older'));
    fireEvent.click(screen.getByTestId('load-older'));
    await act(async () => resolveOlder(page(97, 3)));

    expect(fetchMessagesForUser).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText('dec:ENC97 [sent]')).toHaveLength(1);
  });

  it('drops messages it already has when pages overlap', async () => {
    fetchMessagesForUser.mockResolvedValueOnce(page(100, 3));
    renderDm({ path: '/dm/2', users: [chatUserFull] });
    await screen.findByText('dec:ENC100 [sent]');

    // Overlapping page: 98, 99 are new; 100 is already shown.
    fetchMessagesForUser.mockResolvedValueOnce(page(98, 3));
    fireEvent.click(screen.getByTestId('load-older'));

    expect(await screen.findByText('dec:ENC98 [sent]')).toBeInTheDocument();
    expect(shownIds()).toEqual([98, 99, 100, 101, 102]);
  });

  it('keeps the conversation on screen when loading older messages fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMessagesForUser.mockResolvedValueOnce(page(100, 3));
    renderDm({ path: '/dm/2', users: [chatUserFull] });
    await screen.findByText('dec:ENC100 [sent]');

    fetchMessagesForUser.mockRejectedValueOnce(new Error('network down'));
    fireEvent.click(screen.getByTestId('load-older'));
    await new Promise((r) => setTimeout(r, 20));

    expect(screen.getByText('dec:ENC100 [sent]')).toBeInTheDocument();
    expect(screen.queryByText(/network down/)).not.toBeInTheDocument();
  });

  it('stops asking for older messages once the start of the conversation is reached', async () => {
    fetchMessagesForUser.mockResolvedValueOnce(page(100, 3));
    renderDm({ path: '/dm/2', users: [chatUserFull] });
    await screen.findByText('dec:ENC100 [sent]');

    fetchMessagesForUser.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByTestId('load-older'));

    await waitFor(() => expect(screen.getByTestId('message-list').dataset.hasMore).toBe('false'));
  });
});

describe('Dm contact keys', () => {
  it('derives the conversation key from the checked key, not straight from the server', async () => {
    checkContactKeys.mockResolvedValueOnce({ status: 'trusted', encryptionKey: 'pinned-enc' });
    renderDm({ path: '/dm/2', users: [chatUserFull] });

    await screen.findByText('No messages yet. Start the conversation!');
    expect(checkContactKeys).toHaveBeenCalledWith(1, chatUserFull);
    expect(deriveConversationKey).toHaveBeenCalledWith('my-encryption-key', 'pinned-enc');
  });

  it('binds sender and recipient when sending and when receiving', async () => {
    sendMessageToUser.mockResolvedValue({ id: 99, sender_id: 1, recipient_id: 2, timestamp: 2000 });
    renderDm({ path: '/dm/2', users: [chatUserFull] });
    await screen.findByText('No messages yet. Start the conversation!');

    setBoxText('hello');
    fireEvent.submit(document.getElementById('dm-chat-form'));
    await screen.findByText('hello [sent]');
    expect(encryptMessage).toHaveBeenCalledWith('hello', 'shared-key', 'ctx:1->2');

    await waitFor(() => expect(dmListeners.newDm.length).toBeGreaterThan(0));
    await act(async () => {
      dmListeners.newDm.at(-1)({ id: 100, sender_id: 2, recipient_id: 1, content: 'ENC-IN', timestamp: 3000 });
    });
    expect(decryptMessage).toHaveBeenCalledWith('ENC-IN', 'shared-key', 'ctx:2->1');
  });

  it('does not show the safety number badge (hidden for now)', async () => {
    checkContactKeys.mockResolvedValueOnce({ status: 'verified', encryptionKey: 'bob-enc' });
    renderDm({ path: '/dm/2', users: [chatUserFull] });

    await screen.findByText('No messages yet. Start the conversation!');
    expect(screen.queryByRole('button', { name: /verified/i })).toBeNull();
  });

  it('blocks the chat when the key changed, until the user accepts it', async () => {
    checkContactKeys
      .mockResolvedValueOnce({ status: 'changed', encryptionKey: null })
      .mockResolvedValueOnce({ status: 'trusted', encryptionKey: 'bob-enc' });
    renderDm({ path: '/dm/2', users: [chatUserFull] });

    expect(await screen.findByText(/security key has changed/)).toBeInTheDocument();
    expect(document.getElementById('dm-input')).toBeNull();
    expect(fetchMessagesForUser).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Accept the new key' }));

    await screen.findByText('No messages yet. Start the conversation!');
    expect(acceptContactKeys).toHaveBeenCalledWith(1, chatUserFull);
    expect(document.getElementById('dm-input')).not.toBeNull();
  });
});

describe('Dm emoji', () => {
  async function openChat() {
    renderDm({ path: '/dm/2', users: [chatUserFull] });
    await screen.findByText('No messages yet. Start the conversation!');
    return document.getElementById('dm-input');
  }
  const type = (textarea, value) => setBoxText(value);

  it('the emoji button opens the picker and does not send the message', async () => {
    const textarea = await openChat();
    type(textarea, 'draft');

    fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));

    expect(screen.getByRole('dialog', { name: 'Emoji picker' })).toBeInTheDocument();
    expect(sendMessageToUser).not.toHaveBeenCalled();
    expect(boxText()).toBe('draft');
  });

  it('inserts a picked emoji at the cursor', async () => {
    const textarea = await openChat();
    type(textarea, 'hi ');
    fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));

    fireEvent.click(screen.getByRole('button', { name: 'Grinning Face' }));

    expect(boxText()).toBe('hi 😀');
    expect(screen.queryByRole('dialog', { name: 'Emoji picker' })).not.toBeInTheDocument();
  });

  it('suggests emoji for ":sm" and inserts the chosen one with Tab or Enter', async () => {
    const textarea = await openChat();
    type(textarea, 'hello :smi');

    const list = screen.getByRole('listbox', { name: 'Emoji matching :smi' });
    expect(within(list).getAllByRole('option')[0]).toHaveTextContent(':smile:');

    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(boxText()).toBe('hello 😄 ');
    expect(sendMessageToUser).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('moves through suggestions with the arrow keys and dismisses them with Escape', async () => {
    const textarea = await openChat();
    type(textarea, ':smi');
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('does not suggest for times or URLs', async () => {
    const textarea = await openChat();
    type(textarea, 'at 12:30');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    type(textarea, 'see https://example');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('turns a completed :shortcode: into the emoji as you type', async () => {
    const textarea = await openChat();
    type(textarea, 'nice :+1:');
    await waitFor(() => expect(boxText()).toBe('nice 👍'));

    type(textarea, 'nice 👍 :notarealemoji:');
    await act(async () => {});
    expect(boxText()).toBe('nice 👍 :notarealemoji:');
  });

  describe('custom emoji', () => {
    const guild = { id: 7, name: 'Blob Land', icon_version: 0 };
    const blob = { id: 10, name: 'blob', guild };
    const customEmoji = { guilds: [{ guild, emojis: [blob] }], byId: new Map([['10', blob]]) };

    async function openCustomChat() {
      renderDm({ path: '/dm/2', users: [chatUserFull], customEmoji });
      await screen.findByText('No messages yet. Start the conversation!');
      return document.getElementById('dm-input');
    }

    it('turns a typed :name: into the custom emoji', async () => {
      const textarea = await openCustomChat();
      type(textarea, 'look :blob:');
      await waitFor(() => expect(boxText()).toBe('look <:blob:10> '));
      expect(textarea.querySelector('img.emoji')).toHaveAttribute('src', 'https://s3.test/emojis/10');
    });

    it('suggests custom emoji first, with their guild', async () => {
      const textarea = await openCustomChat();
      type(textarea, 'hi :blo');
      const options = within(screen.getByRole('listbox', { name: 'Emoji matching :blo' })).getAllByRole('option');
      expect(options[0]).toHaveTextContent(':blob:Blob Land');
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(boxText()).toBe('hi <:blob:10> ');
    });

    it('inserts one from the picker and sends it as <:name:id>', async () => {
      sendMessageToUser.mockImplementation(async (to, content) => ({ id: 50, sender_id: 1, recipient_id: 2, content, timestamp: 1 }));
      const textarea = await openCustomChat();
      type(textarea, 'hey ');
      fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));
      fireEvent.click(screen.getByRole('button', { name: ':blob:' }));
      expect(boxText()).toBe('hey <:blob:10>');
      fireEvent.submit(document.getElementById('dm-chat-form'));
      await waitFor(() => expect(encryptMessage).toHaveBeenCalledWith('hey <:blob:10>', 'shared-key', expect.anything()));
    });
  });

  it('on desktop, focuses the picker search so you can type straight away', async () => {
    await openChat();
    fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search emoji' }));
  });

  describe('on mobile', () => {
    async function openMobileChat() {
      renderDm({ path: '/dm/2', users: [chatUserFull], isMobile: true });
      await screen.findByText('No messages yet. Start the conversation!');
      return document.getElementById('dm-input');
    }

    it('swaps the keyboard for a docked emoji panel of the keyboard\'s height', async () => {
      localStorage.setItem('keyboardHeight', '300');
      const textarea = await openMobileChat();
      textarea.focus();

      fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));

      const panel = screen.getByRole('dialog', { name: 'Emoji picker' });
      expect(panel).toHaveClass('docked');
      expect(panel.style.height).toBe('300px');
      expect(panel.closest('.dm-chat-wrapper')).toBeNull(); // below the composer, not over it
      expect(document.activeElement).not.toBe(textarea); // keyboard dismissed
      // Searchable, but not focused on open (that would summon the keyboard).
      expect(document.activeElement).not.toBe(screen.getByRole('searchbox', { name: 'Search emoji' }));
    });

    it('goes full screen from the handle, and back', async () => {
      localStorage.setItem('keyboardHeight', '300');
      await openMobileChat();
      fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));
      const panel = screen.getByRole('dialog', { name: 'Emoji picker' });

      fireEvent.click(screen.getByRole('button', { name: 'Expand picker' }));
      expect(panel).toHaveClass('expanded');
      expect(panel.style.height).toBe(''); // the whole screen (CSS)

      fireEvent.click(screen.getByRole('button', { name: 'Shrink picker' }));
      expect(panel).not.toHaveClass('expanded');
      expect(panel.style.height).toBe('300px');
    });

    it('goes full screen above the keyboard to search, and back to the panel after picking', async () => {
      await openMobileChat();
      fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));
      const panel = screen.getByRole('dialog', { name: 'Emoji picker' });
      const search = screen.getByRole('searchbox', { name: 'Search emoji' });

      act(() => search.focus()); // a tap on the search box (keyboard opens)
      expect(panel).toHaveClass('searching');
      expect(panel.style.height).toBe(`${(window.visualViewport?.height ?? window.innerHeight) + 1}px`);
      expect(screen.getByRole('button', { name: 'Close search' })).toBeInTheDocument();

      fireEvent.change(search, { target: { value: 'pizza' } });
      fireEvent.keyDown(search, { key: 'Enter' });

      expect(boxText()).toBe('🍕');
      expect(panel).not.toHaveClass('searching');
      expect(search.value).toBe('');
      expect(document.activeElement).not.toBe(search); // keyboard dismissed
      expect(screen.getByRole('dialog', { name: 'Emoji picker' })).toBeInTheDocument(); // panel still open
    });

    describe('with an on-screen keyboard', () => {
      let listeners;
      const setKeyboard = (px) => act(() => {
        window.visualViewport.height = 800 - px;
        listeners.forEach((fn) => fn());
      });
      beforeEach(() => {
        listeners = [];
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
        window.visualViewport = {
          height: 800,
          offsetTop: 0,
          addEventListener: (_, fn) => listeners.push(fn),
          removeEventListener: (_, fn) => { listeners = listeners.filter((l) => l !== fn); },
        };
      });
      afterEach(() => { delete window.visualViewport; });

      async function startSearch() {
        await openMobileChat();
        fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));
        const search = screen.getByRole('searchbox', { name: 'Search emoji' });
        act(() => search.focus());
        return { search, panel: () => screen.getByRole('dialog', { name: 'Emoji picker' }) };
      }

      it('fills exactly the space above the keyboard (1px extra, hidden under it)', async () => {
        const { panel } = await startSearch();
        setKeyboard(320.5);
        expect(panel().style.height).toBe('480.5px');
        expect(panel().style.top).toBe('0px');
      });

      it('returns to the docked size when the keyboard closes, keeping the results', async () => {
        const { search, panel } = await startSearch();
        setKeyboard(320);
        fireEvent.change(search, { target: { value: 'pizza' } });

        setKeyboard(0); // e.g. Android back button: keyboard gone, box still focused

        expect(panel()).not.toHaveClass('searching');
        expect(search.value).toBe('pizza');
        expect(screen.getByRole('button', { name: 'Pizza' })).toBeInTheDocument();
        expect(document.activeElement).not.toBe(search);
      });

      it('also returns to the docked size when the search box loses focus', async () => {
        const { search, panel } = await startSearch();
        fireEvent.change(search, { target: { value: 'pizza' } });
        act(() => search.blur());
        expect(panel()).not.toHaveClass('searching');
        expect(search.value).toBe('pizza');
      });

      it('tapping a result does not take focus from the search box first', async () => {
        const { search } = await startSearch();
        fireEvent.change(search, { target: { value: 'pizza' } });
        const notPrevented = fireEvent.mouseDown(screen.getByRole('button', { name: 'Pizza' }));
        expect(notPrevented).toBe(false); // default (focus change) prevented
      });
    });

    describe('with the VirtualKeyboard API (Chrome/Brave on Android)', () => {
      let keyboard;
      const setKeyboardTop = (y, height) => act(() => {
        keyboard.boundingRect = { x: 0, y, width: 400, height };
        keyboard.listeners.forEach((fn) => fn());
      });
      beforeEach(() => {
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
        keyboard = {
          overlaysContent: false,
          boundingRect: { x: 0, y: 0, width: 0, height: 0 },
          listeners: [],
          addEventListener(_, fn) { this.listeners.push(fn); },
          removeEventListener(_, fn) { this.listeners = this.listeners.filter((l) => l !== fn); },
        };
        Object.defineProperty(navigator, 'virtualKeyboard', { configurable: true, value: keyboard });
      });
      afterEach(() => { delete navigator.virtualKeyboard; });

      async function startSearch() {
        await openMobileChat();
        fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));
        const search = screen.getByRole('searchbox', { name: 'Search emoji' });
        fireEvent.pointerDown(search);
        const overlaysBeforeFocus = keyboard.overlaysContent;
        act(() => search.focus());
        return { search, overlaysBeforeFocus, panel: () => screen.getByRole('dialog', { name: 'Emoji picker' }) };
      }

      it('has the keyboard overlay the page before it opens, and fills the screen behind it', async () => {
        const { overlaysBeforeFocus, panel } = await startSearch();
        expect(overlaysBeforeFocus).toBe(true);

        setKeyboardTop(520, 280); // reported keyboard top (may be above the real one)

        expect(panel()).toHaveClass('searching');
        // Covers the whole screen, so no page shows even if the report is off...
        expect(panel().style.top).toBe('0px');
        expect(panel().style.bottom).toBe('0px');
        expect(panel().style.height).toBe('');
        // ...while its content stays above the keyboard.
        expect(panel().style.paddingBottom).toBe('280px');
      });

      it('goes back to the docked size and stops overlaying when the keyboard closes', async () => {
        const { search, panel } = await startSearch();
        setKeyboardTop(520, 280);
        fireEvent.change(search, { target: { value: 'pizza' } });

        setKeyboardTop(0, 0); // keyboard dismissed (e.g. back button), box still focused

        expect(panel()).not.toHaveClass('searching');
        expect(search.value).toBe('pizza');
        expect(keyboard.overlaysContent).toBe(false);
      });

      it('stops overlaying when leaving search or closing the panel', async () => {
        await startSearch();
        setKeyboardTop(520, 280);
        fireEvent.click(screen.getByRole('button', { name: 'Close search' }));
        expect(keyboard.overlaysContent).toBe(false);

        fireEvent.pointerDown(screen.getByRole('searchbox', { name: 'Search emoji' }));
        expect(keyboard.overlaysContent).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: 'Show keyboard' }));
        expect(screen.queryByRole('dialog', { name: 'Emoji picker' })).not.toBeInTheDocument();
        expect(keyboard.overlaysContent).toBe(false);
      });
    });

    it('leaves search with the back button', async () => {
      await openMobileChat();
      fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));
      const search = screen.getByRole('searchbox', { name: 'Search emoji' });
      act(() => search.focus());
      fireEvent.change(search, { target: { value: 'cat' } });

      fireEvent.click(screen.getByRole('button', { name: 'Close search' }));

      expect(screen.getByRole('dialog', { name: 'Emoji picker' })).not.toHaveClass('searching');
      expect(search.value).toBe('');
      expect(document.activeElement).not.toBe(search);
    });

    it('inserts picked emoji without focusing anything (no keyboard)', async () => {
      const textarea = await openMobileChat();
      fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));

      fireEvent.click(screen.getByRole('button', { name: 'Grinning Face' }));
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

      expect(boxText()).toBe('😀');
      expect(document.activeElement).not.toBe(textarea);
      // Stays open like a keyboard, for picking several.
      fireEvent.click(screen.getByRole('button', { name: 'Grinning Face' }));
      expect(boxText()).toBe('😀😀');
    });

    it('swaps back to the keyboard from the button (now a keyboard) or by tapping the message box', async () => {
      const textarea = await openMobileChat();
      fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));

      fireEvent.click(screen.getByRole('button', { name: 'Show keyboard' }));
      expect(screen.queryByRole('dialog', { name: 'Emoji picker' })).not.toBeInTheDocument();
      expect(document.activeElement).toBe(textarea);

      textarea.blur();
      fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));
      expect(screen.getByRole('dialog', { name: 'Emoji picker' })).toBeInTheDocument();
      fireEvent.focus(textarea);
      expect(screen.queryByRole('dialog', { name: 'Emoji picker' })).not.toBeInTheDocument();
    });
  });
});

describe('Dm pins', () => {
  const message = { id: 10, sender_id: 2, recipient_id: 1, content: 'ENC1', timestamp: 1000, reactions: [] };

  async function openChat() {
    fetchMessagesForUser.mockResolvedValue([message]);
    renderDm({ path: '/dm/2', users: [chatUserFull] });
    await screen.findByText(/dec:ENC1/);
    await waitFor(() => expect(dmListeners.pin.length).toBeGreaterThan(0));
  }

  it('pins and unpins from the message menu', async () => {
    await openChat();
    setMessagePinned.mockResolvedValueOnce({ messageId: 10, pinned_at: 5000, pinned_by: 1 });
    fireEvent.click(screen.getByTestId('pin-10'));
    expect(await screen.findByText('dec:ENC1 [sent] [pinned]')).toBeInTheDocument();
    expect(setMessagePinned).toHaveBeenCalledWith(10, true);

    setMessagePinned.mockResolvedValueOnce({ messageId: 10, pinned_at: null, pinned_by: null });
    fireEvent.click(screen.getByTestId('pin-10'));
    expect(await screen.findByText('dec:ENC1 [sent]')).toBeInTheDocument();
    expect(setMessagePinned).toHaveBeenLastCalledWith(10, false);
  });

  it("shows the other person's pins live, only for this conversation", async () => {
    await openChat();
    act(() => dmListeners.pin.forEach((cb) => cb({ messageId: 10, sender_id: 3, recipient_id: 1, pinned_at: 1, pinned_by: 3 })));
    expect(screen.getByText('dec:ENC1 [sent]')).toBeInTheDocument();
    act(() => dmListeners.pin.forEach((cb) => cb({ messageId: 10, sender_id: 2, recipient_id: 1, pinned_at: 1, pinned_by: 2 })));
    expect(screen.getByText('dec:ENC1 [sent] [pinned]')).toBeInTheDocument();
  });

  it('lists the pinned messages, decrypted, and unpins from the list', async () => {
    await openChat();
    fetchPins.mockResolvedValue([{ ...message, pinned_at: 5000, pinned_by: 2 }]);
    fireEvent.click(screen.getByRole('button', { name: 'Pinned messages' }));
    const panel = await screen.findByRole('dialog', { name: 'Pinned messages' });
    expect(await within(panel).findByText('dec:ENC1')).toBeInTheDocument();
    expect(fetchPins).toHaveBeenCalledWith(2);

    setMessagePinned.mockResolvedValueOnce({ messageId: 10, pinned_at: null, pinned_by: null });
    fetchPins.mockResolvedValue([]);
    fireEvent.click(within(panel).getByRole('button', { name: 'Unpin' }));
    expect(await within(panel).findByText(/doesn't have any pinned messages/)).toBeInTheDocument();
    expect(setMessagePinned).toHaveBeenCalledWith(10, false);

    // Escape closes it.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Pinned messages' })).not.toBeInTheDocument();
  });

  it('says why pinning failed', async () => {
    await openChat();
    setMessagePinned.mockRejectedValueOnce({ response: { data: { error: 'A chat can have at most 250 pinned messages. Unpin one first.' } } });
    fireEvent.click(screen.getByTestId('pin-10'));
    expect(await screen.findByText(/at most 250 pinned messages/)).toBeInTheDocument();
  });
});

describe('Dm reactions', () => {
  const message = { id: 10, sender_id: 2, recipient_id: 1, content: 'ENC1', timestamp: 1000, reactions: [] };

  async function openChat(reactions = []) {
    fetchMessagesForUser.mockResolvedValue([{ ...message, reactions }]);
    renderDm({ path: '/dm/2', users: [chatUserFull] });
    await screen.findByText(/dec:ENC1/);
    // Live updates are subscribed to just after the conversation shows.
    await waitFor(() => expect(dmListeners.reactionAdd.length).toBeGreaterThan(0));
  }

  it('adds an encrypted reaction bound to the message and reactor, then removes it', async () => {
    addReaction.mockResolvedValue({ id: 50, message_id: 10, user_id: 1, content: 'renc(👍)' });
    await openChat();

    fireEvent.click(screen.getByTestId('toggle-thumbs-10'));
    await waitFor(() => expect(screen.getByTestId('reactions-10')).toHaveTextContent('👍:1'));
    expect(encryptReaction).toHaveBeenCalledWith('👍', 'shared-key', 'rctx:10:1');
    expect(addReaction).toHaveBeenCalledWith(10, 'renc(👍)');

    // The server's websocket echo of the same reaction doesn't add it twice.
    await act(async () => {
      await Promise.all(dmListeners.reactionAdd.map((cb) => cb({ id: 50, message_id: 10, user_id: 1, content: 'renc(👍)' })));
    });
    expect(screen.getByTestId('reactions-10')).toHaveTextContent(/^👍:1$/);

    fireEvent.click(screen.getByTestId('toggle-thumbs-10'));
    await waitFor(() => expect(screen.queryByTestId('reactions-10')).not.toBeInTheDocument());
    expect(removeReaction).toHaveBeenCalledWith(50);
  });

  it("shows the other person's reactions live, and their removal", async () => {
    await openChat([{ id: 7, user_id: 2, emoji: '😂' }]);
    expect(screen.getByTestId('reactions-10')).toHaveTextContent('😂:2');

    await act(async () => {
      await Promise.all(dmListeners.reactionAdd.map((cb) => cb({ id: 8, message_id: 10, user_id: 2, content: 'renc(❤️)' })));
    });
    expect(screen.getByTestId('reactions-10')).toHaveTextContent('😂:2 ❤️:2');

    act(() => dmListeners.reactionRemove.forEach((cb) => cb({ reactionId: 7, messageId: 10 })));
    expect(screen.getByTestId('reactions-10')).toHaveTextContent(/^❤️:2$/);

    // Reactions to messages not shown here are ignored.
    await act(async () => {
      await Promise.all(dmListeners.reactionAdd.map((cb) => cb({ id: 9, message_id: 999, user_id: 2, content: 'renc(🎉)' })));
    });
    expect(screen.getByTestId('reactions-10')).toHaveTextContent(/^❤️:2$/);
  });

  it('reacts from the picker and closes it', async () => {
    addReaction.mockResolvedValue({ id: 51, message_id: 10, user_id: 1, content: 'renc(🎉)' });
    await openChat();
    expect(screen.getByTestId('message-list')).toHaveAttribute('data-focused', '');

    fireEvent.click(screen.getByTestId('react-10'));
    // The message stays highlighted while its picker is open.
    expect(screen.getByTestId('message-list')).toHaveAttribute('data-focused', '10');
    const picker = screen.getByRole('dialog', { name: 'Emoji picker' });
    fireEvent.change(within(picker).getByRole('searchbox'), { target: { value: 'tada' } });
    fireEvent.click(within(picker).getByRole('button', { name: 'Party Popper' }));

    await waitFor(() => expect(screen.getByTestId('reactions-10')).toHaveTextContent('🎉:1'));
    expect(screen.queryByRole('dialog', { name: 'Emoji picker' })).not.toBeInTheDocument();
    expect(screen.getByTestId('message-list')).toHaveAttribute('data-focused', '');
  });

  it('reacts from the docked panel on mobile, which closes after the pick', async () => {
    addReaction.mockResolvedValue({ id: 52, message_id: 10, user_id: 1, content: 'renc(🎉)' });
    fetchMessagesForUser.mockResolvedValue([{ ...message }]);
    renderDm({ path: '/dm/2', users: [chatUserFull], isMobile: true });
    await screen.findByText(/dec:ENC1/);

    fireEvent.click(screen.getByTestId('react-10'));
    const picker = screen.getByRole('dialog', { name: 'Emoji picker' });
    expect(picker).toHaveClass('docked');
    fireEvent.click(within(picker).getAllByRole('button', { name: 'Party Popper' })[0]);

    await waitFor(() => expect(screen.getByTestId('reactions-10')).toHaveTextContent('🎉:1'));
    expect(screen.queryByRole('dialog', { name: 'Emoji picker' })).not.toBeInTheDocument();
  });
});

describe('Dm mobile message actions', () => {
  // The sheet only takes clicks from a touch that started on it.
  const tapInSheet = (el) => {
    fireEvent.pointerDown(el);
    fireEvent.click(el);
  };

  async function openMobileChat(messages, shown = /dec:/) {
    fetchMessagesForUser.mockResolvedValue(messages);
    renderDm({ path: '/dm/2', users: [chatUserFull], isMobile: true });
    await screen.findByText(shown);
  }

  it('reacts from the sheet and closes it', async () => {
    addReaction.mockResolvedValue({ id: 60, message_id: 10, user_id: 1, content: 'renc(👍)' });
    await openMobileChat([{ id: 10, sender_id: 2, recipient_id: 1, content: 'ENC1', timestamp: 1, reactions: [] }]);

    fireEvent.click(screen.getByTestId('hold-10'));
    const sheet = screen.getByRole('dialog', { name: 'Message actions' });
    expect(within(sheet).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument(); // not ours
    tapInSheet(within(sheet).getByRole('button', { name: 'React with Thumbs Up' }));

    await waitFor(() => expect(screen.getByTestId('reactions-10')).toHaveTextContent('👍:1'));
    expect(screen.queryByRole('dialog', { name: 'Message actions' })).not.toBeInTheDocument();
  });

  it('replies, copies (attachments as names) and deletes after confirming', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await openMobileChat([{
      id: 11, sender_id: 1, recipient_id: 2, content: 'ENC2', timestamp: 1, reactions: [],
      plaintext: 'look ![cat.png](https://s3.test/uploads/x.bin#v=1&k=SECRET)',
    }], /look/);

    fireEvent.click(screen.getByTestId('hold-11'));
    tapInSheet(screen.getByRole('button', { name: 'Copy text' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('look 📎 cat.png'));

    fireEvent.click(screen.getByTestId('hold-11'));
    tapInSheet(screen.getByRole('button', { name: 'Reply' }));
    expect(screen.getByText(/Replying to/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('hold-11'));
    tapInSheet(screen.getByRole('button', { name: 'Delete' }));
    tapInSheet(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteMessage).toHaveBeenCalledWith(11));
    await waitFor(() => expect(screen.queryByText(/look/)).not.toBeInTheDocument());
  });
});

describe('Dm deleting from the hover menu', () => {
  async function openChatWith(messages, shown) {
    fetchMessagesForUser.mockResolvedValue(messages);
    renderDm({ path: '/dm/2', users: [chatUserFull] });
    await screen.findByText(shown);
  }
  const mine = { id: 21, sender_id: 1, recipient_id: 2, content: 'ENC', timestamp: 1, reactions: [], plaintext: 'see ||the end|| <@2>' };

  it('asks first, showing the message; Cancel keeps it, Delete deletes it', async () => {
    await openChatWith([mine], /see/);
    fireEvent.click(screen.getByTestId('delete-21'));
    const dialog = screen.getByRole('dialog', { name: 'Delete message' });
    // Spoilers stay hidden, mentions by name.
    expect(within(dialog).getByText('see [spoiler] @bob')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(deleteMessage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('delete-21'));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete message' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteMessage).toHaveBeenCalledWith(21));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete message' })).not.toBeInTheDocument());
  });

  it('deletes at once with Shift held', async () => {
    await openChatWith([mine], /see/);
    fireEvent.click(screen.getByTestId('delete-21'), { shiftKey: true });
    expect(screen.queryByRole('dialog', { name: 'Delete message' })).not.toBeInTheDocument();
    await waitFor(() => expect(deleteMessage).toHaveBeenCalledWith(21));
  });
});
