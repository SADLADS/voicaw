// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const dmListeners = vi.hoisted(() => ({ newDm: [], deleteDm: [], editDm: [] }));

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
}));

vi.mock('../utils/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock('../services/dmService', () => ({
  fetchMessagesForUser: vi.fn(),
  sendMessageToUser: vi.fn(),
  markMessagesRead: vi.fn(),
}));

vi.mock('../services/encryptionService', () => ({
  encryptMessage: vi.fn(async (text) => `enc(${text})`),
  decryptMessage: vi.fn(async (content) => `dec(${content})`),
  deriveConversationKey: vi.fn(async () => 'shared-key'),
  dmContext: (sender, recipient) => `ctx:${sender}->${recipient}`,
  decryptMessagesBatch: vi.fn(async (messages) =>
    messages.map((m) => ({ ...m, plaintext: m.plaintext ?? `dec:${m.content}` }))
  ),
}));

vi.mock('../utils/mediaDimensions', () => ({
  readMediaDimensions: vi.fn(async () => null),
}));

vi.mock('../services/attachmentUpload', () => ({
  uploadAttachment: vi.fn(),
  MAX_ATTACHMENT_BYTES: 1000,
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
  default: ({ messages, loadMoreMessages, hasMore }) => (
    <div data-testid="message-list" data-has-more={String(hasMore)}>
      <button data-testid="load-older" onClick={() => loadMoreMessages()} />
      {messages.map((m) => (
        <div key={m.clientKey ?? m.id}>{m.plaintext} [{m.status || 'sent'}]</div>
      ))}
    </div>
  ),
}));

import Dm from './Dm';
import emojiData from '@emoji-mart/data/sets/15/twitter.json';
import { buildEmojiIndex } from '../emoji/emojiIndex';
import { EmojiContext } from '../emoji/emojiContext';
import { ConfigContext, InteractionContext } from '../App';
import { LayoutContext } from './Layout';
import { fetchMessagesForUser, sendMessageToUser, markMessagesRead } from '../services/dmService';
import { deriveConversationKey, encryptMessage, decryptMessage } from '../services/encryptionService';
import { checkContactKeys, acceptContactKeys } from '../services/contactKeys';
import { uploadAttachment } from '../services/attachmentUpload';
import { readMediaDimensions } from '../utils/mediaDimensions';

const currentUser = { id: 1, username: 'me' };
const chatUserFull = {
  id: 2, username: 'bob', identity_key: 'bob-identity', encryption_key: 'bob-enc', encryption_key_signature: 'bob-sig',
};
const chatUserNoKey = { id: 3, username: 'nokey' };

const emojiIndex = buildEmojiIndex(emojiData);

function renderDm({ path, users, user = currentUser, layoutOverrides = {}, isMobile = false } = {}) {
  return render(
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
          </MemoryRouter>
        </LayoutContext.Provider>
      </InteractionContext.Provider>
    </ConfigContext.Provider>
    </EmojiContext.Provider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dmListeners.newDm = [];
  dmListeners.deleteDm = [];
  dmListeners.editDm = [];
  localStorage.clear();
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

    const textarea = document.getElementById('dm-input');
    fireEvent.change(textarea, { target: { value: 'hello bob' } });
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
        plaintext: 'incoming hello',
        timestamp: 3000,
      });
    });

    expect(await screen.findByText('incoming hello [sent]')).toBeInTheDocument();
  });

  it('marks messages read for the active conversation', async () => {
    renderDm({ path: '/dm/2', users: [chatUserFull] });

    await waitFor(() => expect(markMessagesRead).toHaveBeenCalledWith(2));
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

  const paste = (textarea, files) => fireEvent.paste(textarea, { clipboardData: { files } });

  it('inserts placeholders and shows previews on paste, without uploading anything', async () => {
    const textarea = await openChat();

    paste(textarea, [png(), pdf()]);

    await waitFor(() =>
      expect(textarea.value).toBe('![cat.png](attachment:1)\n![report.pdf](attachment:2)')
    );
    expect(screen.getByRole('img', { name: 'cat.png' })).toHaveAttribute('src', 'blob:local-1');
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  it('accepts dropped files of any type', async () => {
    const textarea = await openChat();
    const wrapper = document.querySelector('.dm-chat-wrapper');

    fireEvent.drop(wrapper, { dataTransfer: { files: [pdf()], types: ['Files'] } });

    await waitFor(() => expect(textarea.value).toBe('![report.pdf](attachment:1)'));
  });

  it('removing a preview also removes its placeholder from the text', async () => {
    const textarea = await openChat();
    fireEvent.change(textarea, { target: { value: 'look: ' } });
    textarea.setSelectionRange(6, 6);
    paste(textarea, [png()]);
    await waitFor(() => expect(textarea.value).toBe('look: ![cat.png](attachment:1)'));

    fireEvent.click(screen.getByRole('button', { name: 'Remove cat.png' }));

    expect(textarea.value).toBe('look: ');
    expect(screen.queryByRole('img', { name: 'cat.png' })).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-1');
  });

  it('rejects files over the size limit', async () => {
    const textarea = await openChat();

    paste(textarea, [new File(['x'.repeat(2000)], 'huge.mov', { type: 'video/quicktime' })]);

    expect(await screen.findByRole('alert')).toHaveTextContent('huge.mov is over the');
    expect(textarea.value).toBe('');
  });

  it('uploads on send and sends the message with the real attachment URLs', async () => {
    const finalUrl = 'https://s3.test/uploads/abc.bin#v=1&k=KEY&t=image%2Fpng&s=9';
    let finishUpload;
    uploadAttachment.mockReturnValue(new Promise((resolve) => { finishUpload = resolve; }));
    sendMessageToUser.mockResolvedValue({ id: 99, sender_id: 1, recipient_id: 2, timestamp: 2000 });

    const textarea = await openChat();
    fireEvent.change(textarea, { target: { value: 'hi ' } });
    textarea.setSelectionRange(3, 3);
    paste(textarea, [png()]);
    await waitFor(() => expect(textarea.value).toBe('hi ![cat.png](attachment:1)'));

    fireEvent.submit(document.getElementById('dm-chat-form'));

    // Pending while uploading, still showing the placeholder text.
    expect(await screen.findByText('hi ![cat.png](attachment:1) [pending]')).toBeInTheDocument();
    expect(uploadAttachment).toHaveBeenCalledWith(expect.any(File), expect.any(Function), null);
    expect(uploadAttachment.mock.calls[0][0].name).toBe('cat.png');
    expect(sendMessageToUser).not.toHaveBeenCalled();
    expect(textarea.value).toBe('');

    await act(async () => finishUpload(finalUrl));

    expect(await screen.findByText(`hi ![cat.png](${finalUrl}) [sent]`)).toBeInTheDocument();
    expect(encryptMessage).toHaveBeenCalledWith(`hi ![cat.png](${finalUrl})`, 'shared-key', 'ctx:1->2');
    expect(sendMessageToUser).toHaveBeenCalledWith(2, `enc(hi ![cat.png](${finalUrl}))`, null);
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
    await waitFor(() => expect(textarea.value).toBe('![cat.png](attachment:1)'));

    fireEvent.change(textarea, { target: { value: 'never mind' } });
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
    await waitFor(() => expect(textarea.value).toBe('![cat.png](attachment:1)'));
    fireEvent.submit(document.getElementById('dm-chat-form'));

    expect(await screen.findByText('![cat.png](attachment:1) [failed]')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Upload failed (403)');
    expect(sendMessageToUser).not.toHaveBeenCalled();
  });

  it('refuses to send when the attachment links would push the message over the limit', async () => {
    const textarea = await openChat();
    fireEvent.change(textarea, { target: { value: 'x'.repeat(4950) } });
    textarea.setSelectionRange(4950, 4950);
    paste(textarea, [png()]);
    await waitFor(() => expect(textarea.value).toContain('(attachment:1)'));

    fireEvent.submit(document.getElementById('dm-chat-form'));

    expect(await screen.findByRole('alert')).toHaveTextContent('too long once attachment links are added');
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(textarea.value).toContain('(attachment:1)');
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

    fireEvent.change(document.getElementById('dm-input'), { target: { value: 'hello' } });
    fireEvent.submit(document.getElementById('dm-chat-form'));
    await screen.findByText('hello [sent]');
    expect(encryptMessage).toHaveBeenCalledWith('hello', 'shared-key', 'ctx:1->2');

    await waitFor(() => expect(dmListeners.newDm.length).toBeGreaterThan(0));
    await act(async () => {
      dmListeners.newDm.at(-1)({ id: 100, sender_id: 2, recipient_id: 1, content: 'ENC-IN', timestamp: 3000 });
    });
    expect(decryptMessage).toHaveBeenCalledWith('ENC-IN', 'shared-key', 'ctx:2->1');
  });

  it('shows whether the contact is verified and opens the safety number', async () => {
    checkContactKeys.mockResolvedValueOnce({ status: 'verified', encryptionKey: 'bob-enc' });
    renderDm({ path: '/dm/2', users: [chatUserFull] });

    fireEvent.click(await screen.findByRole('button', { name: '✓ Verified' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Safety number with bob');
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
    expect(screen.getByRole('button', { name: 'Not verified' })).toBeInTheDocument();
    expect(document.getElementById('dm-input')).not.toBeNull();
  });
});

describe('Dm emoji', () => {
  async function openChat() {
    renderDm({ path: '/dm/2', users: [chatUserFull] });
    await screen.findByText('No messages yet. Start the conversation!');
    return document.getElementById('dm-input');
  }
  const type = (textarea, value) =>
    fireEvent.change(textarea, { target: { value, selectionStart: value.length, selectionEnd: value.length } });

  it('the emoji button opens the picker and does not send the message', async () => {
    const textarea = await openChat();
    type(textarea, 'draft');

    fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));

    expect(screen.getByRole('dialog', { name: 'Emoji picker' })).toBeInTheDocument();
    expect(sendMessageToUser).not.toHaveBeenCalled();
    expect(textarea.value).toBe('draft');
  });

  it('inserts a picked emoji at the cursor', async () => {
    const textarea = await openChat();
    type(textarea, 'hi ');
    textarea.setSelectionRange(3, 3);
    fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));

    fireEvent.click(screen.getByRole('button', { name: 'Grinning Face' }));

    expect(textarea.value).toBe('hi 😀');
    expect(screen.queryByRole('dialog', { name: 'Emoji picker' })).not.toBeInTheDocument();
  });

  it('suggests emoji for ":sm" and inserts the chosen one with Tab or Enter', async () => {
    const textarea = await openChat();
    type(textarea, 'hello :smi');

    const list = screen.getByRole('listbox', { name: 'Emoji matching :smi' });
    expect(within(list).getAllByRole('option')[0]).toHaveTextContent(':smile:');

    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(textarea.value).toBe('hello 😄 ');
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
    expect(textarea.value).toBe('nice 👍');

    type(textarea, 'nice 👍 :notarealemoji:');
    expect(textarea.value).toBe('nice 👍 :notarealemoji:');
  });

  it('on desktop, focuses the picker search so you can type straight away', async () => {
    await openChat();
    fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search emoji' }));
  });

  it('on mobile, never focuses anything (which would pop up the keyboard)', async () => {
    renderDm({ path: '/dm/2', users: [chatUserFull], isMobile: true });
    await screen.findByText('No messages yet. Start the conversation!');
    const textarea = document.getElementById('dm-input');
    textarea.focus();

    fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));
    expect(document.activeElement).not.toBe(textarea);
    expect(document.activeElement).not.toBe(screen.getByRole('searchbox', { name: 'Search emoji' }));

    fireEvent.click(screen.getByRole('button', { name: 'Grinning Face' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(textarea.value).toBe('😀');
    expect(document.activeElement).not.toBe(textarea);
  });
});

