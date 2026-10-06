import { useEffect, useRef } from 'react';
import { android, ongoingNotification, refreshAndroidNotificationState, sameOngoing } from '../utils/android';
import { ensureSubscription, getPushStatus } from '../services/pushService';
import { acceptCall, getCallSnapshot, hangUp, onCallChange } from '../voice/callClient';
import { getVoiceSnapshot, leaveVoice, setSelfMute } from '../voice/voiceClient';
import { useVoice } from './useVoice';
import { useCall } from './useCall';
import { voiceTitle } from '../utils/voiceTitle';
import { showContent } from '../utils/mobilePanes';
import { t } from '../i18n';

// How long an Answer tapped on a notification waits for the call to show up here (the app may
// have just started, and finds the ringing call through GET /dm-calls/current).
const ANSWER_WAIT_MS = 15000;

// The Android app's side of the logged-in page (from Layout); does nothing elsewhere:
// - its push registration (a Firebase token, see services/pushService.js)
// - opening the chat a notification was for (`navigate`)
// - the call notification's Answer, and the ongoing-call notification's Mute and Hang up
// - keeping that ongoing-call notification up to date while in voice
export function useAndroidApp({ navigate, user, guildList, groupList }) {
  useEffect(() => {
    if (!android || !user?.id) return undefined;
    let stopped = false;
    refreshAndroidNotificationState().then(() => {
      if (stopped || getPushStatus() !== 'granted') return;
      ensureSubscription().catch((err) => console.warn('Could not register for notifications', err));
    });
    const listeners = [
      android.addListener('navigate', ({ url }) => {
        navigate(url);
        showContent(); // the chat, even if the list was showing
      }),
      android.addListener('callAction', ({ action, callId }) => {
        if (action === 'answer') answerWhenRinging(callId);
        else if (action === 'mute' || action === 'unmute') setSelfMute(action === 'mute');
        else if (action === 'hangUp') {
          if (getVoiceSnapshot().callId != null) hangUp();
          else leaveVoice();
        }
      }),
    ];
    return () => {
      stopped = true;
      for (const listener of listeners) listener.then((handle) => handle.remove());
    };
  }, [navigate, user?.id]);

  const voice = useVoice();
  const call = useCall();
  // The phone rings from the call's push (the page doesn't, see callClient.js); answered,
  // declined or ended here, it stops at once rather than when the next push arrives.
  const ringingId = call && !call.outgoing && call.state === 'ringing' ? call.id : null;
  const rang = useRef(null);
  useEffect(() => {
    if (!android) return;
    if (rang.current && rang.current !== ringingId) android.stopRinging({ callId: rang.current }).catch(() => {});
    rang.current = ringingId;
  }, [ringingId]);

  const shown = useRef(null);
  const ongoing = android && ongoingNotification(voice, {
    title: voiceTitle({ voice, call, guildList, groupList, user }),
    status: voice.status === 'connected'
      ? (voice.callId != null ? t('voice.bar.callConnected') : t('voice.bar.connected'))
      : t(voice.status === 'connecting' ? 'voice.bar.connecting' : 'voice.bar.reconnecting'),
    labels: {
      mute: t('common.mute'),
      unmute: t('common.unmute'),
      hangUp: voice.callId != null ? t('voice.bar.hangUp') : t('voice.bar.disconnect'),
    },
  });
  useEffect(() => {
    if (!android || sameOngoing(shown.current, ongoing)) return;
    shown.current = ongoing;
    const done = ongoing ? android.setOngoing(ongoing) : android.clearOngoing();
    done.catch((err) => console.warn('Could not update the call notification', err));
  });
  useEffect(() => () => {
    if (shown.current) android?.clearOngoing().catch(() => {});
    shown.current = null;
  }, []);
}

// Answers `callId` once it's ringing here (it may not have arrived yet).
function answerWhenRinging(callId) {
  const ringing = () => {
    const { call } = getCallSnapshot();
    return call?.id === callId && call.state === 'ringing' && !call.outgoing;
  };
  if (ringing()) {
    acceptCall();
    return;
  }
  const stop = onCallChange(() => {
    if (!ringing()) return;
    cleanUp();
    acceptCall();
  });
  const timer = setTimeout(() => cleanUp(), ANSWER_WAIT_MS);
  function cleanUp() {
    stop();
    clearTimeout(timer);
  }
}
