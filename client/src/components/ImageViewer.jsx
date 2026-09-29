import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faMagnifyingGlassMinus,
  faMagnifyingGlassPlus,
  faDownload,
  faArrowUpRightFromSquare,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { formatBytes } from '../utils/formatBytes';
import { saveUrlAs, openInNewTab } from '../utils/saveFile';
import {
  ZOOM_STEP,
  clampView,
  fittedView,
  isZoomed,
  toggleZoomAt,
  zoomAt,
} from '../utils/imageZoom';
import '../assets/css/imageViewer.css';

// A press that moves less than this, and lifts sooner than TAP_MS, is a tap.
const TAP_SLOP_PX = 8;
const TAP_MS = 350;
// Two taps this close in time and space are a double tap.
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;

function wheelZoomFactor(e) {
  // Trackpad pinches arrive as ctrl+wheel with small deltas; mouse wheels as big steps.
  const pixels = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
  return Math.exp(-pixels * (e.ctrlKey ? 0.01 : 0.002));
}

// Full-screen view of one image: zoom (wheel, pinch, double click/tap, buttons, + - 0 keys),
// pan (drag), save, open in a new tab. Rendered into <body> by ImageViewerProvider, outside
// the message list, so its touches don't reach the message's long press.
export default function ImageViewer({ image, onClose }) {
  const { src, name, size } = image;
  const stageRef = useRef(null);
  const closeRef = useRef(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState(
    image.width && image.height ? { width: image.width, height: image.height } : null
  );
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  // Animate button/keyboard/double-click zooms, but not drags and pinches.
  const [animate, setAnimate] = useState(false);
  const fitted = useRef(true);

  const ready = natural && stage.width > 0;

  // Always-current values for the gesture handlers below.
  const live = useRef({});
  live.current = { view, stage, natural };

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
    if (!ready) return;
    setAnimate(false);
    setView((v) => (fitted.current ? fittedView(stage, natural) : clampView(v, stage, natural)));
  }, [ready, stage, natural]);

  const zoomBy = useCallback((factor) => {
    const { view: v, stage: s, natural: n } = live.current;
    if (n) update(zoomAt(v, v.scale * factor, 0, 0, s, n), { animated: true });
  }, [update]);

  const resetZoom = useCallback(() => {
    const { stage: s, natural: n } = live.current;
    if (n) update(fittedView(s, n), { animated: true });
  }, [update]);

  // Keys go to the viewer only: stopped at the window's capture phase, before the composer's
  // Escape-cancels-reply and other listeners see them.
  useEffect(() => {
    const onKeyDown = (e) => {
      const actions = {
        Escape: onClose,
        '+': () => zoomBy(ZOOM_STEP),
        '=': () => zoomBy(ZOOM_STEP),
        '-': () => zoomBy(1 / ZOOM_STEP),
        '0': resetZoom,
      };
      const action = actions[e.key];
      if (!action || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      action();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose, zoomBy, resetZoom]);

  // Focus moves into the viewer (so typing doesn't go to the message box) and back after.
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus({ preventScroll: true });
    return () => previous?.focus?.({ preventScroll: true });
  }, []);

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

  // Pointer gestures: one pointer pans, two pinch, a tap outside the image closes, a
  // double tap/click toggles zoom.
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
      gesture.current = {
        tap: true,
        startX: e.clientX,
        startY: e.clientY,
        startTime: performance.now(),
        onImage: e.target.classList.contains('image-viewer-image'),
      };
    } else {
      gesture.current = { ...gesture.current, tap: false, pinch: pointers.current.size === 2 ? pinchState() : null };
    }
  };

  const onPointerMove = (e) => {
    const previous = pointers.current.get(e.pointerId);
    if (!previous || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > TAP_SLOP_PX) g.tap = false;

    const { view: v, stage: s, natural: n } = live.current;
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

  const percent = ready ? Math.round(view.scale * 100) : null;
  const zoomedIn = ready && isZoomed(view, stage, natural);

  return createPortal(
    <div className="image-viewer" role="dialog" aria-modal="true" aria-label={name}>
      <div className="image-viewer-toolbar">
        <div className="image-viewer-title">
          <span className="image-viewer-name" title={name}>{name}</span>
          {size ? <span className="image-viewer-size">{formatBytes(size)}</span> : null}
        </div>
        <div className="image-viewer-actions">
          <button type="button" className="image-viewer-zoom-button" onClick={() => zoomBy(1 / ZOOM_STEP)} title="Zoom out (−)" aria-label="Zoom out">
            <FontAwesomeIcon icon={faMagnifyingGlassMinus} />
          </button>
          <button
            type="button"
            className="image-viewer-percent"
            onClick={resetZoom}
            title="Fit to screen (0)"
            aria-label="Fit to screen"
          >
            {percent !== null ? `${percent}%` : ''}
          </button>
          <button type="button" className="image-viewer-zoom-button" onClick={() => zoomBy(ZOOM_STEP)} title="Zoom in (+)" aria-label="Zoom in">
            <FontAwesomeIcon icon={faMagnifyingGlassPlus} />
          </button>
          <button type="button" onClick={() => saveUrlAs(src, name)} title="Save" aria-label="Save">
            <FontAwesomeIcon icon={faDownload} />
          </button>
          <button type="button" onClick={() => openInNewTab(src)} title="Open in new tab" aria-label="Open in new tab">
            <FontAwesomeIcon icon={faArrowUpRightFromSquare} />
          </button>
          <button type="button" ref={closeRef} onClick={onClose} title="Close (Esc)" aria-label="Close">
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>
      </div>
      <div
        ref={stageRef}
        className={`image-viewer-stage${zoomedIn ? ' zoomed' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img
          className={`image-viewer-image${animate ? ' animate' : ''}`}
          src={src}
          alt={name}
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
                  transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                }
              : { visibility: 'hidden' }
          }
        />
      </div>
    </div>,
    document.body
  );
}
