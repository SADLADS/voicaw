import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { faMinus, faPlus } from '@fortawesome/free-solid-svg-icons';
import Modal from './guild/Modal';
import { MAX_ZOOM, clampView, cropOf, initialView, layout, panView, zoomView } from '../utils/imageCrop';
import { t } from '../i18n';

// Before a profile picture, a bot's or webhook's picture, a guild icon or a group DM's picture is
// uploaded: the picked `file` in a round frame, to drag into place and zoom (slider, wheel, pinch,
// or arrows and +/- on the frame). Apply calls onApply with the crop (utils/imageCrop.js cropOf),
// which the server cuts out (avatarImage.js), so animated pictures stay animated; a group DM's
// picture is encrypted, so it's cut on the device instead (pictureData.js croppedPictureBytes).
// `aspect` (width / height, e.g. 2.5 for a profile banner) gives a rectangular frame instead; the
// maths (utils/imageCrop.js) is for a square frame, so the picture is measured as if `aspect`
// times narrower, which keeps the crop's fractions right.
export default function ImageCropper({ file, onApply, onCancel, aspect = 1 }) {
  const [url, setUrl] = useState(null);
  const [size, setSize] = useState(null); // the picture's { width, height } once loaded
  const [view, setView] = useState(null);
  const [failed, setFailed] = useState(false);
  const frame = useRef(null);
  const pointers = useRef(new Map()); // pointer id -> its last { x, y } in px
  const sizeRef = useRef(null);

  // Changes the view from the latest one: several pointer or wheel events can arrive before
  // the next render (a pinch moves both fingers at once), and each builds on the one before.
  const update = (change) => setView((v) => (v && sizeRef.current ? change(v, sizeRef.current.width, sizeRef.current.height) : v));

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  // Escape closes only this, not what it opened over (Guild Settings, Settings): caught first.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  useEffect(() => { frame.current?.focus(); }, []);

  // The wheel listener can't be passive (it stops the page scrolling), so not React's.
  useEffect(() => {
    const el = frame.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (!sizeRef.current) return;
      e.preventDefault();
      const [px, py] = framePoint(e.clientX, e.clientY);
      const factor = Math.exp(-e.deltaY * 0.002);
      update((v, w, h) => zoomView(v, w, h, v.zoom * factor, px, py));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [url]);

  function loaded(e) {
    const { naturalWidth: width, naturalHeight: height } = e.currentTarget;
    if (!width || !height) return setFailed(true);
    sizeRef.current = { width: width / aspect, height };
    setSize(sizeRef.current);
    setView(initialView(width / aspect, height));
  }

  // A point on screen in frame widths from the frame's top-left.
  function framePoint(clientX, clientY) {
    const box = frame.current.getBoundingClientRect();
    return [(clientX - box.left) / box.width, (clientY - box.top) / box.height];
  }

  function pointerDown(e) {
    if (!view) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  function pointerMove(e) {
    const before = pointers.current.get(e.pointerId);
    if (!before || !view) return;
    const box = frame.current.getBoundingClientRect();
    if (pointers.current.size === 1) {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [dx, dy] = [(e.clientX - before.x) / box.width, (e.clientY - before.y) / box.height];
      update((v, w, h) => panView(v, w, h, dx, dy));
      return;
    }
    // Pinch: the two fingers' gap sets the zoom, their midpoint moves the picture.
    const [a, b] = [...pointers.current.values()];
    const midBefore = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const gapBefore = Math.hypot(a.x - b.x, a.y - b.y);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [c, d] = [...pointers.current.values()];
    const midAfter = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 };
    const gapAfter = Math.hypot(c.x - d.x, c.y - d.y);
    const [px, py] = framePoint(midAfter.x, midAfter.y);
    const [dx, dy] = [(midAfter.x - midBefore.x) / box.width, (midAfter.y - midBefore.y) / box.height];
    const factor = gapBefore > 0 ? gapAfter / gapBefore : 1;
    update((v, w, h) => {
      const moved = panView(v, w, h, dx, dy);
      return zoomView(moved, w, h, moved.zoom * factor, px, py);
    });
  }

  function pointerUp(e) {
    pointers.current.delete(e.pointerId);
  }

  function keyDown(e) {
    if (!view) return;
    const step = e.shiftKey ? 0.1 : 0.02;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      e.preventDefault();
      update((v, w, h) => panView(v, w, h, ...moves[e.key]));
    } else if (e.key === '+' || e.key === '=' || e.key === '-') {
      e.preventDefault();
      const factor = e.key === '-' ? 1 / 1.1 : 1.1;
      update((v, w, h) => zoomView(v, w, h, v.zoom * factor));
    }
  }

  const zoomTo = (zoom) => update((v, w, h) => zoomView(v, w, h, zoom));
  const place = view && layout(clampView(view, size.width, size.height), size.width, size.height);
  const percent = (n) => `${n * 100}%`;

  return (
    <Modal
      title={t('media.cropper.title')}
      onClose={onCancel}
      className={`image-cropper${aspect !== 1 ? ' image-cropper-wide' : ''}`}
      actions={(
        <>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={!view} onClick={() => onApply(cropOf(view, size.width, size.height))}>
            {t('media.cropper.apply')}
          </button>
        </>
      )}
    >
      {failed ? (
        <p className="error-msg" role="alert">{t('media.cropper.loadFailed')}</p>
      ) : (
        <>
          <div
            ref={frame}
            className="image-cropper-frame"
            style={aspect !== 1 ? { aspectRatio: aspect } : undefined}
            tabIndex={0}
            role="group"
            aria-label={t('media.cropper.frame')}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={pointerUp}
            onKeyDown={keyDown}
          >
            {url && (
              <img
                src={url}
                alt=""
                draggable={false}
                onLoad={loaded}
                onError={() => setFailed(true)}
                style={place
                  ? { left: percent(place.left), top: percent(place.top), width: percent(place.width), height: percent(place.height) }
                  : { visibility: 'hidden' }}
              />
            )}
            <div className="image-cropper-mask" />
          </div>
          <div className="image-cropper-zoom">
            <button type="button" className="image-cropper-zoom-step" aria-label={t('media.cropper.zoomOut')} disabled={!view} onClick={() => update((v, w, h) => zoomView(v, w, h, v.zoom / 1.25))}><Icon icon={faMinus} /></button>
            <input
              type="range" min="1" max={MAX_ZOOM} step="0.01"
              aria-label={t('media.cropper.zoom')}
              disabled={!view}
              value={view?.zoom ?? 1}
              onChange={(e) => zoomTo(Number(e.target.value))}
            />
            <button type="button" className="image-cropper-zoom-step" aria-label={t('media.cropper.zoomIn')} disabled={!view} onClick={() => update((v, w, h) => zoomView(v, w, h, v.zoom * 1.25))}><Icon icon={faPlus} /></button>
          </div>
          <p className="vc-hint image-cropper-hint">{t('media.cropper.hint')}</p>
        </>
      )}
    </Modal>
  );
}
