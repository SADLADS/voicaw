import React, { useContext, useEffect, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faLock, faPhoneSlash } from '@fortawesome/free-solid-svg-icons';
import '../../assets/css/voice.css';
import { useCall } from '../../hooks/useCall';
import { useVoice } from '../../hooks/useVoice';
import { useVolumeMenu } from '../../hooks/useVolumeMenu';
import { InteractionContext } from '../../contexts';
import { hangUp } from '../../voice/callClient';
import UserAvatar from '../voice/UserAvatar';
import VoiceControls from '../voice/VoiceControls';
import UserVolumeMenu from '../voice/UserVolumeMenu';
import { MicIcon } from '../voice/VoiceIcons';
import { nameOf } from '../../utils/profiles';

function useDuration(since) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  if (!since) return null;
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(seconds / 3600);
  const mm = String(Math.floor((seconds % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// At the top of a DM while you're calling that person: both of you (ringed while talking,
// the mic icon when muted), the state or how long it's been going, and the controls. Clicking
// the other person once you're in sets how loud they are for you.
export default function CallPanel({ user, peer }) {
  const call = useCall();
  const voice = useVoice();
  const { isMobile } = useContext(InteractionContext);
  const duration = useDuration(call?.state === 'active' ? call.answeredAt : null);
  const volumeMenu = useVolumeMenu(call != null && voice.callId === call.id && voice.status !== 'idle');
  if (!call || String(call.peerId) !== String(peer?.id)) return null;

  const connected = voice.callId === call.id && voice.status === 'connected';
  const speaking = new Set(connected ? voice.speaking : []);
  const peerMuted = connected && voice.muted.includes(String(peer.id));
  const selfMuted = voice.selfMute || voice.selfDeaf;
  let status;
  if (call.state === 'ringing') status = call.outgoing ? 'Calling…' : 'Incoming call';
  else if (call.state === 'connecting' || !connected) status = voice.status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
  else status = duration;

  return (
    <div className="call-panel" aria-label={`Call with ${nameOf(peer)}`}>
      <div className="call-panel-people">
        {[[user, selfMuted], [peer, peerMuted]].map(([person, muted]) => (
          <div key={person.id} className="call-panel-person" {...volumeMenu.triggerProps(person.id, nameOf(person))}>
            {/* LiveKit's speaker list lags a moment behind a mute. */}
            <UserAvatar userId={person.id} className="call-panel-avatar" speaking={!muted && speaking.has(String(person.id))} />
            {muted && <span className="call-panel-muted" title="Muted" aria-label="Muted"><MicIcon muted /></span>}
          </div>
        ))}
      </div>
      <div className="call-panel-status">
        <span>{status}</span>
        <span className="call-panel-e2ee" title="Only the two of you can hear this call">
          <FontAwesomeIcon icon={faLock} /> End-to-end encrypted
        </span>
      </div>
      {volumeMenu.menu && <UserVolumeMenu {...volumeMenu.menu} sheet={isMobile} onClose={volumeMenu.close} />}
      {call.outgoing || call.state !== 'ringing' ? (
        <div className="voice-view-controls">
          <VoiceControls className="voice-view-button" />
          <button type="button" className="voice-view-button leave" aria-label="Hang up" title="Hang up" onClick={hangUp}>
            <FontAwesomeIcon icon={faPhoneSlash} fixedWidth />
          </button>
        </div>
      ) : null}
    </div>
  );
}
