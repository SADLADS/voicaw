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
import CameraButton from '../voice/CameraButton';
import CameraVideo from '../voice/CameraVideo';
import UserVolumeMenu from '../voice/UserVolumeMenu';
import { MicIcon } from '../voice/VoiceIcons';
import { t } from '../../i18n';

// A group's call, at the top of the group: who's in it, and Join; once you're in, ringed
// while talking, the mic icon when muted, their camera when it's on, and the controls;
// clicking someone sets how loud they are for you.
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
  const cameras = new Set(connected ? voice.cameras : []);
  const isMuted = (id) => (id === user.id ? voice.selfMute || voice.selfDeaf : muted.has(String(id)));

  let status;
  if (!mine) status = t('calls.group.inCallCount', { count: participants.length });
  else if (!connected) status = voice.status === 'reconnecting' ? t('calls.panel.reconnecting') : t('calls.panel.connecting');
  else status = t('calls.group.inTheCall');

  return (
    <div className={`call-panel group-call-panel${cameras.size > 0 ? ' with-video' : ''}`} aria-label={t('calls.group.label')}>
      <div className="call-panel-people">
        {participants.map((id) => (
          <div key={id} className="call-panel-person" title={names.get(id)} {...volumeMenu.triggerProps(id, names.get(id) ?? t('calls.group.someone'))}>
            {cameras.has(String(id)) ? (
              <div className={`call-panel-video${!isMuted(id) && speaking.has(String(id)) ? ' speaking' : ''}`}>
                <CameraVideo userId={id} name={names.get(id) ?? t('calls.group.someone')} own={id === user.id} />
              </div>
            ) : (
              <UserAvatar userId={id} className="call-panel-avatar small" speaking={connected && !isMuted(id) && speaking.has(String(id))} />
            )}
            {connected && isMuted(id) && <span className="call-panel-muted" aria-label={t('calls.panel.muted')}><MicIcon muted /></span>}
            <span className="call-panel-name">{names.get(id) ?? t('calls.group.someone')}</span>
          </div>
        ))}
      </div>
      <div className="call-panel-status">
        <span>{status}</span>
        <span className="call-panel-e2ee" title={t('calls.group.e2eeHint')}>
          <FontAwesomeIcon icon={faLock} /> {t('calls.panel.e2ee')}
        </span>
      </div>
      {connected && voice.cameraError && <p className="voice-view-note voice-view-error" role="alert">{voice.cameraError}</p>}
      {volumeMenu.menu && <UserVolumeMenu {...volumeMenu.menu} sheet={isMobile} onClose={volumeMenu.close} />}
      {mine && mine.state !== 'ringing' ? (
        <div className="voice-view-controls">
          <VoiceControls className="voice-view-button" />
          <CameraButton className="voice-view-button" />
          <button type="button" className="voice-view-button leave" aria-label={t('calls.group.leave')} title={t('calls.group.leave')} onClick={hangUp}>
            <FontAwesomeIcon icon={faPhoneSlash} fixedWidth />
          </button>
        </div>
      ) : !mine && (
        <button type="button" className="voice-view-join" onClick={() => joinGroupCallById(groupId)} disabled={Boolean(call)}>
          <FontAwesomeIcon icon={faPhone} /> {t('calls.group.join')}
        </button>
      )}
    </div>
  );
}
