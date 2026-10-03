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
import { t } from '../../i18n';

const STATUS_TEXT = {
  connecting: 'voice.bar.connecting',
  connected: 'voice.bar.connected',
  reconnecting: 'voice.bar.reconnecting',
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
          <button type="button" className="user-panel-button" aria-label={t('voice.bar.dismiss')} title={t('voice.bar.dismiss')} onClick={clearVoiceError}>
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
    <div className="voice-bar" aria-label={t('voice.bar.label')}>
      <div className="voice-bar-row">
        <div className="voice-bar-text">
          <span className={`voice-bar-status ${voice.status}`}>
            <FontAwesomeIcon icon={faSignal} /> {inCall && voice.status === 'connected' ? t('voice.bar.callConnected') : t(STATUS_TEXT[voice.status])}
          </span>
          {inCall && call?.groupId ? (
            <Link to={`/dm/g/${call.groupId}`} className="voice-bar-channel">
              {t('voice.bar.callInGroup', { name: groupTitle(groupList.groups.find((g) => g.id === call.groupId) ?? { name: t('voice.bar.aGroup') }, user) })}
            </Link>
          ) : inCall ? (
            <Link to={`/dm/${call?.peerId ?? ''}`} className="voice-bar-channel">
              {call ? t('voice.bar.callWith', { name: displayName(call.peerId, call.peerName) }) : t('voice.bar.call')}
            </Link>
          ) : (
            <Link to={`/guild/${voice.guildId}/${voice.channelId}`} className="voice-bar-channel">
              {guild ? t('voice.bar.channelInGuild', { channel: channel?.name ?? t('voice.bar.voice'), guild: guild.name }) : (channel?.name ?? t('voice.bar.voice'))}
            </Link>
          )}
        </div>
        {!inCall && <ScreenShareButton />}
        <button
          type="button"
          className="user-panel-button voice-bar-leave"
          aria-label={inCall ? t('voice.bar.hangUp') : t('voice.bar.disconnect')}
          title={inCall ? t('voice.bar.hangUp') : t('voice.bar.disconnect')}
          onClick={inCall ? hangUp : leaveVoice}
        >
          <FontAwesomeIcon icon={faPhoneSlash} />
        </button>
      </div>
      {voice.audioBlocked && (
        <button type="button" className="voice-bar-audio" onClick={resumeAudio}>
          <FontAwesomeIcon icon={faVolumeHigh} /> {t('voice.bar.turnOnSound')}
        </button>
      )}
      {voice.micError && <p className="voice-bar-message voice-bar-mic-error">{voice.micError}</p>}
      {voice.streaming && <p className="voice-bar-message voice-bar-live">{t('voice.bar.sharing')}</p>}
      {voice.streamError && (
        <div className="voice-bar-row">
          <p className="voice-bar-message voice-bar-mic-error">{voice.streamError}</p>
          <button type="button" className="user-panel-button" aria-label={t('voice.bar.dismiss')} title={t('voice.bar.dismiss')} onClick={clearStreamError}>
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>
      )}
      {!voice.canSpeak && voice.status === 'connected' && (
        <p className="voice-bar-message">{t('voice.bar.noSpeak')}</p>
      )}
    </div>
  );
}
