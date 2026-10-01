import React from 'react';
import '../../assets/css/voice.css';
import UserAvatar from '../voice/UserAvatar';
import { HeadphonesIcon, MicIcon } from '../voice/VoiceIcons';
import { displayName, useProfiles } from '../../utils/profiles';

// Who's in a voice channel, under it in the channel list (like Discord): picture (ringed while
// they talk, when you're in the channel too and can hear it), name, Live while sharing their
// screen, and mute/deafen icons.
export default function VoiceChannelMembers({ members, speaking }) {
  useProfiles();
  if (!members?.length) return null;
  return (
    <ul className="voice-members" aria-label="In this channel">
      {members.map((m) => (
        <li key={m.user_id} className="voice-member">
          <UserAvatar userId={m.user_id} className="voice-member-avatar" speaking={speaking.has(String(m.user_id))} />
          <span className="voice-member-name">{displayName(m.user_id, m.username)}</span>
          <span className="voice-member-icons">
            {m.self_stream && <span className="voice-live-badge">Live</span>}
            {(m.self_mute || m.self_deaf) && <span title="Muted" aria-label="Muted"><MicIcon muted /></span>}
            {m.self_deaf && <span title="Deafened" aria-label="Deafened"><HeadphonesIcon deafened /></span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
