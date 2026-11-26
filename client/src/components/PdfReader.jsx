import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  faChevronDown, faChevronUp, faDownload, faListUl, faMagnifyingGlass, faMinus, faPlus, faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { Icon } from './Icon';
import { ErrorState } from './ErrorState';
import { openPdf, pdfjsLib, PdfPasswordError } from '../services/pdf/pdfjs';
import { keepPdfDataOffline } from '../services/pdf/pdfjsData';
import {
  readPosition, savePosition, readZoom, saveZoom, MIN_SCALE, MAX_SCALE, NAMED_ZOOMS,
} from '../utils/pdfPosition';
import { triggerDownload } from '../utils/saveFile';
import { t } from '../i18n';
import '../assets/css/pdfjsViewer.css';
import '../assets/css/pdfReader.css';

// What Find's state numbers mean (PDF.js's FindState).
const FIND_NOT_FOUND = 1;
const FIND_PENDING = 3;

// The only addresses a PDF's links may go to, opened in the browser (target _blank, PDF.js's
// link service). Links inside the PDF are `#...` and handled by PDF.js.
const OUTSIDE_LINK = /^(?:https?|mailto):/i;

function clampScale(scale) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

function Outline({ items, onPick }) {
  return (
    <ol>
      {items.map((item, i) => (
        <li key={i}>
          {item.dest ? (
            <button type="button" onClick={() => onPick(item.dest)}>{item.title || '—'}</button>
          ) : (
            <span>{item.title}</span>
          )}
          {item.items?.length > 0 && <Outline items={item.items} onPick={onPick} />}
        </li>
      ))}
    </ol>
  );
}

// Asks for a PDF's password (held in this component only while the prompt is up, then handed to
// PDF.js; never saved).
function PasswordPrompt({ wrong, onSubmit, onCancel }) {
  const [password, setPassword] = useState('');
  const inputRef = useRef(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, [wrong]);
  return (
    <form
      className="pdf-reader-password"
      onSubmit={(e) => {
        e.preventDefault();
        if (password) onSubmit(password);
      }}
    >
      <h2>{t('media.pdf.passwordTitle')}</h2>
      <p>{t('media.pdf.passwordHint')}</p>
      <input
        ref={inputRef}
        type="password"
        className="form-control"
        autoComplete="off"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        aria-label={t('media.pdf.password')}
        aria-invalid={wrong || undefined}
        aria-describedby={wrong ? 'pdf-reader-password-wrong' : undefined}
      />
      {wrong && <p className="error-text" id="pdf-reader-password-wrong" role="alert">{t('media.pdf.passwordWrong')}</p>}
      <div className="pdf-reader-password-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>{t('media.pdf.cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={!password}>{t('media.pdf.unlock')}</button>
      </div>
    </form>
  );
}

// The full-screen reader of a PDF (docs/uploads.md, PDF reader), opened by ReaderProvider.
// `load(onProgress)` resolves to the PDF's file (a Blob); `positionKey` names it for remembering
// where it was left (none: not remembered). Pages are laid out and drawn by PDF.js's PDFViewer
// (only those near the screen; far ones are let go), with selectable text and the PDF's links;
// services/pdf/pdfjs.js says what PDF.js is and isn't allowed to do.
export default function PdfReader({ name, load, positionKey, onClose }) {
  const [state, setState] = useState({ status: 'loading' });
  const [progress, setProgress] = useState(null);
  const [password, setPassword] = useState(null); // { wrong, answer(password | null) }
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [scale, setScale] = useState(null);
  const [outline, setOutline] = useState([]);
  const [contentsOpen, setContentsOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [find, setFind] = useState({ state: null, current: 0, total: 0 });
  const containerRef = useRef(null);
  const pagesRef = useRef(null);
  const closeRef = useRef(null);
  const findRef = useRef(null);
  const viewerRef = useRef(null); // { viewer, eventBus, linkService }
  const fileUrl = useRef(null);
  const doc = state.doc ?? null;

  // Downloads and opens the PDF (asking for its password if it has one).
  useEffect(() => {
    let live = true;
    let opened = null;
    (async () => {
      let blob;
      try {
        blob = await load((fraction) => live && setProgress(fraction));
      } catch (err) {
        console.error('Failed to download PDF', err);
        if (live) setState({ status: 'error', error: err, downloading: true });
        return;
      }
      if (!live) return;
      setProgress(1);
      fileUrl.current = URL.createObjectURL(blob);
      try {
        opened = await openPdf(await blob.arrayBuffer(), {
          onPassword: (wrong) => new Promise((answer) => {
            if (live) setPassword({ wrong, answer });
            else answer(null);
          }),
        });
        if (!live) {
          opened.loadingTask.destroy();
          return;
        }
        setPassword(null);
        setState({ status: 'ready', doc: opened });
        keepPdfDataOffline(); // the rest of PDF.js's data files, for reading offline later
      } catch (err) {
        if (!live) return;
        setPassword(null);
        if (err instanceof PdfPasswordError) return; // Cancel: the reader is closing
        console.error('Failed to open PDF', err);
        setState({ status: 'error', error: err });
      }
    })();
    return () => {
      live = false;
      opened?.loadingTask.destroy();
      if (fileUrl.current) URL.revokeObjectURL(fileUrl.current);
      fileUrl.current = null;
    };
  }, [load]);

  // Lays the pages out (PDFViewer), going back to where this PDF was left.
  useEffect(() => {
    const container = containerRef.current;
    const pages = pagesRef.current;
    if (!doc || !container || !pages) return undefined;
    let live = true;
    const abort = new AbortController();
    let savePlace = null;
    let saveTimer = null;
    (async () => {
      const { EventBus, LinkTarget, PDFFindController, PDFLinkService, PDFViewer } = await import('pdfjs-dist/legacy/web/pdf_viewer.mjs');
      const { TouchManager } = pdfjsLib;
      if (!live) return;
      const eventBus = new EventBus();
      const linkService = new PDFLinkService({
        eventBus,
        externalLinkTarget: LinkTarget.BLANK,
        externalLinkRel: 'noopener noreferrer nofollow',
      });
      const findController = new PDFFindController({ eventBus, linkService });
      // No downloadManager (files attached inside a PDF are never opened) and no scripting
      // manager (its JavaScript never runs); forms are drawn but can't be filled in.
      const viewer = new PDFViewer({
        container,
        viewer: pages,
        eventBus,
        linkService,
        findController,
        annotationMode: pdfjsLib.AnnotationMode.ENABLE,
        abortSignal: abort.signal,
      });
      linkService.setViewer(viewer);
      viewerRef.current = { viewer, eventBus, linkService };

      eventBus.on('pagechanging', ({ pageNumber }) => {
        setPage(pageNumber);
        setPageInput(String(pageNumber));
      });
      eventBus.on('scalechanging', ({ scale: next }) => setScale(next));
      const onFindState = ({ state: findState, matchesCount }) => {
        setFind((prev) => ({
          state: findState ?? prev.state,
          current: matchesCount?.current ?? prev.current,
          total: matchesCount?.total ?? prev.total,
        }));
      };
      eventBus.on('updatefindcontrolstate', onFindState);
      eventBus.on('updatefindmatchescount', onFindState);
      eventBus.on('pagesinit', () => {
        const zoom = readZoom();
        viewer.currentScaleValue = String(zoom);
        const saved = readPosition(positionKey);
        if (saved && saved.page <= doc.numPages) {
          viewer.currentPageNumber = saved.page;
          const view = viewer.getPageView(saved.page - 1);
          if (view?.div) container.scrollTop = view.div.offsetTop + saved.fraction * view.div.offsetHeight;
        }
      });

      // Pinch to zoom on touch screens, as PDF.js's own viewer does it.
      new TouchManager({
        container,
        signal: abort.signal,
        onPinching: (origin, previous, distance, dx, dy) => {
          const factor = distance / previous;
          const next = clampScale(viewer.currentScale * factor);
          viewer.updateScale({ drawingDelay: 400, scaleFactor: next / viewer.currentScale, origin, pan: [dx, dy] });
        },
        onPinchEnd: () => saveZoom(clampScale(viewer.currentScale)),
      });

      // Remembers the place, a moment after scrolling stops (and on closing): the page at the
      // top and how far down it.
      if (positionKey) {
        savePlace = () => {
          if (!viewer.pagesCount) return;
          const number = viewer.currentPageNumber;
          const div = viewer.getPageView(number - 1)?.div;
          const fraction = div?.offsetHeight ? (container.scrollTop - div.offsetTop) / div.offsetHeight : 0;
          savePosition(positionKey, { page: number, fraction });
        };
        container.addEventListener('scroll', () => {
          clearTimeout(saveTimer);
          saveTimer = setTimeout(savePlace, 400);
        }, { passive: true, signal: abort.signal });
      }

      viewer.setDocument(doc);
      linkService.setDocument(doc, null);
      doc.getOutline().then((items) => live && setOutline(items ?? []), () => {});
    })().catch((err) => {
      console.error('Failed to show PDF', err);
      if (live) setState({ status: 'error', error: err });
    });
    return () => {
      live = false;
      clearTimeout(saveTimer);
      savePlace?.();
      abort.abort();
      const current = viewerRef.current;
      viewerRef.current = null;
      current?.viewer.setDocument(null);
      current?.linkService.setDocument(null);
    };
  }, [doc, positionKey]);

  // A PDF's links: its own (`#...`) are PDF.js's; another site's (http(s):, mailto:) open in the
  // browser; nothing else (tel:, ftp:...) does anything.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const onClick = (e) => {
      const link = e.target instanceof Element ? e.target.closest('a') : null;
      if (!link) return;
      const href = link.getAttribute('href') ?? '';
      if (href === '' || href.startsWith('#')) return;
      if (!OUTSIDE_LINK.test(href)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    container.addEventListener('click', onClick, true);
    return () => container.removeEventListener('click', onClick, true);
  }, [state.status]);

  // Ctrl/⌘ + the wheel (and a trackpad's pinch) zooms the pages, not the whole app.
  useEffect(() => {
    const container = containerRef.current;
    if (!doc || !container) return undefined;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const viewer = viewerRef.current?.viewer;
      if (!viewer) return;
      const factor = Math.exp(-e.deltaY / 200);
      const next = clampScale(viewer.currentScale * factor);
      viewer.updateScale({ drawingDelay: 400, scaleFactor: next / viewer.currentScale, origin: [e.clientX, e.clientY] });
      saveZoom(next);
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [doc]);

  const setZoom = useCallback((zoom) => {
    const viewer = viewerRef.current?.viewer;
    if (!viewer) return;
    if (typeof zoom === 'number') {
      const next = clampScale(zoom);
      viewer.currentScale = next;
      saveZoom(next);
    } else {
      viewer.currentScaleValue = zoom;
      saveZoom(zoom);
    }
  }, []);

  const stepZoom = useCallback((step) => {
    const viewer = viewerRef.current?.viewer;
    if (!viewer) return;
    setZoom(Math.round(clampScale(viewer.currentScale * (step > 0 ? 1.2 : 1 / 1.2)) * 100) / 100);
  }, [setZoom]);

  const goToPage = useCallback((number) => {
    const viewer = viewerRef.current?.viewer;
    if (!viewer || !doc) return;
    const target = Math.min(doc.numPages, Math.max(1, Math.round(number)));
    viewer.currentPageNumber = target;
    setPageInput(String(target));
  }, [doc]);

  const runFind = useCallback((type, findPrevious = false) => {
    viewerRef.current?.eventBus.dispatch('find', {
      source: null,
      type,
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious,
      matchDiacritics: false,
    });
  }, [query]);

  useEffect(() => {
    if (!findOpen) return undefined;
    if (!query) {
      setFind({ state: null, current: 0, total: 0 });
      return undefined;
    }
    const timer = setTimeout(() => runFind(''), 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, findOpen]);

  const openFind = useCallback(() => {
    setContentsOpen(false);
    setFindOpen(true);
    setTimeout(() => findRef.current?.select(), 0);
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    viewerRef.current?.eventBus.dispatch('findbarclose', { source: null });
  }, []);

  const pickOutline = useCallback((dest) => {
    setContentsOpen(false);
    viewerRef.current?.linkService.goToDestination(dest);
  }, []);

  const download = () => {
    if (fileUrl.current) triggerDownload(fileUrl.current, name);
  };

  // Keys go to the reader only (stopped at the window's capture phase, as the image viewer's):
  // Escape closes Find, the contents or the PDF; ← → Page Up/Down move by a page, Home/End to the
  // first and last; Ctrl/⌘+F finds, Ctrl/⌘ +/− zoom. Typing in a box keeps its own keys.
  useEffect(() => {
    const onKeyDown = (e) => {
      const typing = e.target instanceof Element && e.target.closest('input, textarea');
      const viewer = viewerRef.current?.viewer;
      const mod = e.ctrlKey || e.metaKey;
      let action = null;
      if (e.key === 'Escape') {
        action = () => {
          if (password) {
            password.answer(null);
            onClose();
          } else if (findOpen) closeFind();
          else if (contentsOpen) setContentsOpen(false);
          else onClose();
        };
      } else if (mod && !e.altKey && doc) {
        if (e.key === 'f' || e.key === 'F') action = openFind;
        else if (e.key === '+' || e.key === '=') action = () => stepZoom(1);
        else if (e.key === '-') action = () => stepZoom(-1);
        else if (e.key === '0') action = () => setZoom('auto');
      } else if (!typing && !e.altKey && !mod && viewer && doc) {
        action = {
          ArrowLeft: () => viewer.previousPage(),
          ArrowRight: () => viewer.nextPage(),
          PageUp: () => viewer.previousPage(),
          PageDown: () => viewer.nextPage(),
          Home: () => goToPage(1),
          End: () => goToPage(doc.numPages),
        }[e.key] ?? null;
      }
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      action();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [closeFind, contentsOpen, doc, findOpen, goToPage, onClose, openFind, password, setZoom, stepZoom]);

  // Focus moves into the reader (so typing doesn't go to the message box) and back after.
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus({ preventScroll: true });
    return () => previous?.focus?.({ preventScroll: true });
  }, []);

  const total = doc?.numPages ?? 0;
  let body = null;
  if (password) {
    body = (
      <PasswordPrompt
        key={password.wrong ? 'wrong' : 'first'}
        wrong={password.wrong}
        onSubmit={(value) => {
          setPassword(null);
          password.answer(value);
        }}
        onCancel={() => {
          password.answer(null);
          onClose();
        }}
      />
    );
  } else if (state.status === 'error') {
    body = state.downloading ? (
      <ErrorState className="pdf-reader-error" title={t('media.attachment.downloadFailed')} error={state.error} />
    ) : (
      <ErrorState className="pdf-reader-error" title={t('media.pdf.cantOpenTitle')} error={t('media.pdf.cantOpen')} />
    );
  } else if (state.status === 'loading') {
    body = (
      <div className="pdf-reader-status" role="status">
        {progress != null && progress < 1
          ? t('media.attachment.downloading', { percent: Math.floor(progress * 100) })
          : t('media.pdf.opening')}
      </div>
    );
  }

  let findStatus = '';
  if (findOpen && query && find.state !== FIND_PENDING) {
    findStatus = find.state === FIND_NOT_FOUND || !find.total
      ? t('media.pdf.noMatches')
      : t('media.pdf.matchOf', { current: find.current, count: find.total });
  }

  return createPortal(
    <div className="pdf-reader" role="dialog" aria-modal="true" aria-label={name}>
      <div className="pdf-reader-toolbar">
        <button ref={closeRef} type="button" onClick={onClose} title={t('media.pdf.close')} aria-label={t('media.pdf.close')}>
          <Icon icon={faXmark} />
        </button>
        <div className="pdf-reader-title">
          <span className="pdf-reader-name" title={name}>{name}</span>
        </div>
        {doc && (
          <div className="pdf-reader-actions">
            <form
              className="pdf-reader-page"
              onSubmit={(e) => {
                e.preventDefault();
                const number = Number(pageInput);
                if (Number.isFinite(number)) goToPage(number);
                else setPageInput(String(page));
              }}
            >
              <input
                type="text"
                inputMode="numeric"
                className="pdf-reader-page-input"
                value={pageInput}
                onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
                onBlur={() => setPageInput(String(page))}
                aria-label={t('media.pdf.pageNumber', { total })}
              />
              <span className="pdf-reader-page-total">{t('media.pdf.ofPages', { total })}</span>
            </form>
            <span className="pdf-reader-zoom">
              <button type="button" onClick={() => stepZoom(-1)} disabled={scale != null && scale <= MIN_SCALE} title={t('media.pdf.zoomOut')} aria-label={t('media.pdf.zoomOut')}>
                <Icon icon={faMinus} />
              </button>
              <select
                className="pdf-reader-zoom-select"
                value=""
                onChange={(e) => setZoom(NAMED_ZOOMS.includes(e.target.value) ? e.target.value : Number(e.target.value))}
                aria-label={t('media.pdf.zoom')}
                title={t('media.pdf.zoom')}
              >
                <option value="" disabled hidden>{scale ? t('media.percent', { percent: Math.round(scale * 100) }) : '…'}</option>
                <option value="auto">{t('media.pdf.zoomAuto')}</option>
                <option value="page-width">{t('media.pdf.fitWidth')}</option>
                <option value="page-fit">{t('media.pdf.fitPage')}</option>
                {[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((value) => (
                  <option key={value} value={value}>{t('media.percent', { percent: value * 100 })}</option>
                ))}
              </select>
              <button type="button" onClick={() => stepZoom(1)} disabled={scale != null && scale >= MAX_SCALE} title={t('media.pdf.zoomIn')} aria-label={t('media.pdf.zoomIn')}>
                <Icon icon={faPlus} />
              </button>
            </span>
            <button
              type="button"
              className={findOpen ? 'active' : undefined}
              onClick={() => (findOpen ? closeFind() : openFind())}
              title={t('media.pdf.find')}
              aria-label={t('media.pdf.find')}
              aria-expanded={findOpen}
            >
              <Icon icon={faMagnifyingGlass} />
            </button>
            {outline.length > 0 && (
              <button
                type="button"
                className={contentsOpen ? 'active' : undefined}
                onClick={() => setContentsOpen((open) => !open)}
                title={t('media.pdf.contents')}
                aria-label={t('media.pdf.contents')}
                aria-expanded={contentsOpen}
              >
                <Icon icon={faListUl} />
              </button>
            )}
            <button type="button" onClick={download} title={t('media.attachment.download', { name })} aria-label={t('media.attachment.download', { name })}>
              <Icon icon={faDownload} />
            </button>
          </div>
        )}
      </div>
      {findOpen && doc && (
        <form
          className="pdf-reader-find"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (query) runFind('again', false);
          }}
        >
          <input
            ref={findRef}
            type="search"
            className="form-control"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault();
                if (query) runFind('again', true);
              }
            }}
            placeholder={t('media.pdf.findPlaceholder')}
            aria-label={t('media.pdf.find')}
          />
          <span className="pdf-reader-find-status" role="status">{findStatus}</span>
          <button type="button" onClick={() => query && runFind('again', true)} disabled={!query} title={t('media.pdf.previousMatch')} aria-label={t('media.pdf.previousMatch')}>
            <Icon icon={faChevronUp} />
          </button>
          <button type="submit" disabled={!query} title={t('media.pdf.nextMatch')} aria-label={t('media.pdf.nextMatch')}>
            <Icon icon={faChevronDown} />
          </button>
          <button type="button" onClick={closeFind} title={t('media.pdf.closeFind')} aria-label={t('media.pdf.closeFind')}>
            <Icon icon={faXmark} />
          </button>
        </form>
      )}
      <div className="pdf-reader-main">
        {body ?? (
          <div className="pdf-reader-scroll" ref={containerRef} tabIndex={-1}>
            <div className="pdfViewer" ref={pagesRef} />
          </div>
        )}
        {contentsOpen && outline.length > 0 && (
          <nav className="pdf-reader-contents" aria-label={t('media.pdf.contents')}>
            <div className="pdf-reader-contents-header">
              <span>{t('media.pdf.contents')}</span>
              <button type="button" onClick={() => setContentsOpen(false)} title={t('media.pdf.closeContents')} aria-label={t('media.pdf.closeContents')}>
                <Icon icon={faXmark} />
              </button>
            </div>
            <Outline items={outline} onPick={pickOutline} />
          </nav>
        )}
      </div>
    </div>,
    document.body,
  );
}
