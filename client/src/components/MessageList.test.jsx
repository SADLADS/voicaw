// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// react-virtuoso virtualizes based on measured DOM size, which jsdom can't provide.
// Render itemContent directly for every row instead so we're testing MessageList's
// own rendering logic rather than react-virtuoso's layout math.
vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ data, itemContent, startReached, computeItemKey }) => (
    <div data-testid="virtuoso-mock">
      {startReached && (
        <button data-testid="load-more-trigger" onClick={() => startReached(0)} />
      )}
      {data.map((item, index) => (
        <div key={computeItemKey ? computeItemKey(index, item) : index}>{itemContent(index, item)}</div>
      ))}
    </div>
  ),
}));

vi.mock('../services/attachmentCache', () => ({
  loadDecryptedAttachment: vi.fn(async () => 'blob:decrypted'),
  getCachedAttachment: vi.fn(() => null),
}));

import MessageList from './MessageList';
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
    expect(handleDelete).toHaveBeenCalledWith(msg);
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

    const textarea = document.getElementById('edit-input-1');
    expect(textarea).toBeInTheDocument();
    expect(textarea.value).toBe('mine');

    fireEvent.change(textarea, { target: { value: 'mine edited' } });
    expect(setEditingMessageContent).toHaveBeenCalledWith('mine edited');
  });

  it('truncates edits at maxPlaintextLength instead of passing the full value through', () => {
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

    const textarea = document.getElementById('edit-input-1');
    fireEvent.change(textarea, { target: { value: 'way too long' } });

    expect(setEditingMessageContent).toHaveBeenCalledWith('way t');
  });

  it('calls loadMoreMessages when startReached fires and hasMore is true', () => {
    const loadMoreMessages = vi.fn();
    render(
      <MessageList
        {...baseProps({
          messages: [{ id: 1, sender_id: 1, sender_username: 'alice', plaintext: 'hi', timestamp: 1000 }],
          hasMore: true,
          loadMoreMessages,
        })}
      />
    );

    fireEvent.click(screen.getByTestId('load-more-trigger'));
    expect(loadMoreMessages).toHaveBeenCalled();
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
});
