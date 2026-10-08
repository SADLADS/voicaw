import React from 'react';
import { ReactionEmoji } from './MessageReactions';

// Someone's custom status: its emoji (Unicode or a guild's custom one, server/profiles.js) then
// its text, either of which may be missing; nothing without both. `profile` needs
// { custom_status, custom_status_emoji }.
export default function CustomStatus({ profile, className = '' }) {
  const text = profile?.custom_status;
  const emoji = profile?.custom_status_emoji;
  if (!text && !emoji) return null;
  return (
    <span className={`custom-status ${className}`.trim()}>
      {emoji && <span className="custom-status-emoji"><ReactionEmoji native={emoji} /></span>}
      {text && <span className="custom-status-text">{text}</span>}
    </span>
  );
}
