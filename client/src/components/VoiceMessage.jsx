import React, { useEffect, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faDownload, faPause, faPlay, faSpinner } from '@fortawesome/free-solid-svg-icons';
import { findDuration, waveformBars } from '../services/voiceMessage';
import { formatDuration } from '../utils/videoPlayer';
import { t } from '../i18n';
import '../assets/css/voiceMessages.css';

const BARS = 40;
const RATES = [1, 1.5, 2];
// The voice message playing, so starting another pauses it.
let playing = null;

// A voice message in a message (as Discord's): play/pause, its waveform (filled as it plays;
// click or drag on it to go there, ← → keys), the time, and the speed (1×, 1.5×, 2×).
// `src`: the file's URL if it's at hand (the sender's own), else `load()` resolves to one when
// Play is first pressed (an encrypted attachment is downloaded then). `duration` (seconds)
// and `waveform` (bytes) come from the attachment URL. `onDownload` saves the file.
export default function VoiceMessage({ src: givenSrc = null, load, duration: givenDuration, waveform, name, onDownload }) {
  const audioRef = useRef(null);
  const [src, setSrc] = useState(givenSrc);
  const [status, setStatus] = useState('idle'); // 'loading', 'error'
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(0);
  const [rate, setRate] = useState(1);
  const [duration, setDuration] = useState(givenDuration || 0);
  const [seekable, setSeekable] = useState(false);
  const playWhenReady = useRef(false);
  const seekTo = useRef(null);
  // While findDuration is reading to the end: its times aren't where it's playing.
  const measuring = useRef(false);
  const bars = waveformBars(waveform, BARS);

  useEffect(() => () => {
    if (playing === audioRef.current) playing = null;
  }, []);

  async function play() {
    const audio = audioRef.current;
    if (!audio) return;
    if (!src) {
      if (!load || status === 'loading') return;
      setStatus('loading');
      try {
        const url = await load();
        playWhenReady.current = true;
        setSrc(url);
        setStatus('idle');
      } catch (err) {
        console.error('Failed to load voice message', err);
        setStatus('error');
      }
      return;
    }
    audio.play().catch((err) => {
      console.error('Failed to play voice message', err);
      setStatus('error');
    });
  }

  function toggle() {
    if (audioRef.current?.paused) play();
    else audioRef.current?.pause();
  }

  // The file loaded: find its length (a recording may not say), then play if asked to.
  async function onLoadedMetadata() {
    const audio = audioRef.current;
    measuring.current = true;
    const found = await findDuration(audio);
    measuring.current = false;
    if (Number.isFinite(found) && found > 0) setDuration(found);
    setSeekable(true);
    audio.playbackRate = rate;
    if (seekTo.current != null) {
      audio.currentTime = seekTo.current;
      seekTo.current = null;
    }
    if (playWhenReady.current) {
      playWhenReady.current = false;
      play();
    }
  }

  function onPlay() {
    if (playing && playing !== audioRef.current) playing.pause();
    playing = audioRef.current;
    setPaused(false);
  }

  function onEnded() {
    setPaused(true);
    setTime(0);
    if (audioRef.current) audioRef.current.currentTime = 0;
  }

  function nextRate() {
    const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }

  // Goes to `fraction` of the way through (before it's loaded: once it is, and it plays).
  function seek(fraction) {
    const to = Math.min(Math.max(0, fraction), 1) * (duration || 0);
    setTime(to);
    const audio = audioRef.current;
    if (audio && seekable) {
      audio.currentTime = to;
    } else {
      seekTo.current = to;
      play();
    }
  }

  const dragging = useRef(false);
  const fractionAt = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
  };
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    seek(fractionAt(e));
  };
  const onPointerMove = (e) => {
    if (dragging.current && seekable) seek(fractionAt(e));
  };
  const onPointerUp = () => {
    dragging.current = false;
  };
  const onKeyDown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? 5 : -5;
    if (duration > 0) seek((time + step) / duration);
  };

  const progress = duration > 0 ? Math.min(1, time / duration) : 0;
  const shownTime = !paused || time > 0 ? time : duration;
  const loading = status === 'loading';

  return (
    // A span: markdown puts images (attachments) inside <p>.
    <span className={`voice-message${paused ? '' : ' playing'}${status === 'error' ? ' failed' : ''}`}>
      <button
        type="button"
        className="voice-message-play"
        onClick={toggle}
        disabled={loading}
        aria-label={paused ? t('media.voice.play') : t('media.voice.pause')}
        title={paused ? t('media.voice.play') : t('media.voice.pause')}
      >
        <FontAwesomeIcon icon={loading ? faSpinner : paused ? faPlay : faPause} spin={loading} fixedWidth />
      </button>
      <span
        className="voice-message-wave"
        role="slider"
        tabIndex={0}
        aria-label={t('media.voice.seek')}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(time)}
        aria-valuetext={t('media.video.timeOf', { time: formatDuration(time), duration: formatDuration(duration) })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        {bars.map((height, i) => (
          <span
            key={i}
            className={`voice-message-bar${(i + 0.5) / BARS <= progress ? ' played' : ''}`}
            style={{ height: `${Math.max(12, Math.round(height * 100))}%` }}
          />
        ))}
      </span>
      <span className="voice-message-time">
        {status === 'error' ? t('media.voice.failed') : formatDuration(shownTime)}
      </span>
      <button
        type="button"
        className="voice-message-rate"
        onClick={nextRate}
        aria-label={t('media.voice.speed', { rate })}
        title={t('media.voice.speedTitle')}
      >
        {t('media.voice.rate', { rate })}
      </button>
      {onDownload && (
        <button
          type="button"
          className="voice-message-download"
          onClick={() => onDownload()}
          aria-label={t('media.attachment.download', { name })}
          title={t('media.attachment.download', { name })}
        >
          <FontAwesomeIcon icon={faDownload} />
        </button>
      )}
      <audio
        ref={audioRef}
        src={src ?? undefined}
        preload={src ? 'metadata' : 'none'}
        onLoadedMetadata={onLoadedMetadata}
        onPlay={onPlay}
        onPause={() => setPaused(true)}
        onEnded={onEnded}
        onTimeUpdate={(e) => {
          if (!dragging.current && !measuring.current && Number.isFinite(e.currentTarget.currentTime)) setTime(e.currentTarget.currentTime);
        }}
        onError={() => {
          if (src) setStatus('error');
        }}
      />
    </span>
  );
}
