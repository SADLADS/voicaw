// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';


vi.mock('../services/attachmentCache', () => ({
  loadDecryptedAttachment: vi.fn(async () => 'blob:decrypted'),
  getCachedAttachment: vi.fn(() => null),
}));

import MessageList from './MessageList';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ChannelMentionContext } from '../contexts';
import { clearProfiles, mergeProfiles } from '../utils/profiles';
import { editorFor } from '../editor/editorRegistry';
import emojiData from '@emoji-mart/data/sets/15/twitter.json';
import { buildEmojiIndex } from '../emoji/emojiIndex';
import { EmojiContext } from '../emoji/emojiContext';
import { recordEmojiUse, resetEmojiUsage } from '../emoji/emojiUsage';
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

  it('draws the "New" divider above the first unread message, starting a new group there', () => {
    const messages = [
      { id: 1, sender_id: 2, sender_username: 'bob', plaintext: 'read', timestamp: 1000 },
      { id: 3, sender_id: 2, sender_username: 'bob', plaintext: 'unread', timestamp: 1010 },
      { id: 4, sender_id: 2, sender_username: 'bob', plaintext: 'also unread', timestamp: 1020 },
    ];
    const { container, rerender } = render(<MessageList {...baseProps({ messages, newFrom: 2 })} />);
    const dividers = container.querySelectorAll('.new-divider');
    expect(dividers).toHaveLength(1);
    expect(dividers[0]).toHaveAttribute('aria-label', 'New messages');
    // Right above "unread", whose row shows its author again although bob sent the one before.
    const row = screen.getByText('unread').closest('[data-key]');
    expect(row.querySelector('.new-divider')).toBe(dividers[0]);
    expect(row.querySelector('.message-author')).toBeTruthy();
    expect(screen.getByText('also unread').closest('[data-key]').querySelector('.message-author')).toBeNull();

    rerender(<MessageList {...baseProps({ messages })} />);
    expect(container.querySelector('.new-divider')).toBeNull();
    // Nothing from there on (deleted meanwhile): no divider.
    rerender(<MessageList {...baseProps({ messages, newFrom: 9 })} />);
    expect(container.querySelector('.new-divider')).toBeNull();
  });

  it('draws one line with the date and "New" where a new day starts at the first unread message', () => {
    const messages = [
      { id: 1, sender_id: 2, sender_username: 'bob', plaintext: 'yesterday', timestamp: 1000 },
      { id: 2, sender_id: 2, sender_username: 'bob', plaintext: 'today', timestamp: 1000 + 2 * 86400 },
    ];
    render(<MessageList {...baseProps({ messages, newFrom: 2 })} />);
    const row = screen.getByText('today').closest('[data-key]');
    expect(row.querySelector('.day-divider')).toBeNull();
    expect(row.querySelectorAll('.new-divider')).toHaveLength(1);
    expect(row.querySelector('.new-divider .new-divider-date')).toBeTruthy();
  });

  it('highlights the message being replied to until the reply is sent or cancelled', () => {
    const messages = [
      { id: 1, sender_id: 2, sender_username: 'bob', plaintext: 'first', timestamp: 1000 },
      { id: 2, sender_id: 2, sender_username: 'bob', plaintext: 'second', timestamp: 100000 },
    ];
    const { rerender } = render(<MessageList {...baseProps({ messages, replyingToId: 2 })} />);
    expect(screen.getByText('second').closest('.each-dm-message-wrapper')).toHaveClass('replying');
    expect(screen.getByText('first').closest('.each-dm-message-wrapper')).not.toHaveClass('replying');
    rerender(<MessageList {...baseProps({ messages })} />);
    expect(screen.getByText('second').closest('.each-dm-message-wrapper')).not.toHaveClass('replying');
  });

  it('shows calls in the chat as notices, not messages', () => {
    mergeProfiles([{ id: 2, username: 'bob', display_name: 'Bobby' }]);
    const call = (id, sender, data) => ({ id, sender_id: sender, recipient_id: sender === 1 ? 2 : 1, system: 'call', content: JSON.stringify({ v: 1, ...data }), timestamp: 1000 + id });
    const messages = [
      call(1, 2, { outcome: 'missed', duration: 0, joined: [] }),
      call(2, 1, { outcome: 'declined', duration: 0, joined: [] }),
      call(3, 2, { outcome: 'ended', duration: 300, joined: [1, 2] }),
    ];
    const { container } = render(<MessageList {...baseProps({ messages })} />);
    const notices = [...container.querySelectorAll('.call-log')];
    expect(notices.map((n) => n.textContent)).toEqual([
      'You missed a call from Bobby.',
      'Bobby declined the call.',
      'Bobby started a call that lasted 5 minutes.',
    ]);
    expect(notices.map((n) => n.classList.contains('missed'))).toEqual([true, false, false]);
    expect(container.querySelector('.each-dm-message-wrapper')).toBeNull();
  });

  it('shows display names, and a name opens that person\'s profile card', () => {
    mergeProfiles([{ id: 2, username: 'bob', display_name: 'Bobby', custom_status: 'Fishing', bio: 'I like boats.' }]);
    render(<MessageList {...baseProps({ messages: [{ id: 1, sender_id: 2, sender_username: 'bob', plaintext: 'ahoy', timestamp: 1000 }] })} />);
    const author = screen.getByText('Bobby', { selector: '.message-author' });
    fireEvent.click(author);
    const card = screen.getByRole('dialog', { name: 'Profile of bob' });
    expect(card).toHaveTextContent('Bobby');
    expect(card).toHaveTextContent('bob');
    expect(card).toHaveTextContent('Fishing');
    expect(card).toHaveTextContent('I like boats.');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Profile of bob' })).toBeNull();
    clearProfiles();
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

  it('opens the edit history from "edited", except on bots\' messages', () => {
    const onShowEdits = vi.fn();
    const messages = [
      { id: 1, sender_id: 2, sender_username: 'bob', plaintext: 'first', timestamp: 1000, edited: 1 },
      { id: 2, sender_id: 2, sender_username: 'bob', plaintext: 'grouped', timestamp: 1010, edited: 1 },
      { id: 3, sender_id: 3, sender_username: 'bot', plaintext: 'beep', timestamp: 5000, edited: 1, sender_bot: 1 },
    ];
    const { unmount } = render(<MessageList {...baseProps({ messages, onShowEdits })} />);
    const buttons = screen.getAllByRole('button', { name: /edited/ });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    expect(onShowEdits).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
    unmount();
    // Without a handler (bot DMs), it's plain text.
    const { unmount: unmountPlain } = render(<MessageList {...baseProps({ messages })} />);
    expect(screen.queryAllByRole('button', { name: /edited/ })).toHaveLength(0);
    unmountPlain();
    // On a phone too (the long-press sheet has Edit history).
    render(<MessageList {...baseProps({ messages, onShowEdits, isMobile: true })} />);
    expect(screen.queryAllByRole('button', { name: /edited/ })).toHaveLength(0);
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

  it('draws channel mentions as links to the channel, and asks for the rest of the guilds when one is unknown', () => {
    const messages = [{ id: 1, sender_id: 2, sender_username: 'bob', plaintext: 'see <#5> or <#6>', timestamp: 1000 }];
    const loadAll = vi.fn();
    const channels = { 5: { id: 5, guildId: 9, name: 'general', type: 'text', private: false } };
    function Where() {
      return <span data-testid="where">{useLocation().pathname}</span>;
    }
    render(
      <MemoryRouter initialEntries={['/dm/2']}>
        <ChannelMentionContext.Provider value={{ channels, loadAll }}>
          <Routes><Route path="*" element={<><MessageList {...baseProps({ messages })} /><Where /></>} /></Routes>
        </ChannelMentionContext.Provider>
      </MemoryRouter>
    );
    expect(screen.getByText('unknown-channel')).toHaveClass('mention', 'channel-mention', 'unknown');
    expect(loadAll).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('link', { name: /general/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/guild/9/5');
  });

  it("draws a pasted channel link as the channel's mention, and leaves it a link for those who can't see it", () => {
    const origin = window.location.origin;
    const known = `${origin}/guild/9/5`;
    const otherGuild = `${origin}/guild/8/5`;
    const unseen = 'https://app.voicaw.com/guild/9/6';
    const named = `${origin}/guild/9/5`;
    const messages = [{
      id: 1, sender_id: 2, sender_username: 'bob', timestamp: 1000,
      plaintext: `go ${known} not ${otherGuild} or ${unseen} or [here](${named})`,
    }];
    const loadAll = vi.fn();
    const channels = { 5: { id: 5, guildId: 9, name: 'general', type: 'text', private: false } };
    function Where() {
      return <span data-testid="where">{useLocation().pathname}</span>;
    }
    render(
      <MemoryRouter initialEntries={['/dm/2']}>
        <ChannelMentionContext.Provider value={{ channels, loadAll }}>
          <Routes><Route path="*" element={<><MessageList {...baseProps({ messages })} /><Where /></>} /></Routes>
        </ChannelMentionContext.Provider>
      </MemoryRouter>
    );
    expect(screen.queryByText(known)).toBeNull();
    expect(screen.getByText(otherGuild).tagName).toBe('A');
    expect(screen.getByText(unseen)).toHaveAttribute('href', unseen);
    expect(screen.getByText('here')).toHaveAttribute('href', named);
    // Links open in a new tab: following one in the app's page would leave voice.
    expect(screen.getByText(unseen)).toHaveAttribute('target', '_blank');
    expect(screen.getByText(unseen)).toHaveAttribute('rel', 'noopener noreferrer');
    expect(loadAll).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('link', { name: /general/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/guild/9/5');
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

  it('goes back to the bottom when you send a message, not when someone else does', () => {
    const older = [{ id: 1, sender_id: 2, sender_username: 'bob', plaintext: 'hi', timestamp: 1000 }];
    const { container, rerender } = render(<MessageList {...baseProps({ messages: older })} />);
    // jsdom has no layout: a 2000px list in a 500px view, scrolled up from the bottom to 100.
    const scroller = container.querySelector('.message-scroller');
    let top = 1500;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 2000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 500 });
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => top, set: (v) => { top = v; } });
    fireEvent.scroll(scroller);
    top = 100;
    fireEvent.scroll(scroller);

    const theirs = [...older, { id: 2, sender_id: 2, sender_username: 'bob', plaintext: 'yo', timestamp: 1001 }];
    rerender(<MessageList {...baseProps({ messages: theirs })} />);
    expect(top).toBe(100);

    const mine = [...theirs, { id: 'temp-1', sender_id: 1, sender_username: 'alice', plaintext: 'hey', timestamp: 1002, status: 'pending' }];
    rerender(<MessageList {...baseProps({ messages: mine })} />);
    expect(top).toBe(2000);
  });

  it('keeps following when the content grows under it, and stops when you scroll up', () => {
    const rows = [{ id: 1, sender_id: 2, sender_username: 'bob', plaintext: 'hi', timestamp: 1000 }];
    const { container } = render(<MessageList {...baseProps({ messages: rows })} />);
    const scroller = container.querySelector('.message-scroller');
    let top = 1500;
    let height = 2000;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 500 });
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => top, set: (v) => { top = Math.min(v, height - 500); } });
    fireEvent.scroll(scroller);
    // Following: the browser's scroll anchoring is off, so it can't pull the view up.
    expect(scroller.style.overflowAnchor).toBe('none');

    // A picture loaded before the scroll event ran: a gap below, but nothing moved up.
    height = 2400;
    fireEvent.scroll(scroller);
    expect(top).toBe(1900);
    expect(scroller.style.overflowAnchor).toBe('none');

    // The user scrolls up: no longer following, anchoring back on for reading history.
    top = 1700;
    fireEvent.scroll(scroller);
    height = 2800;
    fireEvent.scroll(scroller);
    expect(top).toBe(1700);
    expect(scroller.style.overflowAnchor).toBe('');
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

  it('offers your three most used emoji on hover, left of the buttons, reacting in one click', () => {
    resetEmojiUsage();
    recordEmojiUse('eyes');
    recordEmojiUse('eyes');
    recordEmojiUse('fire');
    const msg = {
      id: 5, sender_id: 2, recipient_id: 1, sender_username: 'bob', plaintext: 'nice', timestamp: 1000,
      reactions: [{ id: 1, user_id: 1, emoji: '🔥' }],
    };
    const props = reactionProps({ messages: [msg], hoveredMsgId: 5 });
    const { container } = render(
      <EmojiContext.Provider value={buildEmojiIndex(emojiData)}>
        <MessageList {...props} />
      </EmojiContext.Provider>
    );

    const menu = container.querySelector('.message-menu');
    const quick = [...menu.querySelectorAll('.quick-reaction-button')];
    // Topped up with the defaults (👍) while fewer than three have been used.
    expect(quick.map((b) => b.querySelector('img').alt)).toEqual(['👀', '🔥', '👍']);
    expect(menu.firstElementChild).toBe(quick[0]);
    expect(quick[2].nextElementSibling).toHaveClass('message-menu-separator');
    expect(quick[1]).toHaveAttribute('aria-pressed', 'true');
    expect(quick[0]).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(quick[0]);
    expect(props.onToggleReaction).toHaveBeenCalledWith(msg, '👀');
    resetEmojiUsage();
  });

  it('shows no quick reactions where you may not react', () => {
    const msg = { id: 5, sender_id: 2, recipient_id: 1, sender_username: 'bob', plaintext: 'nice', timestamp: 1000 };
    const { container } = render(
      <EmojiContext.Provider value={buildEmojiIndex(emojiData)}>
        <MessageList {...reactionProps({ messages: [msg], hoveredMsgId: 5, canAddReactions: false })} />
      </EmojiContext.Provider>
    );
    expect(container.querySelector('.message-menu')).toBeTruthy();
    expect(container.querySelector('.quick-reaction-button, .message-menu-separator')).toBeNull();
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

  it('on a computer, right-clicking a message opens its menu where it was clicked', () => {
    const msg = { id: 5, sender_id: 2, recipient_id: 1, sender_username: 'bob', plaintext: 'click me [site](https://example.com)', timestamp: 1 };
    const props = reactionProps({ messages: [msg], onOpenMenu: vi.fn() });
    render(<MessageList {...props} />);

    const notPrevented = fireEvent.contextMenu(screen.getByText(/click me/), { clientX: 30, clientY: 40 });
    expect(notPrevented).toBe(false);
    expect(props.onOpenMenu).toHaveBeenCalledWith(msg, { left: 30, right: 30, top: 40, bottom: 40 });

    // A link has its own (copy link, open link: PageMenus).
    props.onOpenMenu.mockClear();
    fireEvent.contextMenu(screen.getByRole('link', { name: 'site' }));
    expect(props.onOpenMenu).not.toHaveBeenCalled();
  });

  it('on mobile, right-click (a long press on Android) does not open the desktop menu', () => {
    const msg = { id: 5, sender_id: 2, recipient_id: 1, sender_username: 'bob', plaintext: 'hold me', timestamp: 1 };
    const props = reactionProps({ messages: [msg], isMobile: true, onOpenActions: vi.fn(), onOpenMenu: vi.fn() });
    render(<MessageList {...props} />);
    fireEvent.contextMenu(screen.getByText('hold me'));
    expect(props.onOpenMenu).not.toHaveBeenCalled();
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

  describe("a webhook's message", () => {
    const hookMessage = (over = {}) => ({
      id: 7, sender_id: 0, sender_username: 'CI', webhook_id: 3, webhook_name: 'CI', webhook_avatar: 'https://ci.test/bot.png',
      plaintext: 'Build done', content: 'Build done', timestamp: 1000, flags: 0, attachments: [],
      embeds: [{
        type: 'rich', title: 'Deploy', url: 'https://ci.test/1', description: 'All **good**', color: 0x57F287,
        fields: [{ name: 'Branch', value: 'dev', inline: true }], footer: { text: 'CI' },
        image: { url: 'https://ci.test/chart.png' }, thumbnail: { url: 'https://ci.test/t.png' },
      }],
      ...over,
    });

    it('shows its name and picture with an APP tag, and no profile card', () => {
      render(<MessageList {...baseProps({ messages: [hookMessage()] })} />);
      const author = screen.getByText('CI', { selector: '.message-author' });
      expect(author.nextElementSibling).toHaveTextContent('APP');
      expect(author).not.toHaveAttribute('role');
      fireEvent.click(author);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      const avatar = document.querySelector('img.message-avatar');
      expect(avatar).toHaveAttribute('src', 'https://ci.test/bot.png');
      expect(avatar).toHaveAttribute('referrerpolicy', 'no-referrer');
    });

    it('draws its embeds, with markdown, links that tell nobody where they came from, and no-referrer images', () => {
      const { container } = render(<MessageList {...baseProps({ messages: [hookMessage()] })} />);
      const embed = container.querySelector('.embed');
      expect(embed.style.getPropertyValue('--embed-color')).toBe('#57f287');
      const title = screen.getByRole('link', { name: 'Deploy' });
      expect(title).toHaveAttribute('href', 'https://ci.test/1');
      expect(title).toHaveAttribute('rel', 'noopener noreferrer');
      expect(embed.querySelector('.embed-description strong')).toHaveTextContent('good');
      expect(embed.querySelector('.embed-field.inline')).toHaveTextContent('Branchdev');
      expect(embed.querySelector('.embed-image')).toHaveAttribute('referrerpolicy', 'no-referrer');
      expect(embed.querySelector('.embed-thumbnail')).toHaveAttribute('src', 'https://ci.test/t.png');
      expect(embed.querySelector('.embed-footer')).toHaveTextContent('CI');
    });

    it("hides its embeds when it asked (SUPPRESS_EMBEDS), and shows its files", () => {
      const files = [
        { id: 'a', filename: 'chart.png', content_type: 'image/png', url: 'https://s3.test/uploads/webhooks/a/chart.png', size: 10, width: 64, height: 32 },
        { id: 'b', filename: 'log.txt', content_type: 'application/octet-stream', url: 'https://s3.test/uploads/webhooks/b/log.txt', size: 2048 },
      ];
      const { container } = render(<MessageList {...baseProps({ messages: [hookMessage({ flags: 4, attachments: files })] })} />);
      expect(container.querySelector('.embed')).toBeNull();
      expect(screen.getByAltText('chart.png')).toHaveAttribute('src', files[0].url);
      const download = screen.getByRole('link', { name: /log\.txt/ });
      expect(download).toHaveAttribute('download', 'log.txt');
      expect(download).toHaveTextContent('2.0 KB');
    });

    it("draws a bot's embeds and files too, with a BOT tag and its profile card", () => {
      const botMessage = {
        id: 8, sender_id: 9, sender_username: 'helperbot#0420', sender_bot: 1, plaintext: 'Forecast', content: 'Forecast',
        timestamp: 1000, flags: 0, attachments: [], embeds: [{ type: 'rich', title: 'Sunny', description: '21°' }],
      };
      const { container } = render(<MessageList {...baseProps({ messages: [botMessage] })} />);
      const author = screen.getByText('helperbot#0420', { selector: '.message-author' });
      expect(author.nextElementSibling).toHaveTextContent('BOT');
      expect(author).toHaveAttribute('role', 'button');
      expect(container.querySelector('.embed')).toHaveTextContent('Sunny');
    });

    it("puts an X beside a link preview, not the sender's own embeds, for those allowed to remove them", () => {
      const preview = { type: 'link', url: 'https://news.test/a', title: 'Story', description: 'Words' };
      const msg = hookMessage({ link_embeds: [preview] });
      const onRemovePreviews = vi.fn();
      const { container, rerender } = render(<MessageList {...baseProps({ messages: [msg], canRemovePreviews: () => true, onRemovePreviews })} />);
      const buttons = screen.getAllByRole('button', { name: 'Remove previews' });
      expect(buttons).toHaveLength(1);
      expect(buttons[0].closest('.removable-embed')).toHaveTextContent('Story');
      fireEvent.click(buttons[0], { shiftKey: true });
      expect(onRemovePreviews).toHaveBeenCalledWith(msg, expect.objectContaining({ shiftKey: true }));

      rerender(<MessageList {...baseProps({ messages: [msg], canRemovePreviews: () => false, onRemovePreviews })} />);
      expect(screen.queryByRole('button', { name: 'Remove previews' })).toBeNull();
      expect(container.querySelector('.removable-embed')).toBeNull();
      expect(container.querySelectorAll('.embed')).toHaveLength(2);
    });

    it("doesn't show a file twice when an embed shows it", () => {
      const chart = { id: 'a', filename: 'chart.png', content_type: 'image/png', url: 'https://s3.test/uploads/webhooks/a/chart.png', size: 10 };
      const { container } = render(<MessageList {...baseProps({ messages: [hookMessage({ attachments: [chart], embeds: [{ type: 'rich', title: 'Load', image: { url: chart.url } }] })] })} />);
      expect(container.querySelectorAll(`img[src="${chart.url}"]`)).toHaveLength(1);
      expect(container.querySelector('.message-files')).toBeNull();
    });
  });
});

