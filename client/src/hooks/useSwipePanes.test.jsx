// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { useRef, useState } from 'react';
import { act, fireEvent, render, within } from '@testing-library/react';
import { BrowserRouter, unstable_HistoryRouter as HistoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { springAt, springFrames, tapSpeed, useSwipePanes } from './useSwipePanes';
import { useBackClosesWhile } from './useBackCloses';
import { showContent, showList } from '../utils/mobilePanes';
import { createPhoneHistory, isPanesPage } from '../utils/phoneHistory';

let navigate;
let setPanel;

// A panel over the chat with an entry of its own, as the message box's emoji and + panels.
function Panel() {
  const [open, setOpen] = useState(false);
  setPanel = setOpen;
  useBackClosesWhile(open, () => setOpen(false), 'testPanel');
  return open ? <div data-testid="panel" /> : null;
}

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
      <div ref={contentRef}><Panel /><span data-testid="chat" /><span role="slider" data-testid="seek" /></div>
    </div>
  );
}

let panelOpen;

// `phone`: with the phone's history (App.jsx), as on a phone.
function start(path, { phone = false } = {}) {
  window.history.replaceState(null, '', path);
  const router = phone
    ? <HistoryRouter history={createPhoneHistory()}><Panes /></HistoryRouter>
    : <BrowserRouter><Panes /></BrowserRouter>;
  const { getByTestId, queryByTestId } = render(router);
  const wrapper = getByTestId('wrapper');
  panelOpen = () => Boolean(queryByTestId('panel'));
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

  it('closes a panel over the chat with Back, staying in the chat', async () => {
    const pane = start('/dm/1', { phone: true });
    const entries = window.history.length;
    await act(async () => setPanel(true));
    expect(window.history.length).toBe(entries + 1);

    await back();
    expect(panelOpen()).toBe(false);
    expect(pane()).toBe('content');
    await back();
    expect(pane()).toBe('list');
  });

  it('takes the entry back out when the panel closes some other way', async () => {
    start('/dm/1', { phone: true });
    await act(async () => setPanel(true));
    const popped = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    await act(async () => setPanel(false)); // its effect goes back once the update is done
    await act(async () => popped);
    expect(window.history.state.testPanel).toBeUndefined();
    expect(window.history.state.voicawPane).toBe('pushed');
  });

  it('closes a panel when going to the list, landing on the list', async () => {
    const pane = start('/dm/1', { phone: true });
    await act(async () => setPanel(true));
    await act(async () => {
      const popped = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
      showList();
      await popped;
    });
    expect(pane()).toBe('list');
    expect(panelOpen()).toBe(false);
    expect(window.history.state?.voicawPane).toBeUndefined();
  });

  it('does the same from a thread, whose entry was marked in place', async () => {
    const pane = start('/guild/5/6', { phone: true });
    await act(async () => navigate('/guild/5/6?thread=7'));
    expect(window.history.state.voicawPane).toBe('replaced');
    await act(async () => setPanel(true));
    await act(async () => {
      const popped = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
      showList();
      await popped;
    });
    expect(pane()).toBe('list');
    expect(panelOpen()).toBe(false);
    expect(window.location.search).toBe('?thread=7');
    expect(window.history.state?.voicawPane).toBeUndefined();
  });

  it('goes to the list from a panel that closed a moment before (a tap outside it on the arrow)', async () => {
    const pane = start('/dm/1', { phone: true });
    await act(async () => setPanel(true));
    await act(async () => setPanel(false)); // the panel's outside-click handler, on mousedown
    const popped = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    await act(async () => showList()); // the arrow's click
    await act(async () => popped);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600))); // past its entry's delay
    expect(pane()).toBe('list');
    expect(window.history.state?.voicawPane).toBeUndefined();
    expect(window.history.state?.testPanel).toBeUndefined();
  });
});

describe('useSwipePanes swipe', () => {
  beforeEach(() => {
    window.matchMedia = () => ({ matches: true });
  });

  const at = (x) => ({ touches: [{ identifier: 0, clientX: x, clientY: 100 }] });
  function swipeRight(el) {
    fireEvent.touchStart(el, at(50));
    for (const x of [60, 120, 300]) fireEvent.touchMove(el, at(x));
    fireEvent.touchEnd(el, { touches: [] });
  }

  // Seeking a video (or a voice message) and moving the finger sideways mustn't close the chat.
  it('leaves a touch on a slider alone, and slides back to the list from the chat', async () => {
    const pane = start('/dm/1');
    const { getByTestId } = within(document.body);
    swipeRight(getByTestId('seek'));
    expect(pane()).toBe('content');
    await act(async () => {
      const popped = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
      swipeRight(getByTestId('chat'));
      await popped;
    });
    expect(pane()).toBe('list');
  });
});

describe('springAt', () => {
  it('starts where it was let go and comes to rest at the target', () => {
    expect(springAt(390, 0, 0, 0)).toEqual({ x: 390, v: 0 });
    const end = springAt(390, 0, 0, 1);
    expect(Math.abs(end.x)).toBeLessThan(0.5);
    expect(Math.abs(end.v)).toBeLessThan(30);
  });

  // Stepping the spring per frame made the pane shake back and forth on slow frames.
  it('never turns back, however slow the frames', () => {
    for (const fps of [120, 60, 30, 10]) {
      let last = 390;
      for (let frame = 1; frame <= fps; frame++) {
        const { x } = springAt(390, 0, 0, frame / fps);
        expect(x).toBeLessThanOrEqual(last);
        last = x;
      }
    }
  });
});

describe('springFrames', () => {
  it('lays the slide out from where it was let go to the target, never turning back', () => {
    for (const [from, v, target] of [[390, 0, 0], [120, 1500, 390], [300, -2000, 0], [0, 0, 390]]) {
      const { xs, duration } = springFrames(from, v, target, 390);
      expect(xs[0]).toBe(from);
      expect(xs.at(-1)).toBe(target);
      expect(duration).toBeGreaterThan(0);
      expect(duration).toBeLessThan(1000);
      const dir = Math.sign(target - from);
      for (let i = 1; i < xs.length; i++) expect((xs[i] - xs[i - 1]) * dir).toBeGreaterThanOrEqual(0);
    }
  });

  // From standing, a tap's slide crept for its first frames: it felt like lag.
  it("starts a tap's slide moving at once, without overshooting", () => {
    for (const [from, target] of [[0, 390], [390, 0]]) {
      const still = springFrames(from, 0, target, 390).xs;
      const { xs } = springFrames(from, tapSpeed(from, target), target, 390);
      const frame = 2; // 1/60 s
      expect(Math.abs(xs[frame] - from)).toBeGreaterThan(390 * 0.15);
      expect(Math.abs(xs[frame] - from)).toBeGreaterThan(3 * Math.abs(still[frame] - from));
      const dir = Math.sign(target - from);
      for (let i = 1; i < xs.length; i++) expect((xs[i] - xs[i - 1]) * dir).toBeGreaterThanOrEqual(0);
      expect(xs.at(-1)).toBe(target);
    }
  });

  it('keeps a flick past the edge on screen', () => {
    const { xs } = springFrames(380, 4000, 390, 390);
    expect(Math.max(...xs)).toBeLessThanOrEqual(390);
  });
});
