// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import React, { createRef } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../utils/api', () => ({ default: { get: vi.fn(async () => ({ data: [] })), post: vi.fn() } }));
vi.mock('../utils/ws-client', () => ({ setActiveChat: vi.fn() }));

import Composer from './Composer';

function renderComposer(props = {}) {
  render(
    <Composer
      chatId="channel-1"
      chatName="general"
      isMobile={false}
      maxPlaintextLength={4000}
      s3Endpoint="https://s3.test"
      inputRef={createRef()}
      replyTo={null}
      onCancelReply={vi.fn()}
      error={null}
      setError={vi.fn()}
      showEmojiPicker={false}
      setShowEmojiPicker={vi.fn()}
      onSend={vi.fn()}
      onSendPoll={vi.fn()}
      people={[]}
      focusOnOpen={false}
      {...props}
    />
  );
}

describe('the message box’s + button', () => {
  it('on a computer, a menu that can start a thread where threads can be started', () => {
    const onStartThread = vi.fn();
    renderComposer({ onStartThread });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('menuitem', { name: 'Create poll' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create thread' }));
    expect(onStartThread).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('has no Create thread elsewhere', () => {
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.queryByRole('menuitem', { name: 'Create thread' })).toBeNull();
  });

  it('on a phone, opens the panel instead, and the emoji panel closes it', () => {
    const setShowEmojiPicker = vi.fn();
    const onStartThread = vi.fn();
    renderComposer({ isMobile: true, setShowEmojiPicker, onStartThread });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Add to message' })).toBeInTheDocument();
    expect(setShowEmojiPicker).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByRole('button', { name: 'Thread' }));
    expect(onStartThread).toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Add to message' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));
    expect(screen.queryByRole('dialog', { name: 'Add to message' })).toBeNull();
  });
});
