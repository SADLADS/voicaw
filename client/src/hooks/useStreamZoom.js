import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MAX_ZOOM } from '../utils/imageZoom';

// Zooming into a watched stream (StreamView): the wheel zooms on the point under the pointer,
// two fingers pinch, one pointer drags a zoomed stream around, and the bar's buttons and slider
// call zoomBy / setScale (on the middle). A view is the image viewer's (utils/imageZoom.js):
// { scale, x, y }, the picture's centre (x, y) px from the stage's, but scale 1 is the whole
// stream fitted (the video's size, `fitted`) and MAX_ZOOM the most. Unlike the viewer's, a side
// still shorter than the stage (a stream letterboxed in it) may move as long as it stays inside,
// so the point under the wheel stays put from the first step; 100% is always centred. `stageRef` is the stream's box, `size` the size arriving ({ width, height } or null).
// Gestures that start in the bar (`.stream-bar`) are left to it. Off (`enabled` false, the
// corner) it's always fitted.
const FITTED = { scale: 1, x: 0, y: 0 };

export function wheelZoomFactor(e) {
  // Trackpad pinches arrive as ctrl+wheel with small deltas; mouse wheels as big steps.
  const pixels = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
  return Math.exp(-pixels * (e.ctrlKey ? 0.01 : 0.002));
}

// Two pointers' distance and middle (relative to the stage's centre).
function pinchState(pointers, el) {
  const [a, b] = [...pointers.values()];
  const rect = el.getBoundingClientRect();
  return {
    distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    mid: { x: (a.x + b.x) / 2 - rect.left - rect.width / 2, y: (a.y + b.y) / 2 - rect.top - rect.height / 2 },
  };
}

function clampAxis(offset, size, stageSize) {
  const limit = Math.abs(size - stageSize) / 2;
  return Math.min(limit, Math.max(-limit, offset));
}

export function clampView(view, stage, picture) {
  const scale = Math.min(MAX_ZOOM, Math.max(1, view.scale));
  if (scale <= 1.001) return FITTED;
  return {
    scale,
    x: clampAxis(view.x, picture.width * scale, stage.width),
    y: clampAxis(view.y, picture.height * scale, stage.height),
  };
}

// Zooms to `scale`, keeping the point (px, py) (from the stage's centre) where it is.
export function zoomAt(view, scale, px, py, stage, picture) {
  const next = Math.min(MAX_ZOOM, Math.max(1, scale));
  const ratio = next / view.scale;
  return clampView({ scale: next, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio }, stage, picture);
}

// The video's picture inside the stage (object-fit: contain).
function fittedSize(stage, size) {
  if (!size?.width || !size?.height || !stage.width || !stage.height) return stage;
  const k = Math.min(stage.width / size.width, stage.height / size.height);
  return { width: size.width * k, height: size.height * k };
}

export function useStreamZoom(stageRef, size, enabled = true) {
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [view, setView] = useState(FITTED);
  // Buttons and the slider animate; the wheel, drags and pinches follow the hand.
  const [animate, setAnimate] = useState(false);
  const picture = useMemo(() => fittedSize(stage, size), [stage, size]);

  const live = useRef({});
  live.current = { view, stage, picture, enabled };

  const update = useCallback((next, { animated = false } = {}) => {
    const { stage: s, picture: p } = live.current;
    if (!s.width) return;
    const clamped = clampView(next, s, p);
    // Several moves can come before the next render (two fingers, a fast drag): each builds on
    // the last.
    live.current.view = clamped;
    setAnimate(animated);
    setView(clamped);
  }, []);

  // The stage's size (window resizes, the pop-out window, full screen). In the pop-out window
  // it's that window's element, so its own ResizeObserver watches it.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const measure = () => setStage({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const Observer = el.ownerDocument?.defaultView?.ResizeObserver ?? globalThis.ResizeObserver;
    if (!Observer) return undefined;
    const ro = new Observer(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [stageRef]);

  // A new stage or picture size keeps the view inside the picture.
  useLayoutEffect(() => {
    if (!stage.width) return;
    setAnimate(false);
    setView((v) => clampView(v, stage, picture));
  }, [stage, picture]);

  useEffect(() => {
    if (!enabled) setView(FITTED);
  }, [enabled]);

  const zoomBy = useCallback((factor) => {
    const { view: v, stage: s, picture: p } = live.current;
    update(zoomAt(v, v.scale * factor, 0, 0, s, p), { animated: true });
  }, [update]);

  const setScale = useCallback((scale) => {
    const { view: v, stage: s, picture: p } = live.current;
    update(zoomAt(v, scale, 0, 0, s, p));
  }, [update]);

  const reset = useCallback(() => update(FITTED, { animated: true }), [update]);

  // React's wheel listener is passive, so it can't stop the page from scrolling.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !enabled) return undefined;
    const onWheel = (e) => {
      if (e.target.closest?.('.stream-bar')) return;
      e.preventDefault();
      const { view: v, stage: s, picture: p } = live.current;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left - rect.width / 2;
      const py = e.clientY - rect.top - rect.height / 2;
      update(zoomAt(v, v.scale * wheelZoomFactor(e), px, py, s, p));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [stageRef, enabled, update]);

  // One pointer pans, two pinch (around their middle, which they also drag).
  const pointers = useRef(new Map());
  const pinch = useRef(null);

  const onPointerDown = useCallback((e) => {
    if (!live.current.enabled || e.target.closest?.('.stream-bar')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pinch.current = pointers.current.size === 2 ? pinchState(pointers.current, stageRef.current) : null;
  }, [stageRef]);

  const onPointerMove = useCallback((e) => {
    const previous = pointers.current.get(e.pointerId);
    if (!previous) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const { view: v, stage: s, picture: p } = live.current;
    if (pointers.current.size === 1) {
      if (v.scale > 1.001) update({ ...v, x: v.x + e.clientX - previous.x, y: v.y + e.clientY - previous.y });
    } else if (pointers.current.size === 2 && pinch.current) {
      const now = pinchState(pointers.current, stageRef.current);
      const was = pinch.current;
      const zoomed = zoomAt(v, v.scale * (now.distance / was.distance), was.mid.x, was.mid.y, s, p);
      update({ ...zoomed, x: zoomed.x + now.mid.x - was.mid.x, y: zoomed.y + now.mid.y - was.mid.y });
      pinch.current = now;
    }
  }, [stageRef, update]);

  const onPointerUp = useCallback((e) => {
    if (!pointers.current.delete(e.pointerId)) return;
    pinch.current = null;
  }, []);

  return {
    view,
    animate,
    zoomed: view.scale > 1.001,
    zoomBy,
    setScale,
    reset,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  };
}
