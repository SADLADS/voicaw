// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import React, { createRef } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('../utils/api', () => ({ default: { get: vi.fn(async () => ({ data: [] })), post: vi.fn() } }));
vi.mock('../utils/ws-client', () => ({ setActiveChat: vi.fn() }));

// A stand-in microphone: `recorder.level(seconds)` is time passing while recording.
const recorder = vi.hoisted(() => ({ started: 0, cancelled: 0, onLevel: null }));
vi.mock('../services/voiceMessage', async (importOriginal) => ({
  ...(await importOriginal()),
  startVoiceRecorder: async ({ onLevel }) => {
    recorder.started++;
    recorder.onLevel = onLevel;
    return {
      stop: async () => ({
        file: new File(['ogg'], 'voice-message.webm', { type: 'audio/webm' }),
        duration: recorder.seconds,
        waveform: new Uint8Array([1, 2, 3]),
      }),
      cancel: () => { recorder.cancelled++; },
    };
  },
}));
globalThis.MediaRecorder ??= class {};
Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true });
URL.createObjectURL ??= () => 'blob:voice';
URL.revokeObjectURL ??= () => {};

function recordFor(seconds) {
  recorder.seconds = seconds;
  act(() => recorder.onLevel([0.5], seconds));
}
const flush = () => act(async () => {});

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

describe('voice messages', () => {
  it('on a computer, recorded from the + menu and sent as their own message', async () => {
    const onSend = vi.fn(async () => {});
    renderComposer({ onSend });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Voice message' }));
    await flush();
    expect(screen.getByRole('button', { name: 'Delete recording' })).toBeInTheDocument();
    expect(screen.getByRole('textbox').closest('.message-editor-wrapper')).toHaveClass('d-none');
    recordFor(3);

    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
    await flush();
    expect(screen.getByRole('button', { name: 'Play voice message' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send voice message' }));
    await flush();

    expect(onSend).toHaveBeenCalledTimes(1);
    const { text, localAttachments, resolveText } = onSend.mock.calls[0][0];
    expect(text).toMatch(/^!\[voice-message\.webm\]\(attachment:\d+\)$/);
    expect(Object.values(localAttachments)[0]).toMatchObject({ voice: true, duration: 3, type: 'audio/webm' });
    expect(resolveText).toBeInstanceOf(Function);
    expect(screen.queryByRole('button', { name: 'Delete recording' })).toBeNull();
  });

  it('Escape deletes a recording', async () => {
    const onSend = vi.fn();
    renderComposer({ onSend });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Voice message' }));
    await flush();
    const cancelled = recorder.cancelled;
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(recorder.cancelled).toBe(cancelled + 1);
    expect(screen.queryByRole('button', { name: 'Delete recording' })).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('on a phone, a mic in Send’s place while the box is empty: hold to record, let go to send', async () => {
    const onSend = vi.fn(async () => {});
    renderComposer({ isMobile: true, onSend });
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    const mic = screen.getByRole('button', { name: 'Record a voice message' });

    // A tap: only how to.
    fireEvent.pointerDown(mic, { button: 0, clientX: 300, clientY: 600 });
    await flush();
    expect(screen.getByText('Slide to cancel')).toBeInTheDocument();
    fireEvent.pointerUp(mic);
    await flush();
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Hold to record, release to send');

    fireEvent.pointerDown(mic, { button: 0, clientX: 300, clientY: 600 });
    await flush();
    recordFor(2);
    fireEvent.pointerUp(mic);
    await flush();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(Object.values(onSend.mock.calls[0][0].localAttachments)[0]).toMatchObject({ voice: true, duration: 2 });
  });

  it('on a phone, sliding left cancels and sliding up locks', async () => {
    const onSend = vi.fn(async () => {});
    renderComposer({ isMobile: true, onSend });
    const mic = screen.getByRole('button', { name: 'Record a voice message' });

    fireEvent.pointerDown(mic, { button: 0, clientX: 300, clientY: 600 });
    await flush();
    recordFor(2);
    const cancelled = recorder.cancelled;
    fireEvent.pointerMove(mic, { clientX: 150, clientY: 600 });
    fireEvent.pointerUp(mic);
    await flush();
    expect(recorder.cancelled).toBe(cancelled + 1);
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.pointerDown(mic, { button: 0, clientX: 300, clientY: 600 });
    await flush();
    recordFor(2);
    fireEvent.pointerMove(mic, { clientX: 300, clientY: 480 });
    await flush();
    // Locked: letting go doesn't send; Send does.
    expect(screen.getByRole('button', { name: 'Delete recording' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send voice message' }));
    await flush();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('no mic in a bot DM, nor while editing', () => {
    renderComposer({ isMobile: true, textOnly: true });
    expect(screen.queryByRole('button', { name: 'Record a voice message' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });
});
