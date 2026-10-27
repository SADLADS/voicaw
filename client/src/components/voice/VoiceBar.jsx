import React, { useContext } from 'react';
import '../../assets/css/voice.css';
import { Link, useLocation } from 'react-router-dom';
import { Icon } from '../Icon';
import { faMessage, faPhoneSlash, faSignal, faTriangleExclamation, faVolumeHigh, faXmark } from '@fortawesome/free-solid-svg-icons';
import { LayoutContext } from '../../contexts';
import { showContent } from '../../utils/mobilePanes';
import { useVoice } from '../../hooks/useVoice';
import { clearCameraError, clearStreamError, clearVoiceError, leaveVoice, resumeAudio } from '../../voice/voiceClient';
import ScreenShareButton from './ScreenShareButton';
import CameraButton from './CameraButton';
import SoundboardButton from './SoundboardButton';
import PushToTalkButton from './PushToTalkButton';
import { hangUp } from '../../voice/callClient';
import { useCall } from '../../hooks/useCall';
import { useProfiles } from '../../utils/profiles';
import { voiceTitle } from '../../utils/voiceTitle';
import { t } from '../../i18n';

const STATUS_TEXT = {
  connecting: 'voice.bar.connecting',
  connected: 'voice.bar.connected',
  reconnecting: 'voice.bar.reconnecting',
};

// Above the user panel while you're in voice (like Discord): the connection state, which
// channel or call (a link to it), the voice channel's chat (opens or closes it; marked while it
// has unread messages), camera, share screen, the soundboard (voice channels) and the disconnect
// button, and with push to talk on a button to hold. Also where voice errors
// show.
export default function VoiceBar({ user }) {
  useProfiles();
  const voice = useVoice();
  const call = useCall();
  const { guildList, groupList } = useContext(LayoutContext);
  const location = useLocation();

  if (voice.status === 'idle') {
    if (!voice.error) return null;
    return (
      <div className="voice-bar" role="status">
        <div className="voice-bar-row">
          <Icon icon={faTriangleExclamation} className="voice-bar-warning" />
          <span className="voice-bar-message">{voice.error}</span>
          <button type="button" className="user-panel-button" aria-label={t('voice.bar.dismiss')} title={t('voice.bar.dismiss')} onClick={clearVoiceError}>
            <Icon icon={faXmark} />
          </button>
        </div>
      </div>
    );
  }

  const inCall = voice.callId != null;
  const title = voiceTitle({ voice, call, guildList, groupList, user });
  const channelPath = `/guild/${voice.guildId}/${voice.channelId}`;
  const chatOpen = !inCall && location.pathname === channelPath && new URLSearchParams(location.search).get('chat') === '1';
  // As the channel list: a muted channel's chat is only marked for mentions.
  const chatUnread = !inCall && !chatOpen && guildList.unread.some((u) => u.channel_id === voice.channelId
    && (u.mentions > 0 || !guildList.isMuted(u.channel_id)));

  // Two rows, as Discord's: the state (a signal in a tinted tile), the channel or call and
  // Disconnect; then the actions as equal buttons across the width.
  return (
    <div className="voice-bar" aria-label={t('voice.bar.label')}>
      <div className="voice-bar-row voice-bar-head">
        <span className={`voice-bar-signal ${voice.status}`} aria-hidden="true">
          <Icon icon={faSignal} />
        </span>
        <div className="voice-bar-text">
          <span className={`voice-bar-status ${voice.status}`}>
            {inCall && voice.status === 'connected' ? t('voice.bar.callConnected') : t(STATUS_TEXT[voice.status])}
          </span>
          {inCall && call?.groupId ? (
            <Link to={`/dm/g/${call.groupId}`} className="voice-bar-channel">{title}</Link>
          ) : inCall ? (
            <Link to={`/dm/${call?.peerId ?? ''}`} className="voice-bar-channel">{title}</Link>
          ) : (
            <Link to={channelPath} className="voice-bar-channel">{title}</Link>
          )}
        </div>
        <button
          type="button"
          className="user-panel-button voice-bar-leave"
          aria-label={inCall ? t('voice.bar.hangUp') : t('voice.bar.disconnect')}
          title={inCall ? t('voice.bar.hangUp') : t('voice.bar.disconnect')}
          onClick={inCall ? hangUp : leaveVoice}
        >
          <Icon icon={faPhoneSlash} />
        </button>
      </div>
      <div className="voice-bar-actions">
        {!inCall && (
          <Link
            to={chatOpen ? channelPath : `${channelPath}?chat=1`}
            onClick={showContent}
            className={`user-panel-button voice-bar-action voice-bar-chat${chatOpen ? ' active' : ''}${chatUnread ? ' unread' : ''}`}
            aria-label={chatOpen ? t('voice.bar.closeChat') : t('voice.bar.openChat')}
            title={chatOpen ? t('voice.bar.closeChat') : t('voice.bar.openChat')}
          >
            <Icon icon={faMessage} />
          </Link>
        )}
        <CameraButton className="user-panel-button voice-bar-action" />
        <ScreenShareButton className="user-panel-button voice-bar-action" />
        <SoundboardButton className="user-panel-button voice-bar-action" />
      </div>
      <PushToTalkButton className="user-panel-button voice-bar-ptt" />
      {voice.audioBlocked && (
        <button type="button" className="voice-bar-audio" onClick={resumeAudio}>
          <Icon icon={faVolumeHigh} /> {t('voice.bar.turnOnSound')}
        </button>
      )}
      {voice.micError && <p className="voice-bar-message voice-bar-mic-error">{voice.micError}</p>}
      {voice.streaming && <p className="voice-bar-message voice-bar-live">{t('voice.bar.sharing')}</p>}
      {voice.streamError && (
        <div className="voice-bar-row">
          <p className="voice-bar-message voice-bar-mic-error">{voice.streamError}</p>
          <button type="button" className="user-panel-button" aria-label={t('voice.bar.dismiss')} title={t('voice.bar.dismiss')} onClick={clearStreamError}>
            <Icon icon={faXmark} />
          </button>
        </div>
      )}
      {voice.cameraError && (
        <div className="voice-bar-row">
          <p className="voice-bar-message voice-bar-mic-error">{voice.cameraError}</p>
          <button type="button" className="user-panel-button" aria-label={t('voice.bar.dismiss')} title={t('voice.bar.dismiss')} onClick={clearCameraError}>
            <Icon icon={faXmark} />
          </button>
        </div>
      )}
      {!voice.canSpeak && voice.status === 'connected' && (
        <p className="voice-bar-message">{t('voice.bar.noSpeak')}</p>
      )}
    </div>
  );
}
