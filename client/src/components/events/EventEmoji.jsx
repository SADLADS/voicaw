import React from 'react';
import { ReactionEmoji } from '../MessageReactions';

// An event's emoji (Unicode or a guild's custom one), before its name; nothing without one.
export default function EventEmoji({ emoji }) {
  if (!emoji) return null;
  return <span className="event-emoji" aria-hidden="true"><ReactionEmoji native={emoji} /></span>;
}
