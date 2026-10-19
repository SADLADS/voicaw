import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import {
  faChevronLeft, faChevronUp, faLock, faMicrophone, faPaperPlane, faStop, faTrash,
} from '@fortawesome/free-solid-svg-icons';
import { relativeLevels, waveformBars } from '../services/voiceMessage';
import { formatDuration } from '../utils/videoPlayer';
import VoiceMessage from './VoiceMessage';
import { t } from '../i18n';

// How far a hold slides to cancel (left) or to lock (up), in pixels.
const CANCEL_PX = 110;
const LOCK_PX = 90;
// The live waveform: the last few seconds.
const LIVE_BARS = 40;
const HINT_MS = 2500;

// A phone's mic button, right of the emoji button while the box is empty (Discord's): hold to
// record, let go to send; slide left to cancel, up to lock (then it records on its own, see
// VoiceRecorderBar). A tap only says how. `voice` is useVoiceRecording's; `onDrag(dx)` follows
// the finger sideways (the bar's "Slide to cancel" moves with it).
export function MicButton({ voice, onDrag }) {
  const origin = useRef(null);
  const [dy, setDy] = useState(0);
  const [hint, setHint] = useState(false);
  const holding = voice.active && !voice.locked;

  useEffect(() => {
    if (!hint) return undefined;
    const timer = setTimeout(() => setHint(false), HINT_MS);
    return () => clearTimeout(timer);
  }, [hint]);

  const end = () => {
    origin.current = null;
    setDy(0);
    onDrag(0);
  };

  const onPointerDown = (e) => {
    if (e.button !== 0 || voice.active) return;
    e.preventDefault(); // the message box keeps (or doesn't get) the focus
    e.currentTarget.setPointerCapture?.(e.pointerId);
    origin.current = { x: e.clientX, y: e.clientY };
    setHint(false);
    voice.start();
  };
  const onPointerMove = (e) => {
    if (!origin.current) return;
    const dx = Math.min(0, e.clientX - origin.current.x);
    const up = Math.min(0, e.clientY - origin.current.y);
    if (dx < -CANCEL_PX) {
      end();
      voice.cancel();
    } else if (up < -LOCK_PX) {
      end();
      voice.lock();
    } else {
      setDy(up);
      onDrag(dx);
    }
  };
  const onPointerUp = () => {
    if (!origin.current) return;
    end();
    if (!voice.release()) setHint(true);
  };
  // The finger taken away by the phone (leaving the app does this, before the page is hidden):
  // locked, so the recording is kept (and stopped if the app was left), never sent.
  const onPointerCancel = () => {
    if (!origin.current) return;
    end();
    voice.lock();
  };

  return (
    <span className="voice-mic-wrapper">
      {holding && (
        <span className="voice-lock" style={{ transform: `translateY(${Math.round(dy / 2)}px)` }} aria-hidden="true">
          <Icon icon={faLock} />
          <Icon icon={faChevronUp} className="voice-lock-arrow" />
        </span>
      )}
      {hint && <span className="voice-hint" role="status">{t('media.voice.holdHint')}</span>}
      <button
        type="button"
        className={`voice-mic-button${holding ? ' holding' : ''}`}
        aria-label={t('media.voice.record')}
        title={t('media.voice.holdHint')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onContextMenu={(e) => e.preventDefault()}
        // A keyboard (or a screen reader's tap) records on its own instead: no hold.
        onClick={(e) => {
          if (e.detail === 0 && !voice.active) voice.start({ locked: true });
        }}
      >
        <Icon icon={faMicrophone} />
      </button>
    </span>
  );
}

// The levels so far as the live waveform's bars, newest on the right, relative to the loudest
// yet (as the sent waveform is).
function liveBars(levels) {
  const recent = relativeLevels(levels).slice(-LIVE_BARS);
  return [...new Array(LIVE_BARS - recent.length).fill(0), ...recent];
}

// What the message box shows while a voice message is recorded (in its place). Held on a
// phone: the time and "Slide to cancel" (moved `dragX`). Locked (or from a computer's + menu):
// Delete, the time and the live waveform, Stop (to listen first) and Send. Stopped: Delete,
// the recording to play, Send. On a computer Escape deletes it and Enter sends.
export default function VoiceRecorderBar({ voice, dragX = 0 }) {
  const sendRef = useRef(null);
  const { phase, locked, seconds, take, cancel } = voice;

  useEffect(() => {
    if (locked) sendRef.current?.focus({ preventScroll: true });
  }, [locked, phase]);

  useEffect(() => {
    if (!locked) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [locked, cancel]);

  const clock = (
    <span className="voice-recording-clock">
      <span className={`voice-recording-dot${phase === 'recording' ? ' live' : ''}`} aria-hidden="true" />
      <span className="voice-recording-time">{formatDuration(seconds)}</span>
    </span>
  );

  if (!locked) {
    return (
      <div className="voice-recorder holding" role="status" aria-label={t('media.voice.recording')}>
        {clock}
        <span
          className="voice-slide-cancel"
          style={{ transform: `translateX(${Math.round(dragX)}px)`, opacity: Math.max(0.2, 1 + dragX / CANCEL_PX) }}
        >
          <Icon icon={faChevronLeft} /> {t('media.voice.slideToCancel')}
        </span>
      </div>
    );
  }

  return (
    <div className="voice-recorder" aria-label={t('media.voice.recording')}>
      <button
        type="button"
        className="voice-recorder-button voice-recorder-delete"
        onClick={voice.cancel}
        aria-label={t('media.voice.delete')}
        title={t('media.voice.delete')}
      >
        <Icon icon={faTrash} />
      </button>
      {phase === 'review' && take ? (
        <VoiceMessage src={take.url} duration={take.duration} waveform={take.waveform} name={take.file.name} />
      ) : (
        <>
          {clock}
          <span className="voice-recording-wave" aria-hidden="true">
            {waveformBars(liveBars(voice.levels), LIVE_BARS, 1).map((height, i) => (
              <span key={i} className="voice-message-bar" style={{ height: `${Math.max(8, Math.round(height * 100))}%` }} />
            ))}
          </span>
          <button
            type="button"
            className="voice-recorder-button"
            onClick={voice.stop}
            disabled={phase !== 'recording'}
            aria-label={t('media.voice.stop')}
            title={t('media.voice.stop')}
          >
            <Icon icon={faStop} />
          </button>
        </>
      )}
      <button
        ref={sendRef}
        type="button"
        className="voice-recorder-button voice-recorder-send"
        onClick={voice.send}
        disabled={phase === 'starting'}
        aria-label={t('media.voice.send')}
        title={t('media.voice.send')}
      >
        <Icon icon={faPaperPlane} />
      </button>
    </div>
  );
}
