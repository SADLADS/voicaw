import React, { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Icon } from './Icon';
import { faArrowRight, faUpRightFromSquare, faXmark, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';
import { VideoControls } from './VideoControls';
import { useMediaState } from '../hooks/useMediaState';
import {
  bringBackVideo, closeFloatingVideo, getFloatingVideo, moveVideo, park, setFloatingMode, useFloatingVideo,
} from '../services/floatingVideo';
import { useCornerHolder } from '../services/cornerSlot';
import { closeVideoWindow, openVideoWindow, setVideoWindowTitle, useVideoWindow } from '../services/videoWindow';
import { claimPlayback, seekVideo, SEEK_STEP, toggleVideoMute, togglePlaying } from '../utils/videoPlayer';
import { InteractionContext } from '../contexts';
import { t } from '../i18n';
import '../assets/css/video.css';

const HIDE_CONTROLS_MS = 2500;

// The corner's size for a video of this shape: as wide as the other corner players, never
// taller than a 4:3 one.
function cornerBox(width, height, isMobile) {
  const maxWidth = isMobile ? 200 : 320;
  const maxHeight = maxWidth * 0.75;
  const ratio = width > 0 && height > 0 ? width / height : 16 / 9;
  if (ratio >= maxWidth / maxHeight) return { width: maxWidth, height: Math.round(maxWidth / ratio) };
  return { width: Math.max(Math.round(maxHeight * ratio), 120), height: maxHeight };
}

// A video from a message playing on away from it (services/floatingVideo.js): `corner` small
// in the corner, with its name, Go to message, Pop out and Close; `popout` filling its own
// window. Either way it plays the same <video> element: the corner holds it, while a window
// shows a copy of its picture (captureStream) and leaves it in the page, so nothing reloads.
function FloatingVideoView({ entry, variant }) {
  const navigate = useNavigate();
  const { isMobile } = useContext(InteractionContext);
  const { element } = entry;
  const media = useMediaState(element);
  const rootRef = useRef(null);
  const slotRef = useRef(null);
  const mirrorRef = useRef(null);
  const [active, setActive] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const hideTimer = useRef(null);
  const corner = variant === 'corner';
  const duration = media.duration ?? 0;

  // The corner holds the element itself; a window shows a copy of its picture, or, when the
  // browser won't copy it (another site's video), holds it too (it reloads there, carrying on
  // from the same point).
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return undefined;
    let stream = null;
    if (!corner) {
      try {
        stream = element.captureStream?.() ?? null;
      } catch {
        stream = null; // another site's video
      }
    }
    if (stream && mirrorRef.current) {
      mirrorRef.current.srcObject = stream;
      Promise.resolve(mirrorRef.current.play()).catch(() => {});
    } else {
      moveVideo(element, slot);
    }
    // A window closed by hand: its page goes, so the element comes back to this page first.
    const win = slot.ownerDocument.defaultView;
    const onPageHide = () => {
      if (element.parentNode === slot) park(element);
    };
    if (!corner) win?.addEventListener('pagehide', onPageHide);
    return () => {
      if (!corner) win?.removeEventListener('pagehide', onPageHide);
      for (const track of stream?.getTracks() ?? []) track.stop();
      // Still floating, just not here (moved to a window, the corner taken back): it waits in
      // the page, playing.
      if (element.parentNode === slot && getFloatingVideo()?.element === element) park(element);
    };
  }, [element, corner]);

  useEffect(() => {
    const doc = rootRef.current?.ownerDocument ?? document;
    const onChange = () => setFullscreen(doc.fullscreenElement === rootRef.current);
    doc.addEventListener('fullscreenchange', onChange);
    return () => doc.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  useEffect(() => {
    if (!popupBlocked) return undefined;
    const timer = setTimeout(() => setPopupBlocked(false), 5000);
    return () => clearTimeout(timer);
  }, [popupBlocked]);

  // Playing it here is still playing it (one video at a time).
  useEffect(() => {
    const onPlay = () => claimPlayback(element);
    element.addEventListener('play', onPlay);
    return () => element.removeEventListener('play', onPlay);
  }, [element]);

  const poke = () => {
    setActive(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setActive(false), HIDE_CONTROLS_MS);
  };

  const toggleFullscreen = () => {
    const doc = rootRef.current?.ownerDocument ?? document;
    if (doc.fullscreenElement) doc.exitFullscreen?.().catch(() => {});
    else rootRef.current?.requestFullscreen?.().catch(() => {});
  };

  const { origin } = entry;
  const goToMessage = () => {
    if (!origin?.path) return;
    navigate(origin.path, origin.messageId ? { state: { jumpToMessage: { chatId: origin.chatId, messageId: origin.messageId } } } : undefined);
  };

  const popOut = () => {
    if (!openVideoWindow()) {
      setPopupBlocked(true);
      return;
    }
    setFloatingMode('window');
  };

  const onKeyDown = (e) => {
    if (e.target.closest('input, .video-seek')) return;
    const keyName = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (keyName === ' ' || keyName === 'k') {
      if (e.target.closest('button') && keyName === ' ') return;
      togglePlaying(element);
    } else if (keyName === 'ArrowLeft') seekVideo(element, media.time - SEEK_STEP, duration);
    else if (keyName === 'ArrowRight') seekVideo(element, media.time + SEEK_STEP, duration);
    else if (keyName === 'm') toggleVideoMute(element);
    else if (keyName === 'f') toggleFullscreen();
    else return;
    e.preventDefault();
    e.stopPropagation();
    poke();
  };

  const failed = media.failed;
  const controlsShown = !failed && (media.paused || active || dragging || media.waiting);
  const size = corner ? cornerBox(entry.width ?? media.natural?.width, entry.height ?? media.natural?.height, isMobile) : null;

  return (
    <div
      ref={rootRef}
      className={`floating-video ${variant}${fullscreen ? ' fullscreen' : ''}`}
      role="region"
      aria-label={t('media.video.floatingLabel', { name: entry.name })}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {corner && !fullscreen && (
        <div className="floating-video-bar">
          <span className="floating-video-title">
            <span className="floating-video-name" title={entry.name}>{entry.name}</span>
            {origin?.chatName && <span className="floating-video-chat" title={origin.chatName}>{origin.chatName}</span>}
          </span>
          {origin?.path && (
            <button type="button" className="floating-video-button" title={t('media.video.goToMessage')} aria-label={t('media.video.goToMessage')} onClick={goToMessage}>
              <Icon icon={faArrowRight} fixedWidth />
            </button>
          )}
          {!isMobile && (
            <button type="button" className="floating-video-button" title={t('media.video.popOut')} aria-label={t('media.video.popOut')} onClick={popOut}>
              <Icon icon={faUpRightFromSquare} fixedWidth />
            </button>
          )}
          <button type="button" className="floating-video-button" title={t('media.video.close')} aria-label={t('media.video.close')} onClick={closeFloatingVideo}>
            <Icon icon={faXmark} fixedWidth />
          </button>
        </div>
      )}
      <span
        className={[
          'video-player', 'started',
          controlsShown ? 'controls-shown' : '',
          !media.paused ? 'playing' : '',
        ].filter(Boolean).join(' ')}
        style={size ?? undefined}
        onPointerMove={(e) => { if (e.pointerType === 'mouse') poke(); }}
        onPointerLeave={() => { clearTimeout(hideTimer.current); setActive(false); }}
      >
        <span ref={slotRef} className="video-slot" />
        {!corner && <video ref={mirrorRef} className="video-element floating-video-mirror" muted playsInline />}
        <span
          className="video-surface"
          onClick={() => { if (isMobile && !media.paused && !active) poke(); else togglePlaying(element); }}
          onDoubleClick={(e) => { e.preventDefault(); toggleFullscreen(); }}
        />
        {media.waiting && !failed && (
          <span className="video-loading" role="status" aria-label={t('media.video.loading')}>
            <span className="video-spinner" />
          </span>
        )}
        {failed && (
          <span className="video-error" role="alert">
            <Icon icon={faTriangleExclamation} className="video-error-icon" />
            <span>{t('media.video.loadFailed')}</span>
          </span>
        )}
        {popupBlocked && <span className="video-popup-blocked" role="alert">{t('media.video.popupBlocked')}</span>}
        {!failed && (
          <VideoControls
            element={element}
            media={media}
            duration={duration}
            onTogglePlay={() => togglePlaying(element)}
            onDragChange={setDragging}
            name={entry.name}
            fullscreen={fullscreen}
            onToggleFullscreen={toggleFullscreen}
          />
        )}
      </span>
    </div>
  );
}

// The corner's video (Layout's .corner-players), while it has the corner.
export function VideoCorner() {
  const entry = useFloatingVideo();
  const holder = useCornerHolder();
  if (!entry || entry.mode !== 'corner' || holder !== 'video') return null;
  return <FloatingVideoView key={entry.key} entry={entry} variant="corner" />;
}

// The popped-out video's window: drawn into while it's there, closed once it isn't; closing it
// by hand brings the video back (its message, or the corner).
export function VideoPopout() {
  const entry = useFloatingVideo();
  const container = useVideoWindow();
  const inWindow = entry?.mode === 'window';
  const wasOpen = useRef(false);

  useEffect(() => {
    if (container && !inWindow) closeVideoWindow();
  }, [container, inWindow]);

  useEffect(() => {
    if (container) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    if (getFloatingVideo()?.mode === 'window') bringBackVideo();
  }, [container]);

  const name = inWindow ? entry.name : null;
  useEffect(() => {
    if (container && name) setVideoWindowTitle(t('media.video.windowTitleOf', { name }));
  }, [container, name]);

  if (!container || !inWindow) return null;
  return createPortal(<FloatingVideoView key={entry.key} entry={entry} variant="popout" />, container);
}
