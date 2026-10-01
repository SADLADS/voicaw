import React, { useContext } from 'react';
import '../../assets/css/voice.css';
import { Link } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPhoneSlash, faSignal, faTriangleExclamation, faVolumeHigh, faXmark } from '@fortawesome/free-solid-svg-icons';
import { LayoutContext } from '../../contexts';
import { useVoice } from '../../hooks/useVoice';
import { clearStreamError, clearVoiceError, leaveVoice, resumeAudio } from '../../voice/voiceClient';
import ScreenShareButton from './ScreenShareButton';
import { hangUp } from '../../voice/callClient';
import { useCall } from '../../hooks/useCall';
import { groupTitle } from '../../utils/groupDisplay';
import { displayName, useProfiles } from '../../utils/profiles';

const STATUS_TEXT = {
  connecting: 'Connecting…',
  connected: 'Voice Connected',
  reconnecting: 'Reconnecting…',
};

// Above the user panel while you're in voice (like Discord): the connection state, which
// channel or call (a link to it), share screen and the disconnect button. Also where voice
// errors show.
export default function VoiceBar({ user }) {
  useProfiles();
  const voice = useVoice();
  const call = useCall();
  const { guildList, groupList } = useContext(LayoutContext);

  if (voice.status === 'idle') {
    if (!voice.error) return null;
    return (
      <div className="voice-bar" role="status">
        <div className="voice-bar-row">
          <FontAwesomeIcon icon={faTriangleExclamation} className="voice-bar-warning" />
          <span className="voice-bar-message">{voice.error}</span>
          <button type="button" className="user-panel-button" aria-label="Dismiss" title="Dismiss" onClick={clearVoiceError}>
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>
      </div>
    );
  }

  const inCall = voice.callId != null;
  const guild = guildList.layouts[voice.guildId] ?? guildList.guilds.find((g) => g.id === voice.guildId);
  const channel = guildList.layouts[voice.guildId]?.channels.find((c) => c.id === voice.channelId);

  return (
    <div className="voice-bar" aria-label="Voice connection">
      <div className="voice-bar-row">
        <div className="voice-bar-text">
          <span className={`voice-bar-status ${voice.status}`}>
            <FontAwesomeIcon icon={faSignal} /> {inCall && voice.status === 'connected' ? 'Call Connected' : STATUS_TEXT[voice.status]}
          </span>
          {inCall && call?.groupId ? (
            <Link to={`/dm/g/${call.groupId}`} className="voice-bar-channel">
              {`Call in ${groupTitle(groupList.groups.find((g) => g.id === call.groupId) ?? { name: call.groupName }, user)}`}
            </Link>
          ) : inCall ? (
            <Link to={`/dm/${call?.peerId ?? ''}`} className="voice-bar-channel">
              {call ? `Call with ${displayName(call.peerId, call.peerName)}` : 'Call'}
            </Link>
          ) : (
            <Link to={`/guild/${voice.guildId}/${voice.channelId}`} className="voice-bar-channel">
              {channel?.name ?? 'Voice'}{guild ? ` / ${guild.name}` : ''}
            </Link>
          )}
        </div>
        {!inCall && <ScreenShareButton />}
        <button
          type="button"
          className="user-panel-button voice-bar-leave"
          aria-label={inCall ? 'Hang up' : 'Disconnect'}
          title={inCall ? 'Hang up' : 'Disconnect'}
          onClick={inCall ? hangUp : leaveVoice}
        >
          <FontAwesomeIcon icon={faPhoneSlash} />
        </button>
      </div>
      {voice.audioBlocked && (
        <button type="button" className="voice-bar-audio" onClick={resumeAudio}>
          <FontAwesomeIcon icon={faVolumeHigh} /> Click to turn on sound
        </button>
      )}
      {voice.micError && <p className="voice-bar-message voice-bar-mic-error">{voice.micError}</p>}
      {voice.streaming && <p className="voice-bar-message voice-bar-live">You&apos;re sharing your screen.</p>}
      {voice.streamError && (
        <div className="voice-bar-row">
          <p className="voice-bar-message voice-bar-mic-error">{voice.streamError}</p>
          <button type="button" className="user-panel-button" aria-label="Dismiss" title="Dismiss" onClick={clearStreamError}>
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>
      )}
      {!voice.canSpeak && voice.status === 'connected' && (
        <p className="voice-bar-message">You don&apos;t have permission to speak here.</p>
      )}
    </div>
  );
}
