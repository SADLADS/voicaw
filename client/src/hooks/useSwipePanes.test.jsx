// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { useRef } from 'react';
import { act, render } from '@testing-library/react';
import { BrowserRouter, useLocation, useNavigate } from 'react-router-dom';
import { useSwipePanes } from './useSwipePanes';
import { showContent, showList } from '../utils/mobilePanes';

let navigate;

// Layout's use of the panes: on for the chats (/dm...), off elsewhere (/settings).
function Panes() {
  navigate = useNavigate();
  const enabled = useLocation().pathname.startsWith('/dm');
  const wrapperRef = useRef(null);
  const listRef = useRef(null);
  const contentRef = useRef(null);
  const scrimRef = useRef(null);
  useSwipePanes({ enabled, wrapperRef, listRef, contentRef, scrimRef });
  return (
    <div ref={wrapperRef} data-testid="wrapper">
      <div ref={listRef} />
      <div ref={scrimRef} />
      <div ref={contentRef} />
    </div>
  );
}

function start(path) {
  window.history.replaceState(null, '', path);
  const { getByTestId } = render(<BrowserRouter><Panes /></BrowserRouter>);
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

  it('shows the chat opened from a notification over Settings, with the list behind it', async () => {
    const pane = start('/dm/1');
    await act(async () => navigate('/settings'));
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

  it('still shows the list going to the chats from Settings without opening one', async () => {
    const pane = start('/dm/1');
    await act(async () => showList());
    await act(async () => navigate('/settings'));
    await act(async () => navigate('/dm'));
    expect(pane()).toBe('list');
  });
});
