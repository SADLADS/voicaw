import React, { useContext } from 'react';
import '../../assets/css/voice.css';
import { InteractionContext } from '../../contexts';
import { useVolumeMenu } from '../../hooks/useVolumeMenu';
import UserAvatar from '../voice/UserAvatar';
import UserVolumeMenu from '../voice/UserVolumeMenu';
import { CameraIcon, EarIcon, HeadphonesIcon, MicIcon } from '../voice/VoiceIcons';
import { displayName, isBot, useProfiles } from '../../utils/profiles';
import { t } from '../../i18n';

// Who's in a voice channel, under it in the channel list (like Discord): picture (ringed while
// they talk, when you're in the channel too and can hear it), name, Live while sharing their
// screen, a camera while theirs is on, mute/deafen icons, and an ear on a bot that can hear the channel (Listen). `inChannel`: you're in it, so clicking someone else sets how
// loud they are for you.
export default function VoiceChannelMembers({ members, speaking, inChannel = false }) {
  useProfiles();
  const { isMobile } = useContext(InteractionContext);
  const volumeMenu = useVolumeMenu(inChannel);
  if (!members?.length) return null;
  return (
    <ul className="voice-members" aria-label={t('guilds.voice.inThisChannel')}>
      {members.map((m) => (
        <li key={m.user_id} className="voice-member" {...volumeMenu.triggerProps(m.user_id, displayName(m.user_id, m.username))}>
          <UserAvatar userId={m.user_id} className="voice-member-avatar" speaking={speaking.has(String(m.user_id))} />
          <span className="voice-member-name">{displayName(m.user_id, m.username)}</span>
          <span className="voice-member-icons">
            {m.self_stream && <span className="voice-live-badge">{t('guilds.voice.live')}</span>}
            {m.self_video && <span title={t('guilds.voice.cameraOn')} aria-label={t('guilds.voice.cameraOn')}><CameraIcon /></span>}
            {isBot(m.user_id) && m.listening !== false && <span className="voice-listening" title={t('guilds.voice.botListening')} aria-label={t('guilds.voice.botListening')}><EarIcon /></span>}
            {(m.self_mute || m.self_deaf) && <span title={t('guilds.voice.muted')} aria-label={t('guilds.voice.muted')}><MicIcon muted /></span>}
            {m.self_deaf && <span title={t('guilds.voice.deafened')} aria-label={t('guilds.voice.deafened')}><HeadphonesIcon deafened /></span>}
          </span>
        </li>
      ))}
      {volumeMenu.menu && <UserVolumeMenu {...volumeMenu.menu} sheet={isMobile} onClose={volumeMenu.close} />}
    </ul>
  );
}
