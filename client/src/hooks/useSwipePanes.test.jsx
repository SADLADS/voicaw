// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { useRef } from 'react';
import { act, render } from '@testing-library/react';
import { BrowserRouter, unstable_HistoryRouter as HistoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { useSwipePanes } from './useSwipePanes';
import { showContent, showList } from '../utils/mobilePanes';
import { createPhoneHistory, isPanesPage } from '../utils/phoneHistory';

let navigate;

// Layout's use of the panes: on for the chats (/dm..., /guild...) and Settings (its column and
// page; /settings alone opens on the list), off elsewhere (/developers).
function Panes() {
  navigate = useNavigate();
  const { pathname } = useLocation();
  const enabled = isPanesPage(pathname) || pathname.startsWith('/settings');
  const opensOnList = pathname === '/settings';
  const wrapperRef = useRef(null);
  const listRef = useRef(null);
  const contentRef = useRef(null);
  const scrimRef = useRef(null);
  useSwipePanes({ enabled, opensOnList, wrapperRef, listRef, contentRef, scrimRef });
  return (
    <div ref={wrapperRef} data-testid="wrapper">
      <div ref={listRef} />
      <div ref={scrimRef} />
      <div ref={contentRef} />
    </div>
  );
}

// `phone`: with the phone's history (App.jsx), as on a phone.
function start(path, { phone = false } = {}) {
  window.history.replaceState(null, '', path);
  const router = phone
    ? <HistoryRouter history={createPhoneHistory()}><Panes /></HistoryRouter>
    : <BrowserRouter><Panes /></BrowserRouter>;
  const { getByTestId } = render(router);
  const wrapper = getByTestId('wrapper');
  return () => (wrapper.classList.contains('pane-content') ? 'content' : wrapper.classList.contains('pane-list') ? 'list' : 'off');
}

// The way a notification opens a chat (App.jsx's SWMessageHandler, useAndroidApp.js).
async function openFromNotification(url) {
  await act(async () => {
    navigate(url);
    showContent();
  });
}

async function back() {
  await act(async () => {
    const popped = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    window.history.back();
    await popped;
  });
}

describe('useSwipePanes', () => {
  beforeEach(() => {
    window.matchMedia = () => ({ matches: true }); // reduced motion: slides end at once
  });

  it('shows the chat opened from a notification while the list was showing', async () => {
    const pane = start('/dm/1');
    expect(pane()).toBe('content');
    await act(async () => showList());
    expect(pane()).toBe('list');

    await openFromNotification('/dm/2');
    expect(window.location.pathname).toBe('/dm/2');
    expect(pane()).toBe('content');
  });

  it('shows the chat opened from a notification over another page, with the list behind it', async () => {
    const pane = start('/dm/1');
    await act(async () => navigate('/developers'));
    expect(pane()).toBe('off');

    await openFromNotification('/dm/2');
    expect(window.location.pathname).toBe('/dm/2');
    expect(pane()).toBe('content');

    // Back slides to the list, as for any chat.
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    });
    expect(pane()).toBe('list');
  });

  it('still shows the list going to the chats from another page without opening one', async () => {
    const pane = start('/dm/1');
    await act(async () => showList());
    await act(async () => navigate('/developers'));
    await act(async () => navigate('/dm'));
    expect(pane()).toBe('list');
  });

  it('goes back from a chat opened from another chat to its own list, as Discord does', async () => {
    const pane = start('/dm/1', { phone: true });
    const entries = window.history.length;
    // A link in a message, or a mention, to a guild's channel.
    await act(async () => navigate('/guild/5/6'));
    expect(pane()).toBe('content');
    expect(window.history.length).toBe(entries);

    await back();
    expect(pane()).toBe('list');
    expect(window.location.pathname).toBe('/guild/5/6');
  });

  it('does the same after the chat was swiped away', async () => {
    const pane = start('/dm/1', { phone: true });
    await act(async () => navigate('/dm/2'));
    await act(async () => {
      const popped = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
      showList();
      await popped;
    });
    expect(pane()).toBe('list');
    expect(window.location.pathname).toBe('/dm/2');
  });

  it('keeps other pages and threads as entries of their own', async () => {
    const pane = start('/guild/5/6', { phone: true });
    const entries = window.history.length;
    await act(async () => navigate('/guild/5/6?thread=7'));
    expect(window.history.length).toBe(entries + 1);
    await back();
    expect(window.location.search).toBe('');
    expect(pane()).toBe('content');

    await act(async () => navigate('/developers'));
    expect(pane()).toBe('off');
    await back();
    expect(window.location.pathname).toBe('/guild/5/6');
    expect(pane()).toBe('content');
  });

  it('opens Settings on its list, and a page over it, Back going to the list', async () => {
    const pane = start('/settings', { phone: true });
    expect(pane()).toBe('list');
    // Settings' go(): the page slides over the list, replacing the list's entry.
    await act(async () => {
      showContent();
      navigate('/settings/account', { replace: true });
    });
    expect(pane()).toBe('content');
    expect(window.history.state.voicawPane).toBe('pushed'); // the page's own entry, over the list's

    await back();
    expect(pane()).toBe('list');
    expect(window.location.pathname).toBe('/settings/account');
  });

  it('opens a Settings page loaded on its own, with the list behind it', async () => {
    const pane = start('/settings/voice-video', { phone: true });
    expect(pane()).toBe('content');
    await back();
    expect(pane()).toBe('list');
    expect(window.location.pathname).toBe('/settings/voice-video');
  });
});
