import { t } from '../i18n';

// The watched screen share in a window of its own (Pop out, like Discord's): a blank window
// opened from this page, with the page's styles and theme copied in, that StreamPopout draws
// the stream into with a portal (same origin, so the <video> plays the same LiveKit track).
// Being a real window, it can go to another screen, be maximised or go full screen.
// It must be opened from a click (or the browser blocks it). It closes when you stop watching
// (or the stream ends, or you leave voice) and when this page goes; closing it puts the
// stream back on the channel's page. The desktop app lets exactly this window open
// (electron/windowOpen.js), by its name.
export const STREAM_WINDOW_NAME = 'voicaw-stream';
const FEATURES = 'popup,width=1280,height=760';

let popup = null;
let container = null;
let cleanup = null;
const listeners = new Set();

function notify() {
  for (const listener of listeners) listener();
}

function isStyle(node) {
  return node.nodeName === 'STYLE' || (node.nodeName === 'LINK' && node.rel === 'stylesheet');
}

// Copies the page's stylesheets (and any added later: lazily loaded parts, Vite in
// development) and keeps <html>'s theme attributes in step with the page's.
function mirrorPage(doc) {
  const head = document.head;
  for (const node of head.childNodes) {
    if (isStyle(node)) doc.head.appendChild(node.cloneNode(true));
  }
  const root = document.documentElement;
  const copyRoot = () => {
    for (const { name, value } of root.attributes) doc.documentElement.setAttribute(name, value);
  };
  copyRoot();
  const styles = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) if (isStyle(node)) doc.head.appendChild(node.cloneNode(true));
    }
  });
  styles.observe(head, { childList: true });
  const theme = new MutationObserver(copyRoot);
  theme.observe(root, { attributes: true });
  return () => {
    styles.disconnect();
    theme.disconnect();
  };
}

function setUp(win) {
  const doc = win.document;
  // The same window again (one left open by an earlier copy of this page): start afresh.
  doc.head.replaceChildren();
  doc.body.replaceChildren();
  doc.title = t('voice.stream.defaultWindowTitle');
  const charset = doc.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  doc.head.appendChild(charset);
  const stopMirroring = mirrorPage(doc);
  doc.body.className = 'stream-window';
  const root = doc.createElement('div');
  root.className = 'stream-window-root';
  doc.body.appendChild(root);

  // Noticing it closed: `closed` is the only thing every browser reliably reports.
  const timer = setInterval(() => {
    if (win.closed) forget(win);
  }, 500);
  const pageGoes = () => closeStreamWindow();
  window.addEventListener('pagehide', pageGoes);
  cleanup = () => {
    clearInterval(timer);
    window.removeEventListener('pagehide', pageGoes);
    stopMirroring();
  };
  return root;
}

function forget(win) {
  if (popup !== win) return;
  cleanup?.();
  cleanup = null;
  popup = null;
  container = null;
  notify();
}

// Opens the window (or brings it forward). False: the browser blocked it.
export function openStreamWindow() {
  if (popup && !popup.closed) {
    popup.focus();
    return true;
  }
  let win = null;
  try {
    win = window.open('', STREAM_WINDOW_NAME, FEATURES);
  } catch {
    win = null;
  }
  if (!win) return false;
  popup = win;
  container = setUp(win);
  notify();
  win.focus();
  return true;
}

export function closeStreamWindow() {
  const win = popup;
  if (!win) return;
  forget(win);
  win.close();
}

export function setStreamWindowTitle(title) {
  if (popup && !popup.closed) popup.document.title = title;
}

// The element the popped-out stream is drawn into, or null when it isn't popped out.
export function getStreamWindow() {
  return container;
}

export function onStreamWindowChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
