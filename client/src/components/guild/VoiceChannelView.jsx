import React, { useContext } from 'react';
import '../../assets/css/voice.css';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPhoneSlash, faVolumeHigh } from '@fortawesome/free-solid-svg-icons';
import { ConfigContext } from '../../contexts';
import { useVoice } from '../../hooks/useVoice';
import { joinVoice, leaveVoice } from '../../voice/voiceClient';
import { PERMISSIONS, has } from '../../utils/permissions';
import UserAvatar from '../voice/UserAvatar';
import VoiceControls from '../voice/VoiceControls';
import { HeadphonesIcon, MicIcon } from '../voice/VoiceIcons';
import { displayName, useProfiles } from '../../utils/profiles';

// A voice channel's page: everyone in it as tiles (ringed while they talk, if you're in there
// too), and joining, or mute/deafen/disconnect once you're in. On mobile this is where you
// join (tapping the channel only opens it); on desktop clicking the channel already joined.
export default function VoiceChannelView({ guild, channel, nameColors }) {
  useProfiles();
  const { voiceEnabled } = useContext(ConfigContext);
  const voice = useVoice();
  const members = channel.voice ?? [];
  const here = voice.channelId === channel.id && voice.status !== 'idle';
  const speaking = new Set(here ? voice.speaking : []);
  const canConnect = has(channel.my_permissions, PERMISSIONS.CONNECT);

  let footer;
  if (here) {
    footer = (
      <div className="voice-view-controls">
        <VoiceControls className="voice-view-button" />
        <button type="button" className="voice-view-button leave" aria-label="Disconnect" title="Disconnect" onClick={leaveVoice}>
          <FontAwesomeIcon icon={faPhoneSlash} fixedWidth />
        </button>
      </div>
    );
  } else if (!voiceEnabled) {
    footer = <p className="voice-view-note">Voice isn&apos;t set up yet.</p>;
  } else if (!canConnect) {
    footer = <p className="voice-view-note">You don&apos;t have permission to join this channel.</p>;
  } else {
    footer = (
      <button type="button" className="voice-view-join" onClick={() => joinVoice(guild.id, channel.id)}>
        Join Voice
      </button>
    );
  }

  return (
    <div className="voice-view">
      {members.length === 0 ? (
        <div className="voice-view-empty">
          <FontAwesomeIcon icon={faVolumeHigh} size="2x" />
          <p>No one&apos;s here yet.</p>
        </div>
      ) : (
        <ul className="voice-view-tiles" aria-label={`In ${channel.name}`}>
          {members.map((m) => {
            const talking = speaking.has(String(m.user_id));
            return (
              <li key={m.user_id} className={`voice-tile${talking ? ' speaking' : ''}`}>
                <UserAvatar userId={m.user_id} className="voice-tile-avatar" speaking={talking} />
                <span className="voice-tile-name" style={nameColors?.[m.user_id] ? { color: nameColors[m.user_id] } : undefined}>
                  {displayName(m.user_id, m.username)}
                </span>
                {(m.self_mute || m.self_deaf) && (
                  <span className="voice-tile-icons">
                    <span title="Muted" aria-label="Muted"><MicIcon muted /></span>
                    {m.self_deaf && <span title="Deafened" aria-label="Deafened"><HeadphonesIcon deafened /></span>}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="voice-view-footer">
        {voice.status === 'connecting' && voice.channelId === channel.id ? <p className="voice-view-note">Connecting…</p> : footer}
      </div>
    </div>
  );
}
