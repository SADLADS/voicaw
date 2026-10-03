// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../services/interactionService', () => ({
  useComponent: vi.fn(async () => ({ ok: true })),
  handleInteractionResult: vi.fn(),
  dismissEphemeral: vi.fn(async () => {}),
}));

import MessageList from './MessageList';
import { dismissEphemeral } from '../services/interactionService';
import { onDismissRequest } from '../utils/botComponents';
import { clearProfiles, mergeProfiles } from '../utils/profiles';

const user = { id: 1, username: 'alice' };
const props = (messages, extra = {}) => ({
  messages, user, hasMore: false, loadMoreMessages: vi.fn(), s3Endpoint: 'https://s3.test', hoveredMsgId: null,
  setHoveredMsgId: vi.fn(), handleEdit: vi.fn(), handleDelete: vi.fn(), handleReply: vi.fn(), editingMessageId: null,
  editingMessageContent: '', setEditingMessageContent: vi.fn(), setEditingMessageId: vi.fn(), handleSaveEdit: vi.fn(),
  isMobile: false, editRef: { current: null }, maxPlaintextLength: 5000, onToggleReaction: vi.fn(),
  onOpenReactionPicker: vi.fn(), ...extra,
});
const bot = { sender_id: 7, sender_username: 'helper#0001', sender_display_name: 'Helper', sender_bot: 1, channel_id: 5, reactions: [] };

beforeEach(() => {
  vi.clearAllMocks();
  clearProfiles();
  mergeProfiles([{ id: 1, username: 'alice' }, { id: 7, username: 'helper#0001', display_name: 'Helper', bot: 1 }]);
});

describe('interaction replies in the message list', () => {
  it('says who used which command above the answer, and never joins it to the message before', () => {
    const messages = [
      { ...bot, id: 1, plaintext: 'Earlier', timestamp: 1000 },
      { ...bot, id: 2, plaintext: 'Pong!', timestamp: 1001, interaction: { id: 9, type: 2, name: 'ping', command_type: 1, user_id: 1 } },
      { ...bot, id: 3, plaintext: 'Wave', timestamp: 1002, interaction: { id: 10, type: 2, name: 'Wave at', command_type: 2, user_id: 1 } },
    ];
    const { container } = render(<MessageList {...props(messages)} />);
    const headers = container.querySelectorAll('.interaction-header');
    expect(headers[0]).toHaveTextContent('alice used /ping');
    expect(headers[1]).toHaveTextContent('alice used Wave at');
    expect(container.querySelector('[data-msg-id="2"]')).not.toHaveClass('grouped');
  });

  it('shows "<bot> is thinking…" for a deferred reply', () => {
    render(<MessageList {...props([{ ...bot, id: 4, plaintext: '', content: '', flags: 128, timestamp: 1000 }])} />);
    expect(screen.getByRole('status')).toHaveTextContent('Helper is thinking');
  });

  it('marks an ephemeral reply as only yours, with no reactions or menu, and Dismiss removes it', () => {
    const dismissed = vi.fn();
    const stop = onDismissRequest(dismissed);
    const id = 2 ** 52 + 5;
    const { container } = render(<MessageList {...props([{ ...bot, id, plaintext: 'Secret', timestamp: 1000, ephemeral: true }], { hoveredMsgId: id })} />);
    expect(container.querySelector(`[data-msg-id="${id}"]`)).toHaveClass('ephemeral');
    expect(screen.getByText('Only you can see this')).toBeInTheDocument();
    expect(container.querySelector('.message-menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss message' }));
    expect(dismissed).toHaveBeenCalledWith(id);
    expect(dismissEphemeral).toHaveBeenCalledWith(id);
    stop();
  });
});
