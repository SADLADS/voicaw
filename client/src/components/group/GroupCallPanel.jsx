import React, { useContext } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faLock, faPhone, faPhoneSlash } from '@fortawesome/free-solid-svg-icons';
import '../../assets/css/voice.css';
import { useCall, useGroupCall } from '../../hooks/useCall';
import { useVoice } from '../../hooks/useVoice';
import { useVolumeMenu } from '../../hooks/useVolumeMenu';
import { InteractionContext } from '../../contexts';
import { hangUp, joinGroupCallById } from '../../voice/callClient';
import UserAvatar from '../voice/UserAvatar';
import VoiceControls from '../voice/VoiceControls';
import UserVolumeMenu from '../voice/UserVolumeMenu';
import { MicIcon } from '../voice/VoiceIcons';

// A group's call, at the top of the group: who's in it, and Join; once you're in, ringed
// while talking, the mic icon when muted, and the controls; clicking someone sets how loud
// they are for you.
export default function GroupCallPanel({ groupId, names, user }) {
  const groupCall = useGroupCall(groupId);
  const call = useCall();
  const voice = useVoice();
  const { isMobile } = useContext(InteractionContext);
  const mine = call?.groupId === groupId ? call : null;
  const volumeMenu = useVolumeMenu(mine != null && voice.callId === mine.id && voice.status !== 'idle');
  if (!groupCall && !mine) return null;

  const participants = mine?.participants ?? groupCall?.participants ?? [];
  const connected = mine && voice.callId === mine.id && voice.status === 'connected';
  const speaking = new Set(connected ? voice.speaking : []);
  const muted = new Set(connected ? voice.muted : []);
  const isMuted = (id) => (id === user.id ? voice.selfMute || voice.selfDeaf : muted.has(String(id)));

  let status;
  if (!mine) status = `${participants.length} in the call`;
  else if (!connected) status = voice.status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
  else status = 'In the call';

  return (
    <div className="call-panel group-call-panel" aria-label="Group call">
      <div className="call-panel-people">
        {participants.map((id) => (
          <div key={id} className="call-panel-person" title={names.get(id)} {...volumeMenu.triggerProps(id, names.get(id) ?? 'Someone')}>
            <UserAvatar userId={id} className="call-panel-avatar small" speaking={connected && !isMuted(id) && speaking.has(String(id))} />
            {connected && isMuted(id) && <span className="call-panel-muted" aria-label="Muted"><MicIcon muted /></span>}
            <span className="call-panel-name">{names.get(id) ?? 'Someone'}</span>
          </div>
        ))}
      </div>
      <div className="call-panel-status">
        <span>{status}</span>
        <span className="call-panel-e2ee" title="Only the group's members can hear this call">
          <FontAwesomeIcon icon={faLock} /> End-to-end encrypted
        </span>
      </div>
      {volumeMenu.menu && <UserVolumeMenu {...volumeMenu.menu} sheet={isMobile} onClose={volumeMenu.close} />}
      {mine && mine.state !== 'ringing' ? (
        <div className="voice-view-controls">
          <VoiceControls className="voice-view-button" />
          <button type="button" className="voice-view-button leave" aria-label="Leave call" title="Leave call" onClick={hangUp}>
            <FontAwesomeIcon icon={faPhoneSlash} fixedWidth />
          </button>
        </div>
      ) : !mine && (
        <button type="button" className="voice-view-join" onClick={() => joinGroupCallById(groupId)} disabled={Boolean(call)}>
          <FontAwesomeIcon icon={faPhone} /> Join call
        </button>
      )}
    </div>
  );
}
