// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { resetAudioSettings, setAudioSettings } from '../../voice/audioSettings';
import { isSending, pushToTalkDown, resetPushToTalk } from '../../voice/pushToTalk';

const state = vi.hoisted(() => ({ voice: {} }));
vi.mock('../../hooks/useVoice', () => ({ useVoice: () => state.voice }));

import PushToTalkButton from './PushToTalkButton';

const connected = { status: 'connected', canSpeak: true, selfMute: false, selfDeaf: false };

beforeEach(() => {
  resetAudioSettings();
  resetPushToTalk();
  state.voice = connected;
});

afterEach(() => cleanup());

describe('PushToTalkButton', () => {
  it('only shows in voice with push to talk on', () => {
    const { rerender } = render(<PushToTalkButton />);
    expect(screen.queryByRole('button')).toBeNull();
    act(() => setAudioSettings({ inputMode: 'pushToTalk' }));
    expect(screen.getByRole('button', { name: 'Hold to talk' })).toBeTruthy();
    state.voice = { ...connected, status: 'connecting' };
    rerender(<PushToTalkButton />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('talks while held, by pointer or keyboard', () => {
    setAudioSettings({ inputMode: 'pushToTalk', pushToTalkDelay: 0 });
    render(<PushToTalkButton />);
    const button = screen.getByRole('button', { name: 'Hold to talk' });
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    expect(isSending()).toBe(true);
    expect(screen.getByRole('button', { name: 'Talking' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.pointerUp(button, { pointerId: 1 });
    expect(isSending()).toBe(false);
    fireEvent.pointerDown(button, { button: 2, pointerId: 1 }); // a right click isn't a press
    expect(isSending()).toBe(false);

    fireEvent.keyDown(button, { key: ' ' });
    expect(isSending()).toBe(true);
    fireEvent.keyUp(button, { key: ' ' });
    expect(isSending()).toBe(false);
  });

  it('lets go when it goes away mid-press, but leaves the key alone', () => {
    setAudioSettings({ inputMode: 'pushToTalk', pushToTalkDelay: 0 });
    const { rerender } = render(<PushToTalkButton />);
    fireEvent.pointerDown(screen.getByRole('button'), { button: 0, pointerId: 1 });
    pushToTalkDown('key');
    state.voice = { status: 'idle' };
    rerender(<PushToTalkButton />);
    expect(isSending()).toBe(true); // the key's still held
  });

  it('is greyed out while muted', () => {
    setAudioSettings({ inputMode: 'pushToTalk' });
    state.voice = { ...connected, selfMute: true };
    render(<PushToTalkButton />);
    const button = screen.getByRole('button');
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("You're muted");
  });
});
