import React, { useContext } from 'react';
import '../../assets/css/voice.css';
import { Link } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPhoneSlash, faSignal, faTriangleExclamation, faVolumeHigh, faXmark } from '@fortawesome/free-solid-svg-icons';
import { LayoutContext } from '../../contexts';
import { useVoice } from '../../hooks/useVoice';
import { clearVoiceError, leaveVoice, resumeAudio } from '../../voice/voiceClient';

const STATUS_TEXT = {
  connecting: 'Connecting…',
  connected: 'Voice Connected',
  reconnecting: 'Reconnecting…',
};

// Above the user panel while you're in voice (like Discord): the connection state, which
// channel (a link to it) and the disconnect button. Also where voice errors show.
export default function VoiceBar() {
  const voice = useVoice();
  const { guildList } = useContext(LayoutContext);

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

  const guild = guildList.layouts[voice.guildId] ?? guildList.guilds.find((g) => g.id === voice.guildId);
  const channel = guildList.layouts[voice.guildId]?.channels.find((c) => c.id === voice.channelId);

  return (
    <div className="voice-bar" aria-label="Voice connection">
      <div className="voice-bar-row">
        <div className="voice-bar-text">
          <span className={`voice-bar-status ${voice.status}`}>
            <FontAwesomeIcon icon={faSignal} /> {STATUS_TEXT[voice.status]}
          </span>
          <Link to={`/guild/${voice.guildId}/${voice.channelId}`} className="voice-bar-channel">
            {channel?.name ?? 'Voice'}{guild ? ` / ${guild.name}` : ''}
          </Link>
        </div>
        <button type="button" className="user-panel-button voice-bar-leave" aria-label="Disconnect" title="Disconnect" onClick={leaveVoice}>
          <FontAwesomeIcon icon={faPhoneSlash} />
        </button>
      </div>
      {voice.audioBlocked && (
        <button type="button" className="voice-bar-audio" onClick={resumeAudio}>
          <FontAwesomeIcon icon={faVolumeHigh} /> Click to turn on sound
        </button>
      )}
      {voice.micError && <p className="voice-bar-message voice-bar-mic-error">{voice.micError}</p>}
      {!voice.canSpeak && voice.status === 'connected' && (
        <p className="voice-bar-message">You don&apos;t have permission to speak here.</p>
      )}
    </div>
  );
}
