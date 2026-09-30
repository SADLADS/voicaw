// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';


vi.mock('../services/attachmentCache', () => ({
  loadDecryptedAttachment: vi.fn(async () => 'blob:decrypted'),
  getCachedAttachment: vi.fn(() => null),
}));

import MessageList from './MessageList';
import { editorFor } from '../editor/editorRegistry';
import emojiData from '@emoji-mart/data/sets/15/twitter.json';
import { buildEmojiIndex } from '../emoji/emojiIndex';
import { EmojiContext } from '../emoji/emojiContext';
import { loadDecryptedAttachment } from '../services/attachmentCache';
import { buildAttachmentUrl } from '../services/attachmentCrypto';

const user = { id: 1, username: 'alice' };

function baseProps(overrides = {}) {
  return {
    messages: [],
    user,
    hasMore: false,
    loadMoreMessages: vi.fn(),
    s3Endpoint: 'https://s3.test',
    firstItemIndex: 0,
    hoveredMsgId: null,
    setHoveredMsgId: vi.fn(),
    handleEdit: vi.fn(),
    handleDelete: vi.fn(),
    handleReply: vi.fn(),
    editingMessageId: null,
    editingMessageContent: '',
    setEditingMessageContent: vi.fn(),
    setEditingMessageId: vi.fn(),
    handleSaveEdit: vi.fn(),
    isMobile: false,
    editRef: { current: null },
    maxPlaintextLength: 5000,
    ...overrides,
  };
}

describe('MessageList', () => {
  it('shows mentions by name and highlights messages that mention you', () => {
    const messages = [
      { id: 1, sender_id: 2, sender_username: 'bob', plaintext: 'hey <@1>', timestamp: 1000 },
      { id: 2, sender_id: 2, sender_username: 'bob', plaintext: 'ask <@3> or <@9>', timestamp: 1001 },
    ];
    render(<MessageList {...baseProps({ messages, reactionNames: { 1: 'alice', 2: 'bob', 3: 'carol' } })} />);
    const me = screen.getByText('@alice');
    expect(me).toHaveClass('mention', 'mention-me');
    expect(me.closest('.each-dm-message-wrapper')).toHaveClass('mentioned');
    const other = screen.getByText('@carol');
    expect(other).not.toHaveClass('mention-me');
    expect(other.closest('.each-dm-message-wrapper')).not.toHaveClass('mentioned');
    expect(screen.getByText('@unknown-user')).toHaveClass('mention');
  });

  it("groups someone's messages sent close together under one name", () => {
    const messages = [
      { id: 1, sender_id: 2, sender_username: 'bob', plaintext: 'one', timestamp: 1000 },
      { id: 2, sender_id: 2, sender_username: 'bob', plaintext: 'two', timestamp: 1060, edited: 1 },
      { id: 3, sender_id: 1, sender_username: 'alice', plaintext: 'three', timestamp: 1070 },
      { id: 4, sender_id: 1, sender_username: 'alice', plaintext: 'much later', timestamp: 5000 },
    ];
    render(<MessageList {...baseProps({ messages })} />);
    const row = (text) => screen.getByText(text).closest('.each-dm-message-wrapper');
    expect(row('one')).not.toHaveClass('grouped');
    expect(row('two')).toHaveClass('grouped');
    expect(row('two').querySelector('.message-author')).toBeNull();
    expect(row('two').querySelector('.message-hover-time')).toBeInTheDocument();
    expect(row('two').querySelector('.message-edited')).toHaveTextContent('(edited)');
    expect(row('three')).not.toHaveClass('grouped');
    expect(row('much later')).not.toHaveClass('grouped');
    expect(screen.getAllByText('bob', { selector: '.message-author' })).toHaveLength(1);
  });

  it('hides spoilers until clicked, and in reply previews', () => {
    const messages = [
      { id: 1, sender_id: 2, sender_username: 'bob', plaintext: 'the ||butler __did__ it||', timestamp: 1000 },
      {
        id: 2, sender_id: 1, sender_username: 'alice', plaintext: 'no way', timestamp: 1001,
        parent_message_id: 1, parent_plaintext: 'the ||butler __did__ it||', parent_username: 'bob', parent_sender_id: 2,
      },
    ];
    render(<MessageList {...baseProps({ messages })} />);
    const spoiler = screen.getByRole('button', { name: 'Spoiler, select to reveal' });
    expect(spoiler.querySelector('u')).toHaveTextContent('did');
    expect(screen.getByText('the [spoiler]')).toHaveClass('reply-preview');
    fireEvent.click(spoiler);
    expect(screen.queryByRole('button', { name: /Spoiler/ })).toBeNull();
    expect(document.querySelector('.spoiler.revealed')).toHaveTextContent('butler did it');
  });

  it('draws role mentions in their colour, and @everyone only when it pinged', () => {
    const messages = [
      { id: 1, sender_id: 2, sender_username: 'bob', plaintext: '<@&7> raid', timestamp: 1000, mention_roles: [7] },
      { id: 2, sender_id: 2, sender_username: 'bob', plaintext: '@everyone hi', timestamp: 1001, mention_everyone: 1 },
      { id: 3, sender_id: 3, sender_username: 'eve', plaintext: '@everyone nope', timestamp: 1002, mention_everyone: 0 },
    ];
    render(<MessageList {...baseProps({
      messages, reactionNames: {}, mentionRoles: { 7: { name: 'Raiders', color: '#e91e63' } }, myRoleIds: [7],
    })} />);
    const role = screen.getByText('@Raiders');
    expect(role).toHaveClass('mention', 'role-mention', 'mention-me');
    expect(role.style.getPropertyValue('--role-color')).toBe('#e91e63');
    expect(role.closest('.each-dm-message-wrapper')).toHaveClass('mentioned');
    const loud = screen.getByText('@everyone');
    expect(loud).toHaveClass('mention');
    expect(loud.closest('.each-dm-message-wrapper')).toHaveClass('mentioned');
    const quiet = screen.getByText(/nope/);
    expect(quiet.querySelector('.mention')).toBeNull();
    expect(quiet.closest('.each-dm-message-wrapper')).not.toHaveClass('mentioned');
  });

  it('marks messages from the current user as sent and others as received', () => {
    const messages = [
      { id: 1, sender_id: 1, sender_username: 'alice', plaintext: 'hi there', timestamp: 1000 },
      { id: 2, sender_id: 2, sender_username: 'bob', plaintext: 'hello back', timestamp: 1001 },
    ];
    render(<MessageList {...baseProps({ messages })} />);

    const sentWrapper = screen.getByText('hi there').closest('.each-dm-message-wrapper');
    const receivedWrapper = screen.getByText('hello back').closest('.each-dm-message-wrapper');

    expect(sentWrapper.className).toContain('sent');
    expect(receivedWrapper.className).toContain('received');
  });

  it('shows edit/delete buttons only for the current user\'s own hovered message', () => {
    const messages = [
      { id: 1, sender_id: 1, sender_username: 'alice', plaintext: 'mine', timestamp: 1000 },
      { id: 2, sender_id: 2, sender_username: 'bob', plaintext: 'theirs', timestamp: 1001 },
    ];

    const { rerender } = render(
      <MessageList {...baseProps({ messages, hoveredMsgId: 1 })} />
    );
    expect(document.querySelector('[data-icon="pen-to-square"]')).toBeInTheDocument();
    expect(document.querySelector('[data-icon="trash"]')).toBeInTheDocument();
    expect(document.querySelector('[data-icon="reply"]')).toBeInTheDocument();

    rerender(<MessageList {...baseProps({ messages, hoveredMsgId: 2 })} />);
    expect(document.querySelector('[data-icon="pen-to-square"]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-icon="trash"]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-icon="reply"]')).toBeInTheDocument();
  });

  it('calls handleEdit/handleDelete/handleReply with the message when clicked', () => {
    const handleEdit = vi.fn();
    const handleDelete = vi.fn();
    const handleReply = vi.fn();
    const msg = { id: 1, sender_id: 1, sender_username: 'alice', plaintext: 'mine', timestamp: 1000 };

    render(
      <MessageList
        {...baseProps({ messages: [msg], hoveredMsgId: 1, handleEdit, handleDelete, handleReply })}
      />
    );

    fireEvent.click(document.querySelector('[data-icon="pen-to-square"]').closest('button'));
    fireEvent.click(document.querySelector('[data-icon="trash"]').closest('button'));
    fireEvent.click(document.querySelector('[data-icon="reply"]').closest('button'));

    expect(handleEdit).toHaveBeenCalledWith(msg);
    expect(handleDelete).toHaveBeenCalledWith(msg, expect.objectContaining({ shiftKey: false }));
    expect(handleReply).toHaveBeenCalledWith(msg);
  });

  it('renders a reply snippet for messages with a parent', () => {
    const msg = {
      id: 2,
      sender_id: 2,
      sender_username: 'bob',
      plaintext: 'replying now',
      timestamp: 1001,
      parent_message_id: 1,
      parent_plaintext: 'original message',
      parent_username: 'alice',
      parent_sender_id: 1,
    };

    render(<MessageList {...baseProps({ messages: [msg] })} />);

    expect(screen.getByText('alice', { selector: '.reply-author' })).toBeInTheDocument();
    expect(screen.getByText('original message')).toBeInTheDocument();
  });

  it('renders an inline edit textarea for the message being edited', () => {
    const msg = { id: 1, sender_id: 1, sender_username: 'alice', plaintext: 'mine', timestamp: 1000 };
    const setEditingMessageContent = vi.fn();

    render(
      <MessageList
        {...baseProps({
          messages: [msg],
          editingMessageId: 1,
          editingMessageContent: 'mine',
          setEditingMessageContent,
        })}
      />
    );

    const editor = editorFor(document.getElementById('edit-input-1'));
    expect(editor.getText()).toBe('mine');
    expect(document.activeElement).toBe(document.getElementById('edit-input-1'));

    act(() => editor.insertText(' edited'));
    expect(setEditingMessageContent).toHaveBeenLastCalledWith('mine edited');
  });

  it("shows a sent message's attachments as chips while editing, not their links", () => {
    const image = '![IMG\\_1.jpg](https://s3.test/uploads/x.bin#v=1&k=SECRET&t=image%2Fjpeg&s=5)';
    const msg = { id: 1, sender_id: 1, sender_username: 'alice', plaintext: `look ${image}`, timestamp: 1000 };
    const setEditingMessageContent = vi.fn();
    render(
      <MessageList
        {...baseProps({ messages: [msg], editingMessageId: 1, editingMessageContent: msg.plaintext, setEditingMessageContent })}
      />
    );

    const box = document.getElementById('edit-input-1');
    expect(box).toHaveTextContent('look 📎 IMG_1.jpg');
    expect(box.textContent).not.toContain('SECRET');

    const editor = editorFor(box);
    act(() => editor.insertText(' edited'));
    expect(setEditingMessageContent).toHaveBeenLastCalledWith(`look ${image} edited`);
  });

  it('keeps edits within maxPlaintextLength', () => {
    const msg = { id: 1, sender_id: 1, sender_username: 'alice', plaintext: 'mine', timestamp: 1000 };
    const setEditingMessageContent = vi.fn();

    render(
      <MessageList
        {...baseProps({
          messages: [msg],
          editingMessageId: 1,
          editingMessageContent: 'mine',
          setEditingMessageContent,
          maxPlaintextLength: 5,
        })}
      />
    );

    const editor = editorFor(document.getElementById('edit-input-1'));
    act(() => editor.insertText('!'));
    act(() => editor.insertText('way too long'));

    expect(editor.getText()).toBe('mine!');
    expect(setEditingMessageContent).toHaveBeenLastCalledWith('mine!');
  });

  it('saves on Enter and cancels on Escape', () => {
    const msg = { id: 1, sender_id: 1, sender_username: 'alice', plaintext: 'mine', timestamp: 1000 };
    const props = baseProps({ messages: [msg], editingMessageId: 1, editingMessageContent: 'mine' });
    render(<MessageList {...props} />);
    const box = document.getElementById('edit-input-1');

    fireEvent.keyDown(box, { key: 'Enter' });
    expect(props.handleSaveEdit).toHaveBeenCalledWith(1);
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(props.setEditingMessageId).toHaveBeenCalledWith(null);
  });

  describe('loading older messages', () => {
    // jsdom has no layout: give the scroller a height so "near the top" means something
    // (its scrollTop is always 0 there, i.e. at the very top).
    let restore;
    const withViewportHeight = (px) => {
      const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
      Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get: () => px });
      restore = () => Object.defineProperty(Element.prototype, 'clientHeight', desc);
    };
    afterEach(() => restore?.());
    const one = [{ id: 1, sender_id: 1, sender_username: 'alice', plaintext: 'hi', timestamp: 1000 }];

    it('asks for older messages when the top of the list is near', () => {
      withViewportHeight(500);
      const loadMoreMessages = vi.fn();
      render(<MessageList {...baseProps({ messages: one, hasMore: true, loadMoreMessages })} />);

      expect(loadMoreMessages).toHaveBeenCalled();
    });

    it('asks again as the user scrolls', () => {
      withViewportHeight(500);
      const loadMoreMessages = vi.fn();
      const { container } = render(<MessageList {...baseProps({ messages: one, hasMore: true, loadMoreMessages })} />);
      loadMoreMessages.mockClear();

      fireEvent.scroll(container.querySelector('.message-scroller'));

      expect(loadMoreMessages).toHaveBeenCalledTimes(1);
    });

    it('stops asking once there is no more history', () => {
      withViewportHeight(500);
      const loadMoreMessages = vi.fn();
      const { container } = render(<MessageList {...baseProps({ messages: one, hasMore: false, loadMoreMessages })} />);
      fireEvent.scroll(container.querySelector('.message-scroller'));

      expect(loadMoreMessages).not.toHaveBeenCalled();
    });
  });

  it('falls back to the default avatar when a profile pic fails to load', () => {
    const msg = { id: 1, sender_id: 1, sender_username: 'alice', plaintext: 'hi', timestamp: 1000 };
    render(<MessageList {...baseProps({ messages: [msg] })} />);

    const img = screen.getByAltText('alice');
    fireEvent.error(img);

    expect(img.src).toContain('default');
  });

  it('keeps rendered attachments mounted across re-renders (e.g. hovering a message)', async () => {
    const url = buildAttachmentUrl('https://s3.test/uploads/a.bin', { key: 'KEY', type: 'image/png', size: 10 });
    const messages = [
      { id: 1, sender_id: 1, sender_username: 'alice', plaintext: `![cat.png](${url})`, timestamp: 1000 },
    ];
    const { rerender } = render(<MessageList {...baseProps({ messages })} />);
    const img = await screen.findByRole('img', { name: 'cat.png' });

    rerender(<MessageList {...baseProps({ messages, hoveredMsgId: 1 })} />);
    rerender(<MessageList {...baseProps({ messages, hoveredMsgId: null })} />);

    expect(screen.getByRole('img', { name: 'cat.png' })).toBe(img);
    expect(loadDecryptedAttachment).toHaveBeenCalledTimes(1);
  });

  it('keeps a sent message mounted when its temp id is swapped for the real one', async () => {
    const url = buildAttachmentUrl('https://s3.test/uploads/b.bin', { key: 'KEY', type: 'image/png', size: 10 });
    const pending = { id: 'temp-1', sender_id: 1, sender_username: 'alice', plaintext: `![dog.png](${url})`, timestamp: 1000, status: 'pending' };
    const { rerender } = render(<MessageList {...baseProps({ messages: [pending] })} />);
    const img = await screen.findByRole('img', { name: 'dog.png' });

    const saved = { ...pending, id: 42, clientKey: 'temp-1', status: 'sent' };
    rerender(<MessageList {...baseProps({ messages: [saved] })} />);

    expect(screen.getByRole('img', { name: 'dog.png' })).toBe(img);
  });

  it('keys rows by message so deleting one does not re-use its row for the next message', async () => {
    const urlA = buildAttachmentUrl('https://s3.test/uploads/a.bin', { key: 'KA', type: 'image/png', size: 10 });
    const urlB = buildAttachmentUrl('https://s3.test/uploads/b.bin', { key: 'KB', type: 'image/png', size: 10 });
    const a = { id: 1, sender_id: 2, sender_username: 'bob', plaintext: `![a.png](${urlA})`, timestamp: 1 };
    const b = { id: 2, sender_id: 2, sender_username: 'bob', plaintext: `![b.png](${urlB})`, timestamp: 2 };
    const { rerender } = render(<MessageList {...baseProps({ messages: [a, b] })} />);
    const imgB = await screen.findByRole('img', { name: 'b.png' });

    rerender(<MessageList {...baseProps({ messages: [b] })} />);

    expect(screen.getByRole('img', { name: 'b.png' })).toBe(imgB);
  });

  describe('emoji', () => {
    const index = buildEmojiIndex(emojiData);
    const renderWithEmoji = (messages) =>
      render(
        <EmojiContext.Provider value={index}>
          <MessageList {...baseProps({ messages })} />
        </EmojiContext.Provider>
      );

    it('renders emoji as Twemoji images (not attachments)', () => {
      renderWithEmoji([{ id: 1, sender_id: 2, sender_username: 'bob', plaintext: 'nice 👍', timestamp: 1 }]);

      const img = screen.getByRole('img', { name: '👍' });
      expect(img).toHaveAttribute('src', '/emoji/1f44d.svg');
      expect(img).toHaveClass('emoji');
    });

    it('shows emoji-only messages large', () => {
      renderWithEmoji([
        { id: 1, sender_id: 2, sender_username: 'bob', plaintext: '🎉🎉', timestamp: 1 },
        { id: 2, sender_id: 2, sender_username: 'bob', plaintext: 'party 🎉', timestamp: 2 },
      ]);

      const contentOf = (id) => document.querySelector(`[data-msg-id="${id}"] .dm-message-content`);
      const [onlyEmoji, mixed] = [contentOf(1), contentOf(2)];
      expect(onlyEmoji).toHaveClass('emoji-only');
      expect(mixed).not.toHaveClass('emoji-only');
    });
  });
});

describe('MessageList reactions', () => {
  const reactionProps = (overrides = {}) => baseProps({
    onToggleReaction: vi.fn(),
    onOpenReactionPicker: vi.fn(),
    reactionNames: { 1: 'alice', 2: 'bob' },
    ...overrides,
  });

  it('groups reactions into chips with counts, marking your own', () => {
    const msg = {
      id: 5, sender_id: 2, recipient_id: 1, sender_username: 'bob', plaintext: 'nice', timestamp: 1000,
      reactions: [
        { id: 1, user_id: 2, emoji: '👍' },
        { id: 2, user_id: 1, emoji: '👍' },
        { id: 3, user_id: 1, emoji: '👍' }, // a second device racing the first: counted once
        { id: 4, user_id: 2, emoji: '😂' },
      ],
    };
    const props = reactionProps({ messages: [msg] });
    render(
      <EmojiContext.Provider value={buildEmojiIndex(emojiData)}>
        <MessageList {...props} />
      </EmojiContext.Provider>
    );

    const thumbs = screen.getByRole('button', { name: '👍 2, reacted by bob, You' });
    expect(thumbs).toHaveAttribute('aria-pressed', 'true');
    expect(thumbs.querySelector('img.emoji')).toHaveAttribute('src', '/emoji/1f44d.svg');
    const laugh = screen.getByRole('button', { name: '😂 1, reacted by bob' });
    expect(laugh).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(laugh);
    expect(props.onToggleReaction).toHaveBeenCalledWith(msg, '😂');
    fireEvent.click(screen.getByRole('button', { name: 'Add reaction' }));
    expect(props.onOpenReactionPicker).toHaveBeenCalledWith(msg, expect.any(HTMLElement));
  });

  it('offers a react button on hover, but not for messages still sending', () => {
    const sent = { id: 5, sender_id: 1, recipient_id: 2, sender_username: 'alice', plaintext: 'a', timestamp: 1 };
    const pending = { id: 'temp-1', sender_id: 1, recipient_id: 2, sender_username: 'alice', plaintext: 'b', timestamp: 2, status: 'pending' };
    const { rerender } = render(<MessageList {...reactionProps({ messages: [sent, pending], hoveredMsgId: 5 })} />);
    expect(screen.getByRole('button', { name: 'Add reaction' })).toBeInTheDocument();

    rerender(<MessageList {...reactionProps({ messages: [sent, pending], hoveredMsgId: 'temp-1' })} />);
    expect(screen.queryByRole('button', { name: 'Add reaction' })).not.toBeInTheDocument();
  });

  it('on mobile, a long press opens the message actions instead of a hover menu', () => {
    vi.useFakeTimers();
    try {
      const msg = { id: 5, sender_id: 1, recipient_id: 2, sender_username: 'alice', plaintext: 'hold me', timestamp: 1 };
      const props = reactionProps({ messages: [msg], hoveredMsgId: 5, isMobile: true, onOpenActions: vi.fn() });
      render(<MessageList {...props} />);
      expect(screen.queryByRole('button', { name: 'Add reaction' })).not.toBeInTheDocument();

      fireEvent.touchStart(screen.getByText('hold me'), { touches: [{ clientX: 5, clientY: 5 }] });
      act(() => vi.advanceTimersByTime(500));
      expect(props.onOpenActions).toHaveBeenCalledWith(msg);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the message being reacted to highlighted, and ignores hovering others', () => {
    const a = { id: 5, sender_id: 2, recipient_id: 1, sender_username: 'bob', plaintext: 'first', timestamp: 1 };
    const b = { id: 6, sender_id: 2, recipient_id: 1, sender_username: 'bob', plaintext: 'second', timestamp: 2 };
    const { container, rerender } = render(<MessageList {...reactionProps({ messages: [a, b], hoveredMsgId: 6, focusedMsgId: 5 })} />);

    const row = (text) => screen.getByText(text).closest('.each-dm-message-wrapper');
    expect(container.querySelector('.message-scroller')).toHaveClass('has-focused-message');
    expect(row('first')).toHaveClass('focused');
    expect(row('second')).not.toHaveClass('focused');
    // One menu, on the focused message, not the hovered one.
    expect(container.querySelectorAll('.message-menu')).toHaveLength(1);
    expect(row('first').querySelector('.message-menu')).not.toBeNull();

    rerender(<MessageList {...reactionProps({ messages: [a, b], hoveredMsgId: 6, focusedMsgId: null })} />);
    expect(container.querySelector('.message-scroller')).not.toHaveClass('has-focused-message');
    expect(row('second').querySelector('.message-menu')).not.toBeNull();
  });
});

