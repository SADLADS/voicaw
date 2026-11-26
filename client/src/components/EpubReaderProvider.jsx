import React, { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { EpubReaderContext } from '../contexts';

// The reader and everything it needs (the book's parser, DOMPurify) load only when a book is
// first opened.
const EpubReader = lazy(() => import('./EpubReader'));

const HISTORY_MARK = 'voicawEpubReader';

// Holds the one open book (EPUB reader in docs/uploads.md): `openBook({ name, load, positionKey })`.
// Like the image viewer (ImageViewerProvider), opening it adds a history entry, so the back
// button closes the book instead of leaving the chat. The entry is marked with this opening's
// own time: an entry left marked by an earlier one (the page reloaded with a book open) isn't
// taken for it.
export default function EpubReaderProvider({ children }) {
  const [book, setBook] = useState(null);

  const openBook = useCallback((next) => {
    const opened = Date.now();
    window.history.pushState({ ...window.history.state, [HISTORY_MARK]: opened }, '');
    setBook({ ...next, opened });
  }, []);

  const opened = book?.opened;
  const close = useCallback(() => {
    if (opened && window.history.state?.[HISTORY_MARK] === opened) window.history.back(); // popstate closes it
    else setBook(null);
  }, [opened]);

  useEffect(() => {
    if (!opened) return undefined;
    const onPopState = () => {
      if (window.history.state?.[HISTORY_MARK] !== opened) setBook(null);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [opened]);

  const value = useMemo(() => ({ openBook }), [openBook]);

  return (
    <EpubReaderContext.Provider value={value}>
      {children}
      {book && (
        <Suspense fallback={null}>
          <EpubReader
            key={book.opened}
            name={book.name}
            load={book.load}
            positionKey={book.positionKey}
            onClose={close}
          />
        </Suspense>
      )}
    </EpubReaderContext.Provider>
  );
}
