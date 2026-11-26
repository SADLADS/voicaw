import React, { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { ReaderContext } from '../contexts';

// The readers and everything they need (a book's parser and DOMPurify; PDF.js) load only when
// the first book or PDF is opened.
const EpubReader = lazy(() => import('./EpubReader'));
const PdfReader = lazy(() => import('./PdfReader'));

const HISTORY_MARK = 'voicawReader';

// Holds the one open book or PDF (EPUB reader and PDF reader in docs/uploads.md):
// `openReader({ kind: 'epub' | 'pdf', name, load, positionKey })`. Like the image viewer
// (ImageViewerProvider), opening one adds a history entry, so the back button closes it instead
// of leaving the chat. The entry is marked with this opening's own time: an entry left marked by
// an earlier one (the page reloaded with a reader open) isn't taken for it.
export default function ReaderProvider({ children }) {
  const [open, setOpen] = useState(null);

  const openReader = useCallback((next) => {
    const opened = Date.now();
    window.history.pushState({ ...window.history.state, [HISTORY_MARK]: opened }, '');
    setOpen({ ...next, opened });
  }, []);

  const opened = open?.opened;
  const close = useCallback(() => {
    if (opened && window.history.state?.[HISTORY_MARK] === opened) window.history.back(); // popstate closes it
    else setOpen(null);
  }, [opened]);

  useEffect(() => {
    if (!opened) return undefined;
    const onPopState = () => {
      if (window.history.state?.[HISTORY_MARK] !== opened) setOpen(null);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [opened]);

  const value = useMemo(() => ({ openReader }), [openReader]);
  const Reader = open?.kind === 'pdf' ? PdfReader : EpubReader;

  return (
    <ReaderContext.Provider value={value}>
      {children}
      {open && (
        <Suspense fallback={null}>
          <Reader
            key={open.opened}
            name={open.name}
            load={open.load}
            positionKey={open.positionKey}
            onClose={close}
          />
        </Suspense>
      )}
    </ReaderContext.Provider>
  );
}
