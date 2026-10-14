import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_VOICE_SECONDS, MIN_VOICE_SECONDS, startVoiceRecorder } from '../services/voiceMessage';
import { t } from '../i18n';

const IDLE = { phase: 'idle', locked: false, seconds: 0, levels: [], take: null };

// A voice message being recorded in the message box (services/voiceMessage.js). `phase`:
// 'idle'; 'starting' (asking for the microphone); 'recording'; 'review' (stopped, `take` =
// { file, duration, waveform, url } to play back before sending). `locked`: recording on its
// own (a phone's hold slid up to the lock, or started from a computer's + menu), so letting
// go doesn't send. `levels`: the loudness so far (RMS, for the live waveform), `seconds`: how
// long.
//
// `onSend(take)` sends a take (it keeps `take.url`, the pending message shows it); `onError`
// says what went wrong. `resetKey` changing (another conversation) throws away what's going.
// `stopWhenHidden` (phones): leaving the app or locking the screen stops the recording, to be
// listened to, sent or deleted on coming back. A phone takes the microphone from a page out
// of sight, so the rest would have been silence (computers' browsers keep recording).
export function useVoiceRecording({ onSend, onError, resetKey, stopWhenHidden = false }) {
  const [state, setState] = useState(IDLE);
  const recorder = useRef(null);
  // Each start gets a number, so a start still waiting for the microphone can tell it was
  // cancelled meanwhile.
  const attempt = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;

  const reset = useCallback(() => {
    attempt.current++;
    recorder.current?.cancel();
    recorder.current = null;
    const take = stateRef.current.take;
    if (take?.url) URL.revokeObjectURL(take.url);
    setState(IDLE);
  }, []);

  // Stopped: the take, to listen to before sending.
  const stop = useCallback(async () => {
    const active = recorder.current;
    if (!active) return null;
    recorder.current = null;
    const mine = attempt.current;
    const take = await active.stop();
    if (attempt.current !== mine) return null; // cancelled meanwhile
    const withUrl = { ...take, url: URL.createObjectURL(take.file) };
    setState((s) => ({ ...s, phase: 'review', locked: true, seconds: take.duration, take: withUrl }));
    return withUrl;
  }, []);

  const start = useCallback(async ({ locked = false } = {}) => {
    if (stateRef.current.phase !== 'idle') return;
    const mine = ++attempt.current;
    setState({ ...IDLE, phase: 'starting', locked });
    try {
      const started = await startVoiceRecorder({
        onLevel: (levels, seconds) => {
          if (attempt.current !== mine) return;
          setState((s) => ({ ...s, levels: [...levels], seconds }));
          // The longest there is: stopped, to be sent (or not).
          if (seconds >= MAX_VOICE_SECONDS) stop();
        },
      });
      if (attempt.current !== mine) {
        started.cancel();
        return;
      }
      recorder.current = started;
      setState((s) => ({ ...s, phase: 'recording' }));
    } catch (err) {
      if (attempt.current !== mine) return;
      console.error('Could not record a voice message', err);
      setState(IDLE);
      onError?.(err?.name === 'NotAllowedError' ? t('media.voice.micBlocked') : t('media.voice.micFailed'));
    }
  }, [onError, stop]);

  const lock = useCallback(() => {
    setState((s) => (s.phase === 'starting' || s.phase === 'recording' ? { ...s, locked: true } : s));
  }, []);

  // Sends what's recorded (stopping first if it's still going).
  const send = useCallback(async () => {
    const { phase, take } = stateRef.current;
    let toSend = take;
    if (phase === 'recording') toSend = await stop();
    if (!toSend) return;
    attempt.current++;
    setState(IDLE);
    onSendRef.current?.(toSend);
  }, [stop]);

  // A phone's hold let go (not locked): sent, unless it was too short to be anything (or the
  // microphone wasn't there yet). Returns whether it was sent.
  const release = useCallback(() => {
    const { phase, locked, seconds } = stateRef.current;
    if (locked) return true;
    if (phase !== 'recording' || seconds < MIN_VOICE_SECONDS) {
      reset();
      return false;
    }
    send();
    return true;
  }, [reset, send]);

  // Another conversation, or the box going away: nothing goes anywhere.
  useEffect(() => reset, [resetKey, reset]);

  useEffect(() => {
    if (!stopWhenHidden) return undefined;
    const onHidden = () => {
      if (!document.hidden) return;
      const { phase, seconds } = stateRef.current;
      if (phase === 'starting' || (phase === 'recording' && seconds < MIN_VOICE_SECONDS)) reset();
      else if (phase === 'recording') stop();
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => document.removeEventListener('visibilitychange', onHidden);
  }, [stopWhenHidden, reset, stop]);

  return { ...state, active: state.phase !== 'idle', start, stop, lock, send, release, cancel: reset };
}
