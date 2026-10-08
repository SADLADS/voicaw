// A window of its own (Pop out, like Discord's) that this page draws into with a portal: the
// watched screen share (streamWindow.js) or Watch Together's player (watchPartyWindow.js).
// The page's styles and theme are copied in. Being a real window, it can go to another screen,
// be maximised or go full screen. It must be opened from a click (or the browser blocks it),
// and it closes when this page goes. The desktop app lets exactly these windows open
// (electron/windowOpen.js), by their names.
//
// `url` '' opens a blank window, drawn into at once. Watch Together's needs a real page of
// ours (public/popout.html) instead: YouTube's player refuses to play without a Referer, and a
// blank window sends none. That page loads first, then is drawn into.
const FEATURES = 'popup,width=1280,height=760';

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

export function createPopoutWindow({ name, url = '', title }) {
  let popup = null;
  let container = null;
  let cleanup = null;
  const listeners = new Set();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  function forget(win) {
    if (popup !== win) return;
    cleanup?.();
    cleanup = null;
    popup = null;
    container = null;
    notify();
  }

  function close() {
    const win = popup;
    if (!win) return;
    forget(win);
    win.close();
  }

  // Noticing it closed (`closed` is the only thing every browser reliably reports), and
  // closing it when this page goes.
  function watch(win) {
    const timer = setInterval(() => {
      if (win.closed) forget(win);
    }, 500);
    window.addEventListener('pagehide', close);
    let stopMirroring = null;
    cleanup = () => {
      clearInterval(timer);
      window.removeEventListener('pagehide', close);
      stopMirroring?.();
    };
    return (stop) => {
      stopMirroring = stop;
    };
  }

  function setUp(win, keepMirror) {
    const doc = win.document;
    // The same window again (one left open by an earlier copy of this page): start afresh.
    doc.head.replaceChildren();
    doc.body.replaceChildren();
    doc.title = title();
    const charset = doc.createElement('meta');
    charset.setAttribute('charset', 'utf-8');
    doc.head.appendChild(charset);
    keepMirror(mirrorPage(doc));
    doc.body.className = 'popout-window';
    const root = doc.createElement('div');
    root.className = 'popout-window-root';
    doc.body.appendChild(root);
    container = root;
    notify();
  }

  // Our page loading in it: drawn into once it has (its document replaces the blank one the
  // window starts with).
  function whenLoaded(win, blank, keepMirror) {
    const timer = setInterval(() => {
      if (popup !== win) {
        clearInterval(timer);
        return;
      }
      let doc = null;
      try {
        doc = win.document;
      } catch {
        doc = null; // not ours (yet)
      }
      if (!doc || doc === blank || doc.readyState !== 'complete') return;
      clearInterval(timer);
      setUp(win, keepMirror);
    }, 50);
  }

  return {
    // Opens the window (or brings it forward). False: the browser blocked it.
    open() {
      if (popup && !popup.closed) {
        popup.focus();
        return true;
      }
      let win = null;
      try {
        win = window.open(url, name, FEATURES);
      } catch {
        win = null;
      }
      if (!win) return false;
      popup = win;
      const keepMirror = watch(win);
      if (url) whenLoaded(win, win.document, keepMirror);
      else setUp(win, keepMirror);
      win.focus();
      return true;
    },
    close,
    setTitle(text) {
      if (container && popup && !popup.closed) popup.document.title = text;
    },
    // The element drawn into, or null when it isn't open (or still loading).
    get: () => container,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
