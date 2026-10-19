// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import Overlay from './Overlay';

// A stand-in for window.voicawOverlay (electron/overlayPreload.js).
function makeBridge() {
  const bridge = { platform: 'linux', sent: [], listeners: {} };
  bridge.onState = (cb) => { bridge.listeners.state = cb; };
  bridge.onToast = (cb) => { bridge.listeners.toast = cb; };
  bridge.send = (message) => bridge.sent.push(message);
  return bridge;
}

const VOICE = {
  title: 'General / Our guild',
  status: 'connected',
  selfMute: false,
  selfDeaf: false,
  members: [
    { id: '1', name: 'Alice', avatar: null, speaking: false, muted: false, deafened: false, self: true },
    { id: '2', name: 'Bob', avatar: null, speaking: true, muted: false, deafened: false, self: false },
    { id: '3', name: 'Carol', avatar: null, speaking: false, muted: true, deafened: true, self: false },
  ],
};

let bridge;
beforeEach(() => {
  vi.useFakeTimers();
  bridge = makeBridge();
});
afterEach(() => vi.useRealTimers());

const show = (state) => act(() => bridge.listeners.state({ voice: VOICE, unlocked: false, position: 'top-left', shortcut: 'CommandOrControl+Shift+O', ...state }));

describe('Overlay', () => {
  it("shows who's in voice, who's talking and who's muted, and how to unlock it for a while", () => {
    const { container } = render(<Overlay bridge={bridge} />);
    expect(container.textContent).toBe('');
    show();
    const rows = container.querySelectorAll('.overlay-member');
    expect([...rows].map((r) => r.textContent)).toEqual(['Alice', 'Bob', 'Carol']);
    expect(rows[1].classList.contains('speaking')).toBe(true);
    expect(rows[2].querySelector('[aria-label="Muted"]')).not.toBeNull();
    expect(rows[2].querySelector('[aria-label="Deafened"]')).not.toBeNull();
    // Locked: no buttons, no channel name.
    expect(screen.queryByRole('button', { name: 'Mute' })).toBeNull();
    expect(screen.queryByText('General / Our guild')).toBeNull();
    expect(screen.getByText('Press Ctrl + Shift + O to use the overlay')).toBeTruthy();
    act(() => vi.advanceTimersByTime(6000));
    expect(screen.queryByText(/to use the overlay/)).toBeNull();
  });

  it('unlocked, has the controls, the corner and Open Voicaw, and locks on Escape or the backdrop', () => {
    const { container } = render(<Overlay bridge={bridge} />);
    show({ unlocked: true });
    expect(screen.getByText('General / Our guild')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deafen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bottom right' }));
    fireEvent.click(screen.getByRole('button', { name: /Open Voicaw/ }));
    expect(screen.getByRole('button', { name: 'Top left' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(container.querySelector('.overlay-backdrop'));
    expect(bridge.sent.filter((m) => m.type !== 'size')).toEqual([
      { type: 'toggleMute' },
      { type: 'toggleDeafen' },
      { type: 'disconnect' },
      { type: 'position', position: 'bottom-right' },
      { type: 'open', url: null },
      { type: 'lock' },
      { type: 'lock' },
    ]);
  });

  it('shows Unmute while muted or deafened', () => {
    render(<Overlay bridge={bridge} />);
    show({ unlocked: true, voice: { ...VOICE, selfDeaf: true } });
    expect(screen.getByRole('button', { name: 'Unmute' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undeafen' })).toBeTruthy();
  });

  it('shows notifications for a few seconds, three at most, a click opening the chat', () => {
    render(<Overlay bridge={bridge} />);
    show({ unlocked: true });
    for (const n of [1, 2, 3, 4]) act(() => bridge.listeners.toast({ title: `Person ${n}`, body: 'hi', url: `/dm/${n}` }));
    expect(screen.queryByText('Person 1')).toBeNull();
    expect(screen.getByText('Person 4')).toBeTruthy();
    fireEvent.click(screen.getByText('Person 2'));
    expect(bridge.sent.at(-1)).toEqual({ type: 'open', url: '/dm/2' });
    act(() => vi.advanceTimersByTime(6000));
    expect(screen.queryByText(/Person/)).toBeNull();
  });
});
