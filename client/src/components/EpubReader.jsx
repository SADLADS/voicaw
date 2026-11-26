import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  faChevronLeft, faChevronRight, faListUl, faXmark, faMinus, faPlus,
} from '@fortawesome/free-solid-svg-icons';
import { Icon } from './Icon';
import { ErrorState } from './ErrorState';
import { openBook } from '../services/epub/epubBook';
import { INTERNAL_LINK } from '../services/epub/sanitize';
import {
  readPosition, savePosition, readTextSize, saveTextSize, TEXT_SIZES,
} from '../utils/epubPosition';
import { t } from '../i18n';
import '../assets/css/epubReader.css';

// Laid over the book's own CSS inside each chapter's shadow root: the app's theme colours (a
// book's black text would vanish on a dark theme), pictures that fit, long words that wrap.
const READER_CSS = `
:host { display: block; }
.epub-body { color: var(--vc-fg); line-height: 1.65; overflow-wrap: break-word; }
.epub-body :where(*:not(svg, svg *)) { color: inherit !important; background-color: transparent !important; }
.epub-body a, .epub-body a * { color: var(--vc-link) !important; }
.epub-body img, .epub-body svg { max-width: 100%; height: auto; }
.epub-body img { max-height: calc(var(--vc-app-height) - 160px); object-fit: contain; }
.epub-body pre { white-space: pre-wrap; }
.epub-body table { max-width: 100%; }
.epub-svg-image { display: inline-block; max-width: 100%; }
.epub-svg-image svg { max-width: 100%; height: auto; }
`;

function ContentsList({ items, current, total, onPick }) {
  return (
    <ol>
      {items.map((item, i) => (
        <li key={i}>
          {item.index >= 0 ? (
            <button
              type="button"
              className={item.index === current ? 'current' : undefined}
              aria-current={item.index === current ? 'true' : undefined}
              onClick={() => onPick(item.index, item.fragment)}
            >
              {item.label || t('media.epub.chapterOf', { number: item.index + 1, total })}
            </button>
          ) : (
            <span>{item.label}</span>
          )}
          {item.children.length > 0 && <ContentsList items={item.children} current={current} total={total} onPick={onPick} />}
        </li>
      ))}
    </ol>
  );
}

// The full-screen reader of an EPUB book (docs/uploads.md, EPUB reader), opened by
// ReaderProvider. `load(onProgress)` resolves to the book's file (a Blob); `positionKey`
// names it for remembering where it was left (none: not remembered). Chapters scroll, one at a
// time, each drawn into a shadow root from sanitised nodes (services/epub/sanitize.js), inside a
// box that keeps even fixed-position content in itself.
export default function EpubReader({ name, load, positionKey, onClose }) {
  const [state, setState] = useState({ status: 'loading' });
  const [progress, setProgress] = useState(null);
  const [index, setIndex] = useState(0);
  const [chapter, setChapter] = useState(null);
  const [chapterError, setChapterError] = useState(false);
  const [contentsOpen, setContentsOpen] = useState(false);
  const [textSize, setTextSize] = useState(readTextSize);
  const scrollRef = useRef(null);
  const hostRef = useRef(null);
  const closeRef = useRef(null);
  // Where to go once the chapter being loaded is drawn: { fragment } or { fraction }.
  const target = useRef(null);
  const book = state.book ?? null;

  useEffect(() => {
    let live = true;
    let opened = null;
    (async () => {
      let blob;
      try {
        blob = await load((fraction) => live && setProgress(fraction));
      } catch (err) {
        console.error('Failed to download book', err);
        if (live) setState({ status: 'error', error: err, downloading: true });
        return;
      }
      if (!live) return;
      setProgress(1);
      try {
        opened = await openBook(blob);
        if (!live) {
          opened.close();
          return;
        }
        const saved = readPosition(positionKey);
        const start = saved && saved.index < opened.chapterCount ? saved : { index: 0, fraction: 0 };
        target.current = { fraction: start.fraction };
        setIndex(start.index);
        setState({ status: 'ready', book: opened });
      } catch (err) {
        console.error('Failed to open book', err);
        if (live) setState({ status: 'error', error: err });
      }
    })();
    return () => {
      live = false;
      opened?.close();
    };
  }, [load, positionKey]);

  useEffect(() => {
    if (!book) return undefined;
    let live = true;
    setChapterError(false);
    book.chapter(index).then((next) => live && setChapter(next), (err) => {
      console.error('Failed to show chapter', err);
      if (live) {
        setChapter(null);
        setChapterError(true);
      }
    });
    return () => { live = false; };
  }, [book, index]);

  // Draws the chapter into the shadow root (a copy of its nodes, so drawing again is the same).
  useLayoutEffect(() => {
    const host = hostRef.current;
    const scroller = scrollRef.current;
    if (!host || !scroller || !chapter) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const styles = [...chapter.styles, READER_CSS].map((css) => {
      const style = document.createElement('style');
      style.textContent = css;
      return style;
    });
    const body = document.createElement('div');
    body.className = `epub-body ${chapter.bodyClass}`.trim();
    body.append(chapter.fragment.cloneNode(true));
    root.replaceChildren(...styles, body);

    const goal = target.current;
    target.current = null;
    const place = () => {
      if (goal?.fragment) {
        const el = root.getElementById(goal.fragment) ?? root.querySelector(`[name="${CSS.escape(goal.fragment)}"]`);
        if (el) {
          el.scrollIntoView({ block: 'start' });
          return;
        }
      }
      scroller.scrollTop = goal?.fraction ? goal.fraction * (scroller.scrollHeight - scroller.clientHeight) : 0;
    };
    place();
    // Pictures change the height as they load: keep the place until the reader scrolls.
    if (goal?.fraction || goal?.fragment) {
      let moved = false;
      const stop = () => { moved = true; };
      scroller.addEventListener('wheel', stop, { once: true, passive: true });
      scroller.addEventListener('touchstart', stop, { once: true, passive: true });
      scroller.addEventListener('keydown', stop, { once: true });
      for (const img of root.querySelectorAll('img')) {
        if (!img.complete) img.addEventListener('load', () => !moved && place(), { once: true });
      }
    }
  }, [chapter]);

  // Remembers the place, a moment after scrolling stops.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !chapter || !positionKey) return undefined;
    let timer = null;
    const save = () => {
      const room = scroller.scrollHeight - scroller.clientHeight;
      savePosition(positionKey, { index: chapter.index, fraction: room > 0 ? scroller.scrollTop / room : 0 });
    };
    const onScroll = () => {
      clearTimeout(timer);
      timer = setTimeout(save, 400);
    };
    save();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      scroller.removeEventListener('scroll', onScroll);
    };
  }, [chapter, positionKey]);

  const goTo = useCallback((next, fragment = '') => {
    if (!book || next < 0 || next >= book.chapterCount) return;
    setContentsOpen(false);
    if (next === chapter?.index && next === index) {
      const root = hostRef.current?.shadowRoot;
      const el = fragment && (root?.getElementById(fragment) ?? root?.querySelector(`[name="${CSS.escape(fragment)}"]`));
      if (el) el.scrollIntoView({ block: 'start' });
      else if (scrollRef.current) scrollRef.current.scrollTop = 0;
      return;
    }
    target.current = fragment ? { fragment } : null;
    setIndex(next);
  }, [book, chapter, index]);

  // Links in the book: another chapter (or a place in this one) is gone to here; another site's
  // opens in the browser (target _blank, sanitize.js); nothing else does anything.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const onClick = (e) => {
      const link = e.composedPath().find((node) => node.localName === 'a');
      if (!link) return;
      const href = link.getAttribute('href') ?? '';
      const internal = INTERNAL_LINK.exec(href);
      if (internal) {
        e.preventDefault();
        let fragment = internal[2];
        try {
          fragment = decodeURIComponent(fragment);
        } catch { /* as it is */ }
        goTo(Number(internal[1]), fragment);
      } else if (!/^(?:https?|mailto):/i.test(href)) {
        e.preventDefault();
      }
    };
    host.addEventListener('click', onClick);
    return () => host.removeEventListener('click', onClick);
  }, [goTo, state.status, chapterError]);

  const changeTextSize = (step) => {
    const at = TEXT_SIZES.indexOf(textSize);
    const next = TEXT_SIZES[Math.min(TEXT_SIZES.length - 1, Math.max(0, at + step))];
    setTextSize(next);
    saveTextSize(next);
  };

  // Keys go to the reader only (stopped at the window's capture phase, as the image viewer's):
  // Escape closes the contents or the book, ← → change chapter, the rest scroll.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const scroller = scrollRef.current;
      const page = (scroller?.clientHeight ?? 0) * 0.9;
      const onButton = e.target instanceof Element && e.target.closest('button');
      const actions = {
        Escape: () => (contentsOpen ? setContentsOpen(false) : onClose()),
        ArrowLeft: () => goTo(index - 1),
        ArrowRight: () => goTo(index + 1),
        ArrowUp: () => scroller?.scrollBy({ top: -60 }),
        ArrowDown: () => scroller?.scrollBy({ top: 60 }),
        PageUp: () => scroller?.scrollBy({ top: -page }),
        PageDown: () => scroller?.scrollBy({ top: page }),
        Home: () => scroller && (scroller.scrollTop = 0),
        End: () => scroller && (scroller.scrollTop = scroller.scrollHeight),
        ...(!onButton ? { ' ': () => scroller?.scrollBy({ top: e.shiftKey ? -page : page }) } : {}),
      };
      const action = actions[e.key];
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      action();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [contentsOpen, goTo, index, onClose]);

  // Focus moves into the reader (so typing doesn't go to the message box) and back after.
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus({ preventScroll: true });
    return () => previous?.focus?.({ preventScroll: true });
  }, []);

  const title = book?.title || name || t('media.epub.untitled');
  let body;
  if (state.status === 'error') {
    // A book that downloaded but can't be read (broken, copy-protected, not an EPUB) says so;
    // a download that failed says why.
    body = state.downloading ? (
      <ErrorState className="epub-reader-error" title={t('media.attachment.downloadFailed')} error={state.error} />
    ) : (
      <ErrorState className="epub-reader-error" title={t('media.epub.cantOpenTitle')} error={t('media.epub.cantOpen')} />
    );
  } else if (state.status === 'loading') {
    body = (
      <div className="epub-reader-status" role="status">
        {progress != null && progress < 1
          ? t('media.attachment.downloading', { percent: Math.floor(progress * 100) })
          : t('media.epub.opening')}
      </div>
    );
  }

  return createPortal(
    <div className="epub-reader" role="dialog" aria-modal="true" aria-label={title}>
      <div className="epub-reader-toolbar">
        <button ref={closeRef} type="button" onClick={onClose} title={t('media.epub.close')} aria-label={t('media.epub.close')}>
          <Icon icon={faXmark} />
        </button>
        <div className="epub-reader-title">
          <span className="epub-reader-name" title={title}>{title}</span>
          {book?.author && <span className="epub-reader-author">{book.author}</span>}
        </div>
        {book && (
          <div className="epub-reader-actions">
            <button type="button" onClick={() => changeTextSize(-1)} disabled={textSize === TEXT_SIZES[0]} title={t('media.epub.smaller')} aria-label={t('media.epub.smaller')}>
              <Icon icon={faMinus} />
            </button>
            <button type="button" onClick={() => changeTextSize(1)} disabled={textSize === TEXT_SIZES[TEXT_SIZES.length - 1]} title={t('media.epub.bigger')} aria-label={t('media.epub.bigger')}>
              <Icon icon={faPlus} />
            </button>
            {book.contents.length > 0 && (
              <button
                type="button"
                className={contentsOpen ? 'active' : undefined}
                onClick={() => setContentsOpen((open) => !open)}
                title={t('media.epub.contents')}
                aria-label={t('media.epub.contents')}
                aria-expanded={contentsOpen}
              >
                <Icon icon={faListUl} />
              </button>
            )}
          </div>
        )}
      </div>
      <div className="epub-reader-main">
        {body ?? (
          <div className="epub-reader-scroll" ref={scrollRef} tabIndex={-1}>
            <div className="epub-reader-page" style={{ fontSize: `${textSize}%` }}>
              {chapterError
                ? <p className="epub-reader-status">{t('media.epub.chapterFailed')}</p>
                : <div ref={hostRef} />}
            </div>
            <div className="epub-reader-pager">
              <button type="button" className="btn btn-secondary" onClick={() => goTo(index - 1)} disabled={index === 0}>
                <Icon icon={faChevronLeft} /> {t('media.epub.previous')}
              </button>
              <span className="epub-reader-progress">{t('media.epub.chapterOf', { number: index + 1, total: book.chapterCount })}</span>
              <button type="button" className="btn btn-secondary" onClick={() => goTo(index + 1)} disabled={index >= book.chapterCount - 1}>
                {t('media.epub.next')} <Icon icon={faChevronRight} />
              </button>
            </div>
          </div>
        )}
        {contentsOpen && book && (
          <nav className="epub-reader-contents" aria-label={t('media.epub.contents')}>
            <div className="epub-reader-contents-header">
              <span>{t('media.epub.contents')}</span>
              <button type="button" onClick={() => setContentsOpen(false)} title={t('media.epub.closeContents')} aria-label={t('media.epub.closeContents')}>
                <Icon icon={faXmark} />
              </button>
            </div>
            <ContentsList items={book.contents} current={index} total={book.chapterCount} onPick={goTo} />
          </nav>
        )}
      </div>
    </div>,
    document.body,
  );
}
