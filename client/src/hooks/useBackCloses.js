import { useCallback, useEffect, useRef, useState } from 'react';

let nextToken = 1;

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
    window.history.pushState({ ...window.history.state, [mark]: token.current }, '');
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
