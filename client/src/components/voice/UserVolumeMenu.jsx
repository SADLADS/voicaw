import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import '../../assets/css/guilds.css';
import '../../assets/css/voice.css';
import { DEFAULT_USER_VOLUME, MAX_USER_VOLUME, setUserVolume, useUserVolume } from '../../voice/userVolumes';
import { placeMenu } from '../../utils/menuPlacement';

// How loud one person is on this device (Discord's User Volume), 0–200%: a slider floating by
// `anchor` (a rect) on a computer, a sheet from the bottom on a phone (`sheet`). Changes apply
// at once. Escape, or a click outside, closes it.
export default function UserVolumeMenu({ userId, name, anchor, sheet = false, onClose }) {
  const volume = useUserVolume(userId);
  const percent = Math.round(volume * 100);
  const sliderId = useId();
  const rootRef = useRef(null);
  const sliderRef = useRef(null);
  const [position, setPosition] = useState({ left: anchor?.left ?? 0, top: anchor?.bottom ?? 0, visibility: 'hidden' });

  useLayoutEffect(() => {
    if (sheet || !anchor) return;
    setPosition(placeMenu(anchor, rootRef.current.getBoundingClientRect(), false));
  }, [anchor, sheet]);

  // On a computer the slider takes the focus, so arrow keys change it straight away.
  const placed = position.visibility !== 'hidden';
  useEffect(() => {
    if (!sheet && placed) sliderRef.current?.focus({ preventScroll: true });
  }, [sheet, placed]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    if (sheet) return () => window.removeEventListener('keydown', onKey);
    const onDown = (e) => { if (!rootRef.current?.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [sheet, onClose]);

  const body = (
    <>
      <div className="user-volume-head">
        <label htmlFor={sliderId}>User Volume</label>
        <span className="user-volume-value">{percent}%</span>
      </div>
      <input
        ref={sliderRef}
        id={sliderId}
        className="user-volume-slider"
        type="range"
        min={0}
        max={MAX_USER_VOLUME * 100}
        step={1}
        value={percent}
        aria-valuetext={`${percent}%`}
        onChange={(e) => setUserVolume(userId, Number(e.target.value) / 100)}
      />
      <button
        type="button"
        className="user-volume-reset"
        disabled={volume === DEFAULT_USER_VOLUME}
        onClick={() => setUserVolume(userId, DEFAULT_USER_VOLUME)}
      >
        Reset to 100%
      </button>
    </>
  );

  if (sheet) {
    return createPortal(
      <div className="action-sheet-backdrop" onClick={onClose} onContextMenu={(e) => e.preventDefault()}>
        <div
          className="action-sheet context-sheet user-volume-sheet"
          role="dialog"
          aria-label={`${name}: volume`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-sheet-title"><span>{name}</span></div>
          {body}
        </div>
      </div>,
      document.body
    );
  }

  return createPortal(
    <div
      ref={rootRef}
      className="guild-menu context-menu user-volume-menu"
      style={position}
      role="dialog"
      aria-label={`${name}: volume`}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="user-volume-name">{name}</div>
      {body}
    </div>,
    document.body
  );
}
