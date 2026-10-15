import { useCallback, useEffect, useRef, useState } from 'react';

let nextToken = 1;

// How many such entries are stacked over the page's own (`history.state[OVERLAYS]`), so going
// back from the chat to the list (useSwipePanes) can go past them in one step, closing them.
export const OVERLAYS = 'voicawOverlays';

function pushOverlay(mark, token) {
  const state = window.history.state ?? {};
  window.history.pushState({ ...state, [mark]: token, [OVERLAYS]: (state[OVERLAYS] ?? 0) + 1 }, '');
}

// Something full screen that the back button (Android's especially) closes, like the image
// viewer (ImageViewerProvider): showing it adds a history entry marked `mark`, over the same
// URL and keeping the router's state, and leaving that entry closes it. Each showing marks its
// entry with its own token, so landing on an older marked entry (left by one that went away
// while open) still counts as leaving. Returns [open, show, close]; close goes back when its
// entry is the current one.
export function useBackCloses(mark) {
  const [open, setOpen] = useState(false);
  const token = useRef(null);

  const show = useCallback(() => {
    token.current = nextToken++;
    pushOverlay(mark, token.current);
    setOpen(true);
  }, [mark]);

  const close = useCallback(() => {
    if (window.history.state?.[mark] === token.current) window.history.back(); // popstate closes it
    else setOpen(false);
  }, [mark]);

  useEffect(() => {
    if (!open) return undefined;
    const onPopState = () => {
      if (window.history.state?.[mark] !== token.current) setOpen(false);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [open, mark]);

  return [open, show, close];
}

// How long a closed one's entry stays before it's taken out. A tap outside the emoji panel
// closes it on mousedown, and the click that follows may open the + panel (which then keeps the
// entry) or go to the list (useSwipePanes goes back past the entry): either must find history
// as it was, not with a back already on its way.
const CLOSE_DELAY_MS = 400;

// The same for something whose open state is kept elsewhere, like the message box's panels on
// a phone (emoji, the + panel): while `open`, an entry marked `mark` is in history and leaving
// it calls `onClose`; closing it any other way takes the entry back out (when it's still the
// current one after CLOSE_DELAY_MS), unless it opened again by then.
export function useBackClosesWhile(open, onClose, mark) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closing = useRef(null); // { token, timer }: closed, its entry about to be taken out

  useEffect(() => {
    if (!open) return undefined;
    const ours = (each) => window.history.state?.[mark] === each;
    let token = closing.current?.token;
    clearTimeout(closing.current?.timer);
    closing.current = null;
    if (token === undefined || !ours(token)) {
      token = nextToken++;
      pushOverlay(mark, token);
    }
    const onPopState = () => {
      if (!ours(token)) onCloseRef.current();
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      if (!ours(token)) return;
      const timer = setTimeout(() => {
        closing.current = null;
        if (ours(token)) window.history.back();
      }, CLOSE_DELAY_MS);
      closing.current = { token, timer };
    };
  }, [open, mark]);
}
