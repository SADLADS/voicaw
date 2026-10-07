// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const voice = vi.hoisted(() => ({ state: { watchingReady: false, selfDeaf: false } }));
vi.mock('../../hooks/useVoice', () => ({ useVoice: () => voice.state }));
vi.mock('../../voice/voiceClient', () => ({ attachStream: () => () => {}, setStreamError() {}, watchStream() {} }));
vi.mock('../../voice/streamWindow', () => ({ closeStreamWindow() {}, openStreamWindow() {} }));

import StreamView from './StreamView';
import { getStreamVolume, getUserVolume, setStreamVolume } from '../../voice/userVolumes';

afterEach(() => {
  cleanup();
  setStreamVolume(7, 1);
  voice.state = { watchingReady: false, selfDeaf: false };
});

describe('StreamView volume', () => {
  it('sets the stream’s own volume, up to 200%', () => {
    render(<StreamView userId={7} name="alice" />);
    const slider = screen.getByRole('slider', { name: 'Stream volume (just for you)' });
    expect(slider.value).toBe('100');
    fireEvent.change(slider, { target: { value: '150' } });
    expect(getStreamVolume(7)).toBe(1.5);
    expect(getUserVolume(7)).toBe(1);
    expect(slider.getAttribute('aria-valuetext')).toBe('150%');
  });

  it('mutes, and unmuting goes back to the volume it had', () => {
    setStreamVolume(7, 0.6);
    render(<StreamView userId={7} name="alice" />);
    fireEvent.click(screen.getByRole('button', { name: 'Mute the stream' }));
    expect(getStreamVolume(7)).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Unmute the stream' }));
    expect(getStreamVolume(7)).toBe(0.6);
  });

  it('is disabled while deafened', () => {
    voice.state = { watchingReady: false, selfDeaf: true };
    render(<StreamView userId={7} name="alice" />);
    expect(screen.getByRole('button', { name: 'Unmute the stream' }).disabled).toBe(true);
    expect(screen.getByRole('slider').disabled).toBe(true);
  });

  it('isn’t offered for our own stream', () => {
    render(<StreamView userId={7} name="alice" own />);
    expect(screen.queryByRole('slider')).toBeNull();
  });
});
