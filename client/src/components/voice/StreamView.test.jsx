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
  vi.unstubAllGlobals();
  setStreamVolume(7, 1);
  voice.state = { watchingReady: false, selfDeaf: false };
});

describe('StreamView volume', () => {
  it('sets the stream’s own volume, up to 200%', () => {
    vi.stubGlobal('AudioContext', class {});
    render(<StreamView userId={7} name="alice" />);
    const slider = screen.getByRole('slider', { name: 'Stream volume (just for you)' });
    expect(slider.value).toBe('100');
    fireEvent.change(slider, { target: { value: '150' } });
    expect(getStreamVolume(7)).toBe(1.5);
    expect(getUserVolume(7)).toBe(1);
    expect(slider.getAttribute('aria-valuetext')).toBe('150%');
    expect(slider.max).toBe('200');
  });

  it('stops at 100% where voices can’t be boosted', () => {
    setStreamVolume(7, 1.5);
    render(<StreamView userId={7} name="alice" />);
    const slider = screen.getByRole('slider', { name: 'Stream volume (just for you)' });
    expect(slider.max).toBe('100');
    expect(slider.getAttribute('aria-valuetext')).toBe('100%');
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

describe('StreamView watchers', () => {
  it('shows how many others watch, and lists them on a click', async () => {
    const { mergeProfiles } = await import('../../utils/profiles');
    mergeProfiles([{ id: 9, username: 'carol9', display_name: 'Carol' }]);
    voice.state = { watchingReady: true, selfDeaf: false, watchers: { 7: [{ id: '8', username: 'bob' }, { id: '9', username: 'carol9' }] } };
    render(<StreamView userId={7} name="alice" own />);
    const button = screen.getByRole('button', { name: '2 watching: bob, Carol' });
    expect(screen.queryByRole('list')).toBeNull();
    fireEvent.click(button);
    const list = screen.getByRole('list', { name: 'Watching' });
    expect(list.textContent).toContain('Carol');
  });

  it('shows nothing when nobody else watches', () => {
    voice.state = { watchingReady: true, selfDeaf: false, watchers: { 8: [{ id: '9', username: 'carol' }] } };
    render(<StreamView userId={7} name="alice" />);
    expect(screen.queryByRole('button', { name: /\d watching/ })).toBeNull();
  });
});
