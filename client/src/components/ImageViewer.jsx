import React, { forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faMagnifyingGlassMinus,
  faMagnifyingGlassPlus,
  faDownload,
  faArrowUpRightFromSquare,
  faXmark,
  faChevronLeft,
  faChevronRight,
} from '@fortawesome/free-solid-svg-icons';
import { formatBytes } from '../utils/formatBytes';
import { saveUrlAs, openInNewTab } from '../utils/saveFile';
import { useImageSrc } from '../hooks/useImageSrc';
import {
  ZOOM_STEP,
  clampView,
  fittedView,
  isZoomed,
  toggleZoomAt,
  zoomAt,
} from '../utils/imageZoom';
import { InteractionContext } from '../contexts';
import { t } from '../i18n';
import ImageMenu from './ImageMenu';
import '../assets/css/imageViewer.css';

// A press that moves less than this, and lifts sooner than TAP_MS, is a tap.
const TAP_SLOP_PX = 8;
const TAP_MS = 350;
// Two taps this close in time and space are a double tap.
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;
// Holding a finger still on the image this long opens its menu (ImageMenu).
const HOLD_MS = 500;
// A sideways drag of an unzoomed image further than this goes to the next/previous image.
const SWIPE_MIN_PX = 60;
const SWIPE_MIN_FRACTION = 0.15;
// Past the first/last image, a swipe only follows the finger this much.
const SWIPE_EDGE_RESISTANCE = 0.3;

function wheelZoomFactor(e) {
  // Trackpad pinches arrive as ctrl+wheel with small deltas; mouse wheels as big steps.
  const pixels = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
  return Math.exp(-pixels * (e.ctrlKey ? 0.01 : 0.002));
}

// One image, zoomable and pannable. Remounted for each image (keyed by the viewer), so every
// image starts fitted. The toolbar drives it through its ref: zoomBy(factor), reset().
const ImageStage = forwardRef(function ImageStage(
  { item, onView, onClose, onSwipe, canSwipe, onMenu },
  ref
) {
  const { src, error } = useImageSrc(item);
  const stageRef = useRef(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState(
    item.width && item.height ? { width: item.width, height: item.height } : null
  );
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  // Sideways offset of an unzoomed image while it's being swiped.
  const [swipeX, setSwipeX] = useState(0);
  // Animate button/keyboard/double-click zooms and swipes snapping back, but not drags and
  // pinches.
  const [animate, setAnimate] = useState(false);
  const fitted = useRef(true);

  const ready = Boolean(src && natural && stage.width > 0);

  // Always-current values for the gesture handlers below.
  const live = useRef({});
  live.current = { view, stage, natural, canSwipe };

  const update = useCallback((next, { animated = false } = {}) => {
    const { stage: s, natural: n } = live.current;
    if (!n) return;
    const clamped = clampView(next, s, n);
    fitted.current = !isZoomed(clamped, s, n);
    setAnimate(animated);
    setView(clamped);
  }, []);

  // Track the stage's size (window resizes, phone rotation). A fitted image stays fitted.
  useLayoutEffect(() => {
    const el = stageRef.current;
    const measure = () => setStage({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!natural || !stage.width) return;
    setAnimate(false);
    setView((v) => (fitted.current ? fittedView(stage, natural) : clampView(v, stage, natural)));
  }, [stage, natural]);

  useEffect(() => {
    onView(ready ? { percent: Math.round(view.scale * 100) } : null);
  }, [onView, ready, view.scale]);

  useImperativeHandle(ref, () => ({
    zoomBy(factor) {
      const { view: v, stage: s, natural: n } = live.current;
      if (n) update(zoomAt(v, v.scale * factor, 0, 0, s, n), { animated: true });
    },
    reset() {
      const { stage: s, natural: n } = live.current;
      if (n) update(fittedView(s, n), { animated: true });
    },
  }), [update]);

  // React's wheel listener is passive, so it can't stop the page from scrolling.
  useEffect(() => {
    const el = stageRef.current;
    const onWheel = (e) => {
      e.preventDefault();
      const { view: v, stage: s, natural: n } = live.current;
      if (!n) return;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left - rect.width / 2;
      const py = e.clientY - rect.top - rect.height / 2;
      update(zoomAt(v, v.scale * wheelZoomFactor(e), px, py, s, n));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [update]);

  // Pointer gestures: one pointer pans (or, unzoomed, swipes to the next image), two pinch,
  // a tap outside the image closes, a double tap/click toggles zoom.
  const pointers = useRef(new Map());
  const gesture = useRef(null);
  const lastTap = useRef(null);

  const relativeToStage = (x, y) => {
    const rect = stageRef.current.getBoundingClientRect();
    return { x: x - rect.left - rect.width / 2, y: y - rect.top - rect.height / 2 };
  };

  const pinchState = () => {
    const [a, b] = [...pointers.current.values()];
    return {
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      mid: relativeToStage((a.x + b.x) / 2, (a.y + b.y) / 2),
    };
  };

  const onPointerDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      const { view: v, stage: s, natural: n } = live.current;
      gesture.current = {
        tap: true,
        startX: e.clientX,
        startY: e.clientY,
        startTime: performance.now(),
        onImage: e.target.classList.contains('image-viewer-image'),
        swipe: !n || !isZoomed(v, s, n),
      };
      // A finger held still on the image: its menu (and this touch does nothing else).
      if (e.pointerType === 'touch' && gesture.current.onImage) {
        const g = gesture.current;
        g.holdTimer = setTimeout(() => {
          if (gesture.current !== g || !g.tap || pointers.current.size !== 1) return;
          g.tap = false;
          g.held = true;
          navigator.vibrate?.(10);
          onMenu({ left: g.startX, right: g.startX, top: g.startY, bottom: g.startY });
        }, HOLD_MS);
      }
    } else {
      setSwipeX(0);
      gesture.current = {
        ...gesture.current,
        tap: false,
        swipe: false,
        pinch: pointers.current.size === 2 ? pinchState() : null,
      };
    }
  };

  const onPointerMove = (e) => {
    const previous = pointers.current.get(e.pointerId);
    if (!previous || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (g.held) return;
    if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > TAP_SLOP_PX) g.tap = false;

    const { view: v, stage: s, natural: n, canSwipe: can } = live.current;
    if (pointers.current.size === 1 && g.swipe) {
      const dx = e.clientX - g.startX;
      const allowed = dx < 0 ? can.next : can.previous;
      setAnimate(false);
      setSwipeX(allowed ? dx : dx * SWIPE_EDGE_RESISTANCE);
      return;
    }
    if (!n) return;
    if (pointers.current.size === 1) {
      update({ ...v, x: v.x + e.clientX - previous.x, y: v.y + e.clientY - previous.y });
    } else if (pointers.current.size === 2 && g.pinch) {
      const now = pinchState();
      const zoomed = zoomAt(v, v.scale * (now.distance / g.pinch.distance), g.pinch.mid.x, g.pinch.mid.y, s, n);
      update({ ...zoomed, x: zoomed.x + now.mid.x - g.pinch.mid.x, y: zoomed.y + now.mid.y - g.pinch.mid.y });
      g.pinch = now;
    }
  };

  const onPointerUp = (e) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (pointers.current.size > 0) {
      // Pinch down to one finger: carry on panning from here.
      if (g) g.pinch = null;
      return;
    }
    gesture.current = null;
    clearTimeout(g?.holdTimer);
    if (g?.held) {
      setAnimate(true);
      setSwipeX(0);
      return;
    }

    if (g?.swipe && !g.tap) {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      const { stage: s, canSwipe: can } = live.current;
      const far = Math.abs(dx) > Math.max(SWIPE_MIN_PX, s.width * SWIPE_MIN_FRACTION) && Math.abs(dx) > Math.abs(dy);
      const direction = dx < 0 ? 1 : -1;
      if (e.type !== 'pointercancel' && far && (direction > 0 ? can.next : can.previous)) {
        onSwipe(direction);
        return;
      }
      setAnimate(true);
      setSwipeX(0);
      return;
    }
    if (e.type === 'pointercancel' || !g?.tap || performance.now() - g.startTime > TAP_MS) return;

    const now = performance.now();
    const last = lastTap.current;
    if (last && now - last.time < DOUBLE_TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < DOUBLE_TAP_PX) {
      lastTap.current = null;
      const { view: v, stage: s, natural: n } = live.current;
      const p = relativeToStage(e.clientX, e.clientY);
      if (n) update(toggleZoomAt(v, p.x, p.y, s, n), { animated: true });
      return;
    }
    lastTap.current = { time: now, x: e.clientX, y: e.clientY };
    if (!g.onImage) onClose();
  };

  return (
    <div
      ref={stageRef}
      className={`image-viewer-stage${ready && isZoomed(view, stage, natural) ? ' zoomed' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      // Right-click on the image: its menu. A touch's long press is handled above.
      onContextMenu={(e) => {
        e.preventDefault();
        if (e.nativeEvent.pointerType === 'touch' || gesture.current?.held) return;
        if (e.target.classList.contains('image-viewer-image')) {
          onMenu({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY });
        }
      }}
    >
      {error && <p className="image-viewer-status">{t('media.viewer.loadFailed')}</p>}
      {!src && !error && <p className="image-viewer-status">{t('media.viewer.decrypting')}</p>}
      {src && (
        <img
          className={`image-viewer-image${animate ? ' animate' : ''}`}
          src={src}
          alt={item.name}
          draggable={false}
          onLoad={(e) => {
            const { naturalWidth: width, naturalHeight: height } = e.currentTarget;
            if (width && height) setNatural({ width, height });
          }}
          style={
            ready
              ? {
                  width: `${natural.width}px`,
                  height: `${natural.height}px`,
                  transform:
                    `translate(-50%, -50%) translate(${view.x + swipeX}px, ${view.y}px) scale(${view.scale})`,
                }
              : { visibility: 'hidden' }
          }
        />
      )}
    </div>
  );
});

function Thumbnail({ item, index, current, onSelect }) {
  const { src } = useImageSrc(item, true);
  const ref = useRef(null);

  // Keep the current image's thumbnail in view in a long strip.
  useEffect(() => {
    if (current) ref.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [current]);

  return (
    <button
      ref={ref}
      type="button"
      className={`image-viewer-thumbnail${current ? ' current' : ''}`}
      onClick={() => onSelect(index)}
      aria-label={t('media.viewer.thumbnail', { number: index + 1, name: item.name })}
      aria-current={current ? 'true' : undefined}
    >
      {src ? <img src={src} alt="" draggable={false} /> : <span className="image-viewer-thumbnail-loading" />}
    </button>
  );
}

// Full-screen view of a message's images: zoom (wheel, pinch, double click/tap, buttons,
// + - 0 keys), pan (drag), step through them (arrows, ← → keys, swipe, thumbnails), save,
// open in a new tab; right-clicking the image (holding it on a phone) opens its menu
// (ImageMenu: copy, save, link). Rendered into <body> by ImageViewerProvider, outside the message list,
// so its touches don't reach the message's long press.
export default function ImageViewer({ images, index, onIndexChange, onClose }) {
  const item = images[index];
  const { isMobile } = useContext(InteractionContext);
  // The image's menu (right-click, or hold on a phone): { anchor }.
  const [menu, setMenu] = useState(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const menuOpen = useRef(false);
  menuOpen.current = Boolean(menu);
  const stageRef = useRef(null);
  const closeRef = useRef(null);
  const [viewInfo, setViewInfo] = useState(null);
  const { src } = useImageSrc(item);
  const multiple = images.length > 1;
  const canSwipe = { previous: index > 0, next: index < images.length - 1 };

  const go = useCallback((step) => {
    const next = index + step;
    if (next >= 0 && next < images.length) onIndexChange(next);
  }, [index, images.length, onIndexChange]);

  // Keys go to the viewer only: stopped at the window's capture phase, before the composer's
  // Escape-cancels-reply and other listeners see them.
  useEffect(() => {
    const onKeyDown = (e) => {
      // The image's menu has the keys while it's open (Escape closes it, not the viewer).
      if (menuOpen.current) return;
      const actions = {
        Escape: onClose,
        ArrowLeft: () => go(-1),
        ArrowRight: () => go(1),
        '+': () => stageRef.current?.zoomBy(ZOOM_STEP),
        '=': () => stageRef.current?.zoomBy(ZOOM_STEP),
        '-': () => stageRef.current?.zoomBy(1 / ZOOM_STEP),
        '0': () => stageRef.current?.reset(),
      };
      const action = actions[e.key];
      if (!action || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      action();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose, go]);

  // Focus moves into the viewer (so typing doesn't go to the message box) and back after.
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus({ preventScroll: true });
    return () => previous?.focus?.({ preventScroll: true });
  }, []);

  return createPortal(
    <div className="image-viewer" role="dialog" aria-modal="true" aria-label={item.name}>
      <div className="image-viewer-toolbar">
        <div className="image-viewer-title">
          <span className="image-viewer-name" title={item.name}>{item.name}</span>
          <span className="image-viewer-details">
            {multiple && <span>{index + 1} / {images.length}</span>}
            {item.size ? <span>{formatBytes(item.size)}</span> : null}
          </span>
        </div>
        <div className="image-viewer-actions">
          <button
            type="button"
            className="image-viewer-zoom-button"
            onClick={() => stageRef.current?.zoomBy(1 / ZOOM_STEP)}
            title={t('media.viewer.zoomOutTitle')}
            aria-label={t('media.viewer.zoomOut')}
          >
            <FontAwesomeIcon icon={faMagnifyingGlassMinus} />
          </button>
          <button
            type="button"
            className="image-viewer-percent"
            onClick={() => stageRef.current?.reset()}
            title={t('media.viewer.fitToScreenTitle')}
            aria-label={t('media.viewer.fitToScreen')}
          >
            {viewInfo ? t('media.percent', { percent: viewInfo.percent }) : ''}
          </button>
          <button
            type="button"
            className="image-viewer-zoom-button"
            onClick={() => stageRef.current?.zoomBy(ZOOM_STEP)}
            title={t('media.viewer.zoomInTitle')}
            aria-label={t('media.viewer.zoomIn')}
          >
            <FontAwesomeIcon icon={faMagnifyingGlassPlus} />
          </button>
          <button
            type="button"
            onClick={() => saveUrlAs(src, item.name)}
            disabled={!src}
            title={t('common.save')}
            aria-label={t('common.save')}
          >
            <FontAwesomeIcon icon={faDownload} />
          </button>
          <button
            type="button"
            onClick={() => openInNewTab(src, item.name)}
            disabled={!src}
            title={t('media.viewer.openInNewTab')}
            aria-label={t('media.viewer.openInNewTab')}
          >
            <FontAwesomeIcon icon={faArrowUpRightFromSquare} />
          </button>
          <button
            type="button"
            ref={closeRef}
            onClick={onClose}
            title={t('media.viewer.closeTitle')}
            aria-label={t('common.close')}
          >
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>
      </div>
      <div className="image-viewer-main">
        <ImageStage
          key={index}
          ref={stageRef}
          item={item}
          onView={setViewInfo}
          onClose={onClose}
          onSwipe={go}
          canSwipe={canSwipe}
          onMenu={(anchor) => setMenu({ anchor })}
        />
        {multiple && (
          <>
            <button
              type="button"
              className="image-viewer-nav previous"
              onClick={() => go(-1)}
              disabled={!canSwipe.previous}
              title={t('media.viewer.previousTitle')}
              aria-label={t('media.viewer.previous')}
            >
              <FontAwesomeIcon icon={faChevronLeft} />
            </button>
            <button
              type="button"
              className="image-viewer-nav next"
              onClick={() => go(1)}
              disabled={!canSwipe.next}
              title={t('media.viewer.nextTitle')}
              aria-label={t('media.viewer.next')}
            >
              <FontAwesomeIcon icon={faChevronRight} />
            </button>
          </>
        )}
      </div>
      {multiple && (
        <div className="image-viewer-thumbnails" role="group" aria-label={t('media.viewer.thumbnails')}>
          {images.map((image, i) => (
            <Thumbnail key={i} item={image} index={i} current={i === index} onSelect={onIndexChange} />
          ))}
        </div>
      )}
      {menu && <ImageMenu item={item} anchor={menu.anchor} sheet={isMobile} overViewer onClose={closeMenu} />}
    </div>,
    document.body
  );
}
