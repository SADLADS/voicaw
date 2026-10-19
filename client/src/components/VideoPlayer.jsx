import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import {
  faPlay, faPause, faVolumeHigh, faVolumeLow, faVolumeXmark, faExpand, faCompress, faDownload,
  faFilm, faRotateRight, faTriangleExclamation,
} from '@fortawesome/free-solid-svg-icons';
import { formatBytes } from '../utils/formatBytes';
import {
  formatDuration, bufferedSpans, readVideoPrefs, saveVideoPrefs, claimPlayback,
} from '../utils/videoPlayer';
import { mediaBoxStyle } from '../utils/mediaBox';
import { t } from '../i18n';
import '../assets/css/video.css';

const HIDE_CONTROLS_MS = 2500;
const SEEK_STEP = 5;
// While dragging the seek bar, how often the video itself jumps along.
const DRAG_SEEK_MS = 200;

// Playing can be refused (a browser that wants a fresh tap): the play button stays.
function startPlaying(el) {
  if (!el) return;
  claimPlayback(el);
  Promise.resolve(el.play()).catch(() => {});
}

// The seek bar: buffered parts, played part, a handle; a time over where the pointer is.
function SeekBar({ time, duration, spans, onSeek, onDragChange }) {
  const [hover, setHover] = useState(null); // { x, time }
  const [dragTime, setDragTime] = useState(null);
  const lastSeek = useRef(0);

  const timeAt = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    return { x: fraction * rect.width, time: fraction * duration };
  };

  const onPointerDown = (e) => {
    if (!(duration > 0) || e.button > 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const at = timeAt(e);
    setDragTime(at.time);
    onDragChange(true);
    onSeek(at.time);
    lastSeek.current = Date.now();
  };
  const onPointerMove = (e) => {
    if (!(duration > 0)) return;
    const at = timeAt(e);
    if (e.pointerType === 'mouse') setHover(at);
    if (dragTime === null) return;
    setDragTime(at.time);
    if (Date.now() - lastSeek.current > DRAG_SEEK_MS) {
      onSeek(at.time);
      lastSeek.current = Date.now();
    }
  };
  const endDrag = (e) => {
    if (dragTime === null) return;
    onSeek(timeAt(e).time);
    setDragTime(null);
    onDragChange(false);
  };
  const onKeyDown = (e) => {
    const step = { ArrowLeft: -SEEK_STEP, ArrowRight: SEEK_STEP, ArrowDown: -SEEK_STEP, ArrowUp: SEEK_STEP }[e.key];
    if (e.key === 'Home') onSeek(0);
    else if (e.key === 'End') onSeek(duration);
    else if (step) onSeek(Math.min(duration, Math.max(0, time + step)));
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const shown = dragTime ?? time;
  const played = duration > 0 ? Math.min(100, (shown / duration) * 100) : 0;
  return (
    <span
      className={`video-seek${dragTime !== null ? ' dragging' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label={t('media.video.seek')}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration || 0)}
      aria-valuenow={Math.round(shown)}
      aria-valuetext={t('media.video.timeOf', { time: formatDuration(shown), duration: formatDuration(duration) })}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKeyDown}
    >
      <span className="video-seek-track">
        {spans.map(([start, end]) => (
          <span key={start} className="video-seek-buffered" style={{ left: `${start * 100}%`, width: `${(end - start) * 100}%` }} />
        ))}
        <span className="video-seek-played" style={{ width: `${played}%` }} />
        <span className="video-seek-thumb" style={{ left: `${played}%` }} />
      </span>
      {hover && (
        <span className="video-seek-tooltip" style={{ left: `${hover.x}px` }}>{formatDuration(hover.time)}</span>
      )}
    </span>
  );
}

function DownloadButton({ name, onDownload, className = '' }) {
  const [progress, setProgress] = useState(null);
  const [failed, setFailed] = useState(false);
  const download = async (e) => {
    e.stopPropagation();
    if (progress !== null) return;
    setFailed(false);
    setProgress(0);
    try {
      await onDownload((fraction) => setProgress(fraction));
    } catch (err) {
      console.error('Video download failed', err);
      setFailed(true);
    } finally {
      setProgress(null);
    }
  };
  const busy = progress !== null;
  return (
    <button
      type="button"
      className={`video-button video-download ${className}`}
      onClick={download}
      title={failed
        ? t('media.video.downloadFailedRetry')
        : busy ? t('media.video.downloadingTitle') : t('media.video.download', { name })}
      aria-label={busy ? t('media.video.downloading', { name }) : t('media.video.download', { name })}
      aria-busy={busy}
    >
      {busy ? (
        <span className="video-download-progress" style={{ '--progress': `${Math.round(progress * 100)}%` }} />
      ) : (
        <Icon icon={failed ? faTriangleExclamation : faDownload} />
      )}
    </button>
  );
}

// A video in a message, Discord style: the poster (or first frame) with a play button and its
// length, and, once played, our own controls (seek bar showing what's loaded, time, volume,
// download, full screen) that fade out while it plays.
// - `src`: a URL to play from straight away (a local or already decrypted file, a plain link).
// - `load(onProgress)`: otherwise, resolves to one when Play is pressed, so nothing is
//   downloaded before that (apart from `poster`).
// - `recover(failedSrc, onProgress)`: after a playback error, another URL to try, or null.
// - `onDownload(onProgress)`: saves the file.
export default function VideoPlayer({
  src: initialSrc = null, load, recover, poster, name, size, width, height, duration: knownDuration, onDownload,
}) {
  const rootRef = useRef(null);
  const videoRef = useRef(null);
  const [src, setSrc] = useState(initialSrc);
  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(null); // null, or { progress: fraction | null }
  const [error, setError] = useState(null); // null, 'load' or 'format'
  const [paused, setPaused] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [time, setTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(null);
  const [natural, setNatural] = useState(null);
  const [spans, setSpans] = useState([]);
  const [prefs, setPrefs] = useState(readVideoPrefs);
  const [active, setActive] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const hideTimer = useRef(null);
  const playWhenReady = useRef(false);
  const resumeAt = useRef(0);
  const lastPointer = useRef('mouse');

  const duration = mediaDuration ?? knownDuration ?? 0;
  const video = () => videoRef.current;

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  useEffect(() => {
    const onChange = () => setFullscreen(!!rootRef.current && document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // A newly loaded source: start playing it (it was asked for by pressing Play).
  useEffect(() => {
    const el = video();
    if (!el || !src) return;
    el.volume = prefs.volume;
    el.muted = prefs.muted;
    if (playWhenReady.current) {
      playWhenReady.current = false;
      if (resumeAt.current) el.currentTime = resumeAt.current;
      startPlaying(el);
    }
    // Only when the source changes; volume changes go straight to the element.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

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
      startPlaying(video());
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
    if (error) return;
    if (!src) {
      play();
      return;
    }
    if (video().paused) play();
    else video().pause();
  };

  const onVideoError = async () => {
    const failed = src;
    setWaiting(false);
    if (recover && failed) {
      resumeAt.current = video()?.currentTime || 0;
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
  };

  const seek = (to) => {
    const el = video();
    if (!el) return;
    el.currentTime = Math.min(Math.max(0, to), duration || el.duration || 0);
    setTime(el.currentTime);
  };

  const setVolume = (volume) => {
    const next = { volume, muted: volume === 0 };
    setPrefs(next);
    saveVideoPrefs(next);
    if (video()) {
      video().volume = volume;
      video().muted = next.muted;
    }
  };
  const toggleMute = () => {
    const next = { volume: prefs.volume || 1, muted: !prefs.muted };
    setPrefs(next);
    saveVideoPrefs(next);
    if (video()) {
      video().volume = next.volume;
      video().muted = next.muted;
    }
  };

  const toggleFullscreen = () => {
    const root = rootRef.current;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (root?.requestFullscreen) root.requestFullscreen().catch(() => {});
    // iPhones only put the video element itself full screen (with the system's controls).
    else video()?.webkitEnterFullscreen?.();
  };

  const onKeyDown = (e) => {
    if (e.target.closest('input, .video-seek')) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === ' ' || key === 'k') {
      if (e.target.closest('button') && key === ' ') return;
      togglePlay();
    } else if (key === 'ArrowLeft' && src) seek(time - SEEK_STEP);
    else if (key === 'ArrowRight' && src) seek(time + SEEK_STEP);
    else if (key === 'm') toggleMute();
    else if (key === 'f') toggleFullscreen();
    else return;
    e.preventDefault();
    e.stopPropagation();
    poke();
  };

  // Clicking the picture plays or pauses. On a touch screen, a tap while the controls are
  // hidden only shows them.
  const onSurfaceClick = () => {
    if (lastPointer.current === 'touch' && started && !paused && !active) {
      poke();
      return;
    }
    togglePlay();
  };

  const controlsShown = started && !error && (paused || active || dragging || waiting);
  const volumeIcon = prefs.muted || prefs.volume === 0 ? faVolumeXmark : prefs.volume < 0.5 ? faVolumeLow : faVolumeHigh;
  const box = mediaBoxStyle(width ?? natural?.width, height ?? natural?.height);
  const showPoster = !src || (!started && poster);

  return (
    <span
      ref={rootRef}
      className={[
        'video-player',
        started ? 'started' : '',
        controlsShown ? 'controls-shown' : '',
        !paused ? 'playing' : '',
        fullscreen ? 'fullscreen' : '',
      ].filter(Boolean).join(' ')}
      style={box}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => { lastPointer.current = e.pointerType; }}
      onPointerMove={(e) => { if (e.pointerType === 'mouse') poke(); }}
      onPointerLeave={() => { clearTimeout(hideTimer.current); setActive(false); }}
    >
      {src && (
        <video
          ref={videoRef}
          className="video-element"
          src={src}
          poster={poster ?? undefined}
          preload={initialSrc ? 'metadata' : 'auto'}
          playsInline
          onPlay={(e) => { claimPlayback(e.currentTarget); setPaused(false); setStarted(true); }}
          onPause={() => setPaused(true)}
          onEnded={() => setPaused(true)}
          onWaiting={() => setWaiting(true)}
          onPlaying={() => setWaiting(false)}
          onCanPlay={() => setWaiting(false)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onSeeked={(e) => setTime(e.currentTarget.currentTime)}
          onProgress={(e) => setSpans(bufferedSpans(e.currentTarget.buffered, e.currentTarget.duration))}
          onLoadedMetadata={(e) => {
            const el = e.currentTarget;
            if (Number.isFinite(el.duration)) setMediaDuration(el.duration);
            if (el.videoWidth && el.videoHeight) setNatural({ width: el.videoWidth, height: el.videoHeight });
            // Android's WebView gives a video without a poster its own (grey, with a play sign)
            // and keeps it up, like any poster, until the video plays or seeks: a seek to the
            // first instant shows the first frame instead.
            if (!poster && !started && el.currentTime === 0) el.currentTime = 0.001;
          }}
          onDurationChange={(e) => { if (Number.isFinite(e.currentTarget.duration)) setMediaDuration(e.currentTarget.duration); }}
          onError={onVideoError}
        />
      )}
      {showPoster && (
        poster
          ? <img className="video-poster" src={poster} alt="" draggable={false} />
          : !src && <span className="video-placeholder"><Icon icon={faFilm} /></span>
      )}

      <span className="video-surface" onClick={onSurfaceClick} onDoubleClick={(e) => { if (lastPointer.current === 'mouse' && started) { e.preventDefault(); toggleFullscreen(); } }} />

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

      {(loading || (waiting && !paused)) && !error && (
        <span className="video-loading" role="status" aria-label={t('media.video.loading')}>
          <span className="video-spinner" />
          {loading?.progress != null && (
            <span className="video-loading-text">{t('media.percent', { percent: Math.round(loading.progress * 100) })}</span>
          )}
        </span>
      )}

      {error && (
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

      {started && !error && (
        <span className="video-controls" onClick={(e) => e.stopPropagation()}>
          <SeekBar time={time} duration={duration} spans={spans} onSeek={seek} onDragChange={setDragging} />
          <span className="video-controls-row">
            <button
              type="button"
              className="video-button"
              onClick={togglePlay}
              aria-label={paused ? t('media.video.play') : t('media.video.pause')}
              title={paused ? t('media.video.playTitle') : t('media.video.pauseTitle')}
            >
              <Icon icon={paused ? faPlay : faPause} />
            </button>
            <span className="video-volume">
              <button
                type="button"
                className="video-button"
                onClick={toggleMute}
                aria-label={prefs.muted ? t('common.unmute') : t('common.mute')}
                title={prefs.muted ? t('media.video.unmuteTitle') : t('media.video.muteTitle')}
              >
                <Icon icon={volumeIcon} />
              </button>
              <input
                type="range"
                className="video-volume-slider"
                min={0}
                max={1}
                step={0.05}
                value={prefs.muted ? 0 : prefs.volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                aria-label={t('media.video.volume')}
                style={{ '--volume': `${(prefs.muted ? 0 : prefs.volume) * 100}%` }}
              />
            </span>
            <span className="video-time">
              {formatDuration(time)}<span className="video-time-total"> / {formatDuration(duration)}</span>
            </span>
            <span className="video-controls-spacer" />
            {onDownload && <DownloadButton name={name} onDownload={onDownload} />}
            <button
              type="button"
              className="video-button"
              onClick={toggleFullscreen}
              aria-label={fullscreen ? t('media.video.exitFullScreen') : t('media.video.fullScreen')}
              title={fullscreen ? t('media.video.exitFullScreenTitle') : t('media.video.fullScreenTitle')}
            >
              <Icon icon={fullscreen ? faCompress : faExpand} />
            </button>
          </span>
        </span>
      )}
    </span>
  );
}
