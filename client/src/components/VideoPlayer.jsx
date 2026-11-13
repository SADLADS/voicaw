import React, { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { UNSAFE_LocationContext } from 'react-router-dom';
import { Icon } from './Icon';
import { faPlay, faFilm, faRotateRight, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';
import { DownloadButton, VideoControls } from './VideoControls';
import { formatBytes } from '../utils/formatBytes';
import {
  formatDuration, readVideoPrefs, claimPlayback, startPlaying, seekVideo, toggleVideoMute, SEEK_STEP,
} from '../utils/videoPlayer';
import { mediaBoxStyle } from '../utils/mediaBox';
import { useMediaState } from '../hooks/useMediaState';
import { getPipPrefs, usePipPrefs } from '../utils/pipPrefs';
import {
  bringBackVideo, floatVideo, getFloatingVideo, moveVideo, reclaimVideo, registerVideoPlayer, useFloatingVideo,
} from '../services/floatingVideo';
import { openVideoWindow } from '../services/videoWindow';
import { pinObjectUrl, unpinObjectUrl } from '../services/attachmentCache';
import { InteractionContext } from '../contexts';
import { t } from '../i18n';
import '../assets/css/video.css';

const HIDE_CONTROLS_MS = 2500;

function createVideo(preload) {
  const el = document.createElement('video');
  el.className = 'video-element';
  el.playsInline = true;
  el.setAttribute('playsinline', '');
  el.preload = preload;
  const prefs = readVideoPrefs();
  el.volume = prefs.volume;
  el.muted = prefs.muted;
  return el;
}

// Where the player is: its chat and message (from the page around it: the chat's
// `data-chat-id` / `data-chat-name`, the row's `data-msg-id`) and the page's address in the
// app (`location`: the router's, null outside one), for the corner's Go to message.
function originOf(root, location) {
  const chat = root?.closest('[data-chat-id]');
  return {
    path: location ? `${location.pathname}${location.search}` : null,
    chatId: chat?.dataset.chatId ?? null,
    chatName: root?.closest('[data-chat-name]')?.dataset.chatName || null,
    messageId: root?.closest('[data-msg-id]')?.dataset.msgId ?? null,
  };
}

// A video in a message, Discord style: the poster (or first frame) with a play button and its
// length, and, once played, our own controls (seek bar showing what's loaded, time, volume,
// download, pop out, full screen) that fade out while it plays.
// - `src`: a URL to play from straight away (a local or already decrypted file, a plain link).
// - `load(onProgress)`: otherwise, resolves to one when Play is pressed, so nothing is
//   downloaded before that (apart from `poster`).
// - `recover(failedSrc, onProgress)`: after a playback error, another URL to try, or null.
// - `release(src)`: called once nothing plays `src` any more (a streaming URL to forget).
// - `mediaKey`: which file this is (its attachment URL), so the same message's player, shown
//   again, takes back its video from the corner.
// - `onDownload(onProgress)`: saves the file.
// The <video> element is made here rather than rendered, so it can leave: still playing when
// its message goes (another chat or page; or scrolled out of view, if Settings say so), it
// carries on in the corner (services/floatingVideo.js), or in a window of its own (Pop out).
export default function VideoPlayer({
  src: initialSrc = null, load, recover, release, mediaKey, poster, name, size, width, height,
  duration: knownDuration, onDownload,
}) {
  const key = mediaKey ?? initialSrc ?? name;
  const { isMobile } = useContext(InteractionContext);
  // The router's location (none in a test without one): read while this page is the one shown.
  const routerLocation = useRef(null);
  routerLocation.current = useContext(UNSAFE_LocationContext)?.location ?? null;
  const pip = usePipPrefs();
  const rootRef = useRef(null);
  const slotRef = useRef(null);
  const [element, setElement] = useState(() => createVideo(initialSrc ? 'metadata' : 'auto'));
  const [src, setSrc] = useState(initialSrc);
  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(null); // null, or { progress: fraction | null }
  const [error, setError] = useState(null); // null, 'load' or 'format'
  const [active, setActive] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const hideTimer = useRef(null);
  const playWhenReady = useRef(false);
  const resumeAt = useRef(0);
  const lastPointer = useRef('mouse');
  const origin = useRef(null);

  const floating = useFloatingVideo();
  const away = floating != null && floating.element === element ? floating.mode : null;
  const media = useMediaState(element);
  const duration = media.duration ?? knownDuration ?? 0;

  // The latest of everything the handing-off code needs (it runs from cleanups and observers).
  const latest = useRef({});
  latest.current = { element, src, started, release, key, name, poster, width, height, natural: media.natural };

  // An entry for services/floatingVideo.js: the playing element and what it needs.
  const entryFor = () => {
    const now = latest.current;
    const fileSrc = now.src;
    return {
      key: now.key,
      element: now.element,
      src: fileSrc,
      name: now.name,
      poster: now.poster,
      width: now.width ?? now.natural?.width,
      height: now.height ?? now.natural?.height,
      origin: origin.current ?? originOf(rootRef.current, routerLocation.current),
      release: () => {
        unpinObjectUrl(fileSrc);
        now.release?.(fileSrc);
      },
    };
  };

  // Lets the playing video go on in the corner (or a window). False: it didn't (the corner is
  // taken, by a stream or Watch Together).
  const letGo = (mode) => {
    const fileSrc = latest.current.src;
    pinObjectUrl(fileSrc);
    if (floatVideo(entryFor(), mode)) return true;
    unpinObjectUrl(fileSrc);
    return false;
  };

  const playing = () => {
    const { element: el, src: fileSrc } = latest.current;
    return Boolean(fileSrc) && !el.paused && !el.ended;
  };

  // Takes a video back (from the corner, a window): into this player, playing on.
  const adopt = useRef(null);
  adopt.current = (entry) => {
    if (!entry) return;
    unpinObjectUrl(entry.src);
    if (slotRef.current) moveVideo(entry.element, slotRef.current);
    origin.current = entry.origin;
    setElement(entry.element);
    setSrc(entry.src);
    setStarted(true);
    setError(null);
  };

  useEffect(() => registerVideoPlayer(key, (entry) => adopt.current(entry)), [key]);

  // Shown again (you came back to its chat): its video comes back from the corner.
  useLayoutEffect(() => {
    const current = getFloatingVideo();
    if (current?.key === key && current.mode === 'corner') adopt.current(reclaimVideo(key));
    // Only when it first shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Going (another chat or page) while it plays: on in the corner. Done before React takes the
  // element out of the page, in the same task, so it doesn't even pause. Otherwise it stops.
  useLayoutEffect(() => () => {
    const { element: el, src: fileSrc, release: free } = latest.current;
    if (getFloatingVideo()?.element === el) return; // already elsewhere: not ours to stop
    if (playing() && getPipPrefs().onLeave && letGo('corner')) return;
    el.pause();
    free?.(fileSrc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Out of sight while playing, though still on the page: its whole chat (a phone's chat pane
  // slid away to the list, a side chat closed) counts as leaving it; the player alone scrolled
  // away only with Settings → Picture in picture's "when I scroll" (off by default). The corner,
  // until it shows again.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !pip.onLeave || typeof IntersectionObserver === 'undefined') return undefined;
    const chat = root.closest('[data-chat-id]');
    let chatShown = true;
    let playerShown = true;
    const update = () => {
      const current = getFloatingVideo();
      const ours = current?.element === latest.current.element;
      const away = !chatShown || (pip.onScroll && !playerShown);
      if (!away) {
        if (ours && current.mode === 'corner') adopt.current(reclaimVideo(latest.current.key));
      } else if (!ours && playing()) {
        letGo('corner');
      }
    };
    const observer = new IntersectionObserver((entries) => {
      for (const seen of entries) {
        if (seen.target === root) playerShown = seen.intersectionRatio >= 0.5;
        // A pane slid off ends up touching the screen's edge, which still counts as
        // intersecting (at 0): next to nothing showing is gone.
        if (seen.target === chat) chatShown = seen.intersectionRatio >= 0.02;
      }
      update();
    }, { threshold: [0, 0.02, 0.5] });
    observer.observe(root);
    if (chat) observer.observe(chat);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pip.onLeave, pip.onScroll]);

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  useEffect(() => {
    const onChange = () => setFullscreen(!!rootRef.current && document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    if (!popupBlocked) return undefined;
    const timer = setTimeout(() => setPopupBlocked(false), 5000);
    return () => clearTimeout(timer);
  }, [popupBlocked]);

  // The element in its place, with its source, once there is one (and while it's here).
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot || !src || away) return;
    if (element.parentNode !== slot) moveVideo(element, slot);
    if (element.getAttribute('src') !== src) element.src = src;
    // A newly loaded source: start playing it (it was asked for by pressing Play).
    if (playWhenReady.current) {
      playWhenReady.current = false;
      if (resumeAt.current) element.currentTime = resumeAt.current;
      startPlaying(element);
    }
  }, [element, src, away]);

  useLayoutEffect(() => {
    if (!away) element.poster = poster ?? '';
  }, [element, poster, away]);

  // This player's own part in the element's events (while it's here, not elsewhere).
  const handlers = useRef({});
  handlers.current = {
    play: () => {
      claimPlayback(element);
      setStarted(true);
      origin.current = originOf(rootRef.current, routerLocation.current);
    },
    error: () => onVideoError(),
    loadedmetadata: () => {
      // Android's WebView gives a video without a poster its own (grey, with a play sign)
      // and keeps it up, like any poster, until the video plays or seeks: a seek to the
      // first instant shows the first frame instead.
      if (!poster && !latest.current.started && element.currentTime === 0) element.currentTime = 0.001;
    },
  };
  useLayoutEffect(() => {
    if (away) return undefined;
    const names = Object.keys(handlers.current);
    const listeners = names.map((eventName) => [eventName, (e) => handlers.current[eventName](e)]);
    for (const [eventName, listener] of listeners) element.addEventListener(eventName, listener);
    return () => {
      for (const [eventName, listener] of listeners) element.removeEventListener(eventName, listener);
    };
  }, [element, away]);

  const poke = () => {
    setActive(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setActive(false), HIDE_CONTROLS_MS);
  };

  const fetchSource = async (getter, failedSrc) => {
    setLoading({ progress: null });
    setError(null);
    try {
      const url = failedSrc ? await getter(failedSrc, (p) => setLoading({ progress: p })) : await getter((p) => setLoading({ progress: p }));
      return url;
    } finally {
      setLoading(null);
    }
  };

  // `reload`: fetch the source again (Retry after it failed to load).
  const play = async (reload = false) => {
    setStarted(true);
    poke();
    if (src && !reload) {
      startPlaying(element);
      return;
    }
    if (!load || loading) return;
    try {
      const url = await fetchSource(load);
      playWhenReady.current = true;
      setSrc(url);
    } catch (err) {
      console.error('Failed to load video', err);
      setError('load');
    }
  };

  const togglePlay = () => {
    if (error || away) return;
    if (!src) {
      play();
      return;
    }
    if (element.paused || element.ended) play();
    else element.pause();
  };

  async function onVideoError() {
    const failed = src;
    if (recover && failed) {
      resumeAt.current = element.currentTime || 0;
      try {
        const url = await fetchSource(recover, failed);
        if (url && url !== failed) {
          playWhenReady.current = started;
          setSrc(url);
          return;
        }
      } catch (err) {
        console.error('Failed to load video', err);
        setError('load');
        return;
      }
    }
    setError('format');
  }

  const toggleFullscreen = () => {
    const root = rootRef.current;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (root?.requestFullscreen) root.requestFullscreen().catch(() => {});
    // iPhones only put the video element itself full screen (with the system's controls).
    else element.webkitEnterFullscreen?.();
  };

  // Pop out (computers): the video in a window of its own, playing on.
  const popOut = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (!openVideoWindow()) {
      setPopupBlocked(true);
      return;
    }
    origin.current = origin.current ?? originOf(rootRef.current, routerLocation.current);
    letGo('window');
  };

  const bringBack = () => {
    if (away === 'corner') adopt.current(reclaimVideo(key));
    else bringBackVideo();
  };

  const onKeyDown = (e) => {
    if (away || e.target.closest('input, .video-seek')) return;
    const keyName = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (keyName === ' ' || keyName === 'k') {
      if (e.target.closest('button') && keyName === ' ') return;
      togglePlay();
    } else if (keyName === 'ArrowLeft' && src) seekVideo(element, media.time - SEEK_STEP, duration);
    else if (keyName === 'ArrowRight' && src) seekVideo(element, media.time + SEEK_STEP, duration);
    else if (keyName === 'm') toggleVideoMute(element);
    else if (keyName === 'f') toggleFullscreen();
    else return;
    e.preventDefault();
    e.stopPropagation();
    poke();
  };

  // Clicking the picture plays or pauses. On a touch screen, a tap while the controls are
  // hidden only shows them.
  const onSurfaceClick = () => {
    if (away) return;
    if (lastPointer.current === 'touch' && started && !media.paused && !active) {
      poke();
      return;
    }
    togglePlay();
  };

  const controlsShown = started && !error && !away && (media.paused || active || dragging || media.waiting);
  const box = mediaBoxStyle(width ?? media.natural?.width, height ?? media.natural?.height);
  const showPoster = !src || (!started && poster) || away;

  return (
    <span
      ref={rootRef}
      className={[
        'video-player',
        started ? 'started' : '',
        controlsShown ? 'controls-shown' : '',
        !media.paused && !away ? 'playing' : '',
        fullscreen ? 'fullscreen' : '',
        away ? 'away' : '',
      ].filter(Boolean).join(' ')}
      style={box}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => { lastPointer.current = e.pointerType; }}
      onPointerMove={(e) => { if (e.pointerType === 'mouse') poke(); }}
      onPointerLeave={() => { clearTimeout(hideTimer.current); setActive(false); }}
    >
      {/* The <video> goes in here (made in code, so it can move to the corner and back). */}
      <span ref={slotRef} className="video-slot" />
      {showPoster && (
        poster
          ? <img className="video-poster" src={poster} alt="" draggable={false} />
          : (!src || away) && <span className="video-placeholder"><Icon icon={faFilm} /></span>
      )}

      <span className="video-surface" onClick={onSurfaceClick} onDoubleClick={(e) => { if (lastPointer.current === 'mouse' && started && !away) { e.preventDefault(); toggleFullscreen(); } }} />

      {!started && !loading && !error && (
        <>
          <button type="button" className="video-big-play" onClick={() => play()} aria-label={t('media.video.playName', { name })}>
            <Icon icon={faPlay} />
          </button>
          <span className="video-badge">
            {duration > 0 && <span>{formatDuration(duration)}</span>}
            {size > 0 && <span>{formatBytes(size)}</span>}
          </span>
          {onDownload && <DownloadButton name={name} onDownload={onDownload} className="video-corner-download" />}
        </>
      )}

      {(loading || (media.waiting && !away)) && !error && (
        <span className="video-loading" role="status" aria-label={t('media.video.loading')}>
          <span className="video-spinner" />
          {loading?.progress != null && (
            <span className="video-loading-text">{t('media.percent', { percent: Math.round(loading.progress * 100) })}</span>
          )}
        </span>
      )}

      {error && !away && (
        <span className="video-error" role="alert">
          <Icon icon={faTriangleExclamation} className="video-error-icon" />
          <span>{error === 'load' ? t('media.video.loadFailed') : t('media.video.cantPlay')}</span>
          <span className="video-error-actions">
            {error === 'load' && (
              <button type="button" className="video-error-button" onClick={() => play(true)}>
                <Icon icon={faRotateRight} /> {t('media.video.retry')}
              </button>
            )}
            {onDownload && (
              <DownloadButton name={name} onDownload={onDownload} className="video-error-button" />
            )}
          </span>
        </span>
      )}

      {away && (
        <span className="video-away" role="status">
          <span>{away === 'window' ? t('media.video.inWindow') : t('media.video.inCorner')}</span>
          <button type="button" className="video-error-button" onClick={bringBack}>{t('media.video.bringBack')}</button>
        </span>
      )}

      {popupBlocked && <span className="video-popup-blocked" role="alert">{t('media.video.popupBlocked')}</span>}

      {started && !error && !away && (
        <VideoControls
          element={element}
          media={media}
          duration={duration}
          onTogglePlay={togglePlay}
          onDragChange={setDragging}
          name={name}
          onDownload={onDownload}
          onPopOut={isMobile || !src ? undefined : popOut}
          fullscreen={fullscreen}
          onToggleFullscreen={toggleFullscreen}
        />
      )}
    </span>
  );
}
