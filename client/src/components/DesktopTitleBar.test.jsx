// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

// The desktop app's bridge (electron/preload.js), before anything reads it.
const bridge = vi.hoisted(() => {
  const listeners = {};
  const api = {
    platform: 'linux',
    listeners,
    windowAction: vi.fn(),
    getWindowState: vi.fn(async () => ({ maximized: false, fullScreen: false, focused: true })),
    onWindowState: (cb) => { listeners.windowState = cb; return () => {}; },
  };
  globalThis.window.voicawDesktop = api;
  return api;
});

vi.mock('../utils/api', () => ({ default: { get: vi.fn() } }));
vi.mock('../services/pushNotifications', () => ({
  notificationFromPush: vi.fn(async (payload) => (payload.drop ? null : {
    title: payload.title,
    options: { body: `worded ${payload.body}`, icon: '/logo192.png', timestamp: Date.now(), data: { url: payload.url } },
  })),
}));

import api from '../utils/api';
import DesktopTitleBar from './DesktopTitleBar';
import { usePageTitle } from '../hooks/usePageTitle';

function Page({ title }) {
  usePageTitle(title);
  return null;
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderBar({ loggedIn = true, title = 'Direct Messages' } = {}) {
  return render(
    <MemoryRouter initialEntries={['/dm']}>
      <DesktopTitleBar loggedIn={loggedIn} />
      <Page title={title} />
      <Routes><Route path="*" element={<Where />} /></Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  bridge.windowAction.mockClear();
  api.get.mockReset();
});

describe('DesktopTitleBar', () => {
  it("shows the page's title, with its guild's icon in a guild, and leaves room for itself", async () => {
    const { unmount } = renderBar({ title: { desktop: 'Book club', web: ['Book club'], guild: { id: 7, name: 'Book club', icon_version: 0 } } });
    expect(screen.getByText('Book club', { selector: '.title-bar-text' })).toBeTruthy();
    expect(document.querySelector('.title-bar-guild-icon').textContent).toBeTruthy();
    expect(document.documentElement.classList.contains('has-title-bar')).toBe(true);
    unmount();
    expect(document.documentElement.classList.contains('has-title-bar')).toBe(false);
  });

  it('works the window: minimise, maximise (restore once maximised), close', async () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Minimise' }));
    fireEvent.click(screen.getByRole('button', { name: 'Maximise' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(bridge.windowAction.mock.calls.map(([action]) => action)).toEqual(['minimize', 'maximize', 'close']);
    act(() => bridge.listeners.windowState({ maximized: true, fullScreen: false, focused: false }));
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy();
    expect(document.querySelector('.title-bar.blurred')).toBeTruthy();
  });

  it('has no inbox before logging in', () => {
    renderBar({ loggedIn: false });
    expect(screen.queryByRole('button', { name: 'Inbox' })).toBeNull();
  });

  it('the inbox lists what notified you, worded as notifications, and opens one', async () => {
    api.get.mockResolvedValue({
      data: [
        { id: 'dm-2', unread: true, payload: { type: 'dm', title: 'Bob', body: 'hi', url: '/dm/2' } },
        { id: 'dm-3', unread: false, payload: { drop: true } },
        { id: 'guild-9', unread: false, payload: { type: 'guild', title: 'Cat (#general, Club)', body: 'ping', url: '/guild/7/99' } },
      ],
    });
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Inbox' }));
    expect(api.get).toHaveBeenCalledWith('/inbox');
    await screen.findByText('worded hi');
    const entries = document.querySelectorAll('.inbox-entry');
    expect(entries).toHaveLength(2);
    expect(entries[0].classList.contains('unread')).toBe(true);
    fireEvent.click(screen.getByText('worded ping'));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/guild/7/99'));
    expect(document.querySelector('.inbox-panel')).toBeNull();
  });

  it('says so when the inbox is empty', async () => {
    api.get.mockResolvedValue({ data: [] });
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Inbox' }));
    expect(await screen.findByText('Nothing in the last 30 days.')).toBeTruthy();
  });
});
