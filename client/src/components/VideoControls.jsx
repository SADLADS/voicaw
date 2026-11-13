import React, { useRef, useState } from 'react';
import { Icon } from './Icon';
import {
  faPlay, faPause, faVolumeHigh, faVolumeLow, faVolumeXmark, faExpand, faCompress, faDownload,
  faTriangleExclamation, faUpRightFromSquare,
} from '@fortawesome/free-solid-svg-icons';
import {
  formatDuration, SEEK_STEP, seekVideo, setVideoVolume, toggleVideoMute,
} from '../utils/videoPlayer';
import { t } from '../i18n';

// While dragging the seek bar, how often the video itself jumps along.
const DRAG_SEEK_MS = 200;

// The seek bar: buffered parts, played part, a handle; a time over where the pointer is.
export function SeekBar({ time, duration, spans, onSeek, onDragChange }) {
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

export function DownloadButton({ name, onDownload, className = '' }) {
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

// The controls under a playing video (the message's player, the corner's, a window's), all on
// one <video> element: seek bar, play/pause, volume (kept per device, utils/videoPlayer.js),
// time, then download, pop out and full screen when given.
export function VideoControls({
  element, media, duration, onTogglePlay, onDragChange, name, onDownload, onPopOut, fullscreen, onToggleFullscreen,
}) {
  const seek = (to) => seekVideo(element, to, duration);
  const volumeIcon = media.muted || media.volume === 0 ? faVolumeXmark : media.volume < 0.5 ? faVolumeLow : faVolumeHigh;
  return (
    <span className="video-controls" onClick={(e) => e.stopPropagation()}>
      <SeekBar time={media.time} duration={duration} spans={media.spans} onSeek={seek} onDragChange={onDragChange} />
      <span className="video-controls-row">
        <button
          type="button"
          className="video-button"
          onClick={onTogglePlay}
          aria-label={media.paused ? t('media.video.play') : t('media.video.pause')}
          title={media.paused ? t('media.video.playTitle') : t('media.video.pauseTitle')}
        >
          <Icon icon={media.paused ? faPlay : faPause} />
        </button>
        <span className="video-volume">
          <button
            type="button"
            className="video-button"
            onClick={() => toggleVideoMute(element)}
            aria-label={media.muted ? t('common.unmute') : t('common.mute')}
            title={media.muted ? t('media.video.unmuteTitle') : t('media.video.muteTitle')}
          >
            <Icon icon={volumeIcon} />
          </button>
          <input
            type="range"
            className="video-volume-slider"
            min={0}
            max={1}
            step={0.05}
            value={media.muted ? 0 : media.volume}
            onChange={(e) => setVideoVolume(element, Number(e.target.value))}
            aria-label={t('media.video.volume')}
            style={{ '--volume': `${(media.muted ? 0 : media.volume) * 100}%` }}
          />
        </span>
        <span className="video-time">
          {formatDuration(media.time)}<span className="video-time-total"> / {formatDuration(duration)}</span>
        </span>
        <span className="video-controls-spacer" />
        {onDownload && <DownloadButton name={name} onDownload={onDownload} />}
        {onPopOut && (
          <button
            type="button"
            className="video-button video-pop-out"
            onClick={onPopOut}
            aria-label={t('media.video.popOut')}
            title={t('media.video.popOut')}
          >
            <Icon icon={faUpRightFromSquare} />
          </button>
        )}
        {onToggleFullscreen && (
          <button
            type="button"
            className="video-button"
            onClick={onToggleFullscreen}
            aria-label={fullscreen ? t('media.video.exitFullScreen') : t('media.video.fullScreen')}
            title={fullscreen ? t('media.video.exitFullScreenTitle') : t('media.video.fullScreenTitle')}
          >
            <Icon icon={fullscreen ? faCompress : faExpand} />
          </button>
        )}
      </span>
    </span>
  );
}
