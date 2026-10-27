import React, { useContext, useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { faLock, faPhoneSlash } from '@fortawesome/free-solid-svg-icons';
import '../../assets/css/voice.css';
import { useCall } from '../../hooks/useCall';
import { useVoice } from '../../hooks/useVoice';
import { useVolumeMenu } from '../../hooks/useVolumeMenu';
import { InteractionContext } from '../../contexts';
import { hangUp } from '../../voice/callClient';
import { watchStream } from '../../voice/voiceClient';
import UserAvatar from '../voice/UserAvatar';
import VoiceControls from '../voice/VoiceControls';
import PushToTalkButton from '../voice/PushToTalkButton';
import CameraButton from '../voice/CameraButton';
import CameraVideo from '../voice/CameraVideo';
import ScreenShareButton from '../voice/ScreenShareButton';
import CallStream from './CallStream';
import UserVolumeMenu from '../voice/UserVolumeMenu';
import { MicIcon } from '../voice/VoiceIcons';
import { nameOf } from '../../utils/profiles';
import { t } from '../../i18n';

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
// the mic icon when muted, their camera instead of their picture when it's on, Live while
// sharing their screen), the state or how long it's been going, a shared screen (CallStream)
// and the controls. Clicking the other person once you're in sets how loud they are for you.
// The other person's screen share opens on its own (you're its only viewer); Stop watching
// keeps it closed until they share again.
export default function CallPanel({ user, peer }) {
  const call = useCall();
  const voice = useVoice();
  const { isMobile } = useContext(InteractionContext);
  const duration = useDuration(call?.state === 'active' ? call.answeredAt : null);
  const volumeMenu = useVolumeMenu(call != null && voice.callId === call.id && voice.status !== 'idle');
  const peerLive = call != null && voice.callId === call.id && voice.status === 'connected'
    && String(call.peerId) === String(peer?.id) && voice.streams.includes(String(peer.id));
  useEffect(() => {
    if (peerLive && voice.watching == null) watchStream(peer.id);
  }, [peerLive]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!call || String(call.peerId) !== String(peer?.id)) return null;

  const connected = voice.callId === call.id && voice.status === 'connected';
  const speaking = new Set(connected ? voice.speaking : []);
  const peerMuted = connected && voice.muted.includes(String(peer.id));
  const cameras = new Set(connected ? voice.cameras : []);
  const live = new Set(connected ? voice.streams : []);
  const selfMuted = voice.selfMute || voice.selfDeaf;
  let status;
  if (call.state === 'ringing') status = call.outgoing ? t('calls.panel.calling') : t('calls.panel.incoming');
  else if (call.state === 'connecting' || !connected) status = voice.status === 'reconnecting' ? t('calls.panel.reconnecting') : t('calls.panel.connecting');
  else status = duration;

  return (
    <div className={`call-panel${cameras.size > 0 ? ' with-video' : ''}`} aria-label={t('calls.panel.label', { name: nameOf(peer) })}>
      <div className="call-panel-people">
        {[[user, selfMuted], [peer, peerMuted]].map(([person, muted]) => (
          <div key={person.id} className="call-panel-person" {...volumeMenu.triggerProps(person.id, nameOf(person))}>
            {/* LiveKit's speaker list lags a moment behind a mute. */}
            {cameras.has(String(person.id)) ? (
              <div className={`call-panel-video${!muted && speaking.has(String(person.id)) ? ' speaking' : ''}`}>
                <CameraVideo userId={person.id} name={nameOf(person)} own={person.id === user.id} />
              </div>
            ) : (
              <UserAvatar userId={person.id} className="call-panel-avatar" speaking={!muted && speaking.has(String(person.id))} />
            )}
            {live.has(String(person.id)) && <span className="voice-live-badge call-panel-live">{t('calls.stream.live')}</span>}
            {muted && <span className="call-panel-muted" title={t('calls.panel.muted')} aria-label={t('calls.panel.muted')}><MicIcon muted /></span>}
          </div>
        ))}
      </div>
      <div className="call-panel-status">
        <span>{status}</span>
        <span className="call-panel-e2ee" title={t('calls.panel.e2eeHint')}>
          <Icon icon={faLock} /> {t('calls.panel.e2ee')}
        </span>
      </div>
      {connected && <CallStream nameOf={(id) => nameOf(String(id) === String(user.id) ? user : peer)} />}
      {connected && voice.streamError && <p className="voice-view-note voice-view-error" role="alert">{voice.streamError}</p>}
      {connected && voice.cameraError && <p className="voice-view-note voice-view-error" role="alert">{voice.cameraError}</p>}
      {volumeMenu.menu && <UserVolumeMenu {...volumeMenu.menu} sheet={isMobile} onClose={volumeMenu.close} />}
      {call.outgoing || call.state !== 'ringing' ? (
        <div className="voice-view-controls">
          <VoiceControls className="voice-view-button" />
          <PushToTalkButton className="voice-view-button" />
          <CameraButton className="voice-view-button" />
          <ScreenShareButton className="voice-view-button" />
          <button type="button" className="voice-view-button leave" aria-label={t('calls.panel.hangUp')} title={t('calls.panel.hangUp')} onClick={hangUp}>
            <Icon icon={faPhoneSlash} fixedWidth />
          </button>
        </div>
      ) : null}
    </div>
  );
}
