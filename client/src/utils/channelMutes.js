import { formatDateTime, formatTime } from './dateFormat';

// How long a channel can be muted for (Discord's choices): [label, seconds or null (until
// unmuted)].
export const MUTE_DURATIONS = [
  ['For 15 minutes', 15 * 60],
  ['For 1 hour', 60 * 60],
  ['For 3 hours', 3 * 60 * 60],
  ['For 8 hours', 8 * 60 * 60],
  ['For 24 hours', 24 * 60 * 60],
  ['Until I turn it back on', null],
];

// When a mute ends, in words: "Muted until 16:37" (another day: with the date).
export function mutedUntilText(until) {
  if (until == null) return 'Muted until you unmute it';
  const end = new Date(until * 1000);
  return `Muted until ${end.toDateString() === new Date().toDateString() ? formatTime(end) : formatDateTime(end)}`;
}

// A member's notification levels, for a guild or (with the guild's as the default) a channel.
export const NOTIFY_LEVEL_LABELS = {
  all: 'All messages',
  mentions: 'Only @mentions',
  none: 'Nothing',
};
