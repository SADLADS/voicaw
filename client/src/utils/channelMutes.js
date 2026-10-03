import { formatDateTime, formatTime } from './dateFormat';
import { t } from '../i18n';

// How long a channel can be muted for (Discord's choices): [label, seconds or null (until
// unmuted)].
export const MUTE_DURATIONS = [
  [t('guildAdmin.mute.forMinutes', { count: 15 }), 15 * 60],
  [t('guildAdmin.mute.forHours', { count: 1 }), 60 * 60],
  [t('guildAdmin.mute.forHours', { count: 3 }), 3 * 60 * 60],
  [t('guildAdmin.mute.forHours', { count: 8 }), 8 * 60 * 60],
  [t('guildAdmin.mute.forHours', { count: 24 }), 24 * 60 * 60],
  [t('guildAdmin.mute.untilTurnedOn'), null],
];

// When a mute ends, in words: "Muted until 16:37" (another day: with the date).
export function mutedUntilText(until) {
  if (until == null) return t('guildAdmin.mute.untilUnmuted');
  const end = new Date(until * 1000);
  return t('guildAdmin.mute.until', { time: end.toDateString() === new Date().toDateString() ? formatTime(end) : formatDateTime(end) });
}

// A member's notification levels, for a guild or (with the guild's as the default) a channel.
export const NOTIFY_LEVEL_LABELS = {
  all: t('guildAdmin.notifyLevels.all.label'),
  mentions: t('guildAdmin.notifyLevels.mentions.label'),
  none: t('guildAdmin.notifyLevels.none.label'),
};
