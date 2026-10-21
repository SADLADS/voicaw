import { PERMISSIONS, colorToHex, has } from './permissions';
import { allDayDates } from './eventCalendar';
import { formatEventTime, formatLongDate, formatTime, formatWeekday } from './dateFormat';
import { t } from '../i18n';

// Scheduled events in the app (server/guildEvents.js has the rules): who may do what, where an
// event is and when, in words.

// The permissions that apply to `event`: its voice channel's (0 if you can't see it), else the
// guild's.
export function eventPermissions(event, guild) {
  if (event.channel_id == null) return guild?.my_permissions ?? 0;
  return guild?.channels.find((c) => c.id === event.channel_id)?.my_permissions ?? 0;
}

// Whether you may edit, start, end and cancel it: Manage Events, or your own with Create Events.
export function canManageEvent(event, guild, userId) {
  const permissions = eventPermissions(event, guild);
  return has(permissions, PERMISSIONS.MANAGE_EVENTS) ||
    (event.creator_id === userId && has(permissions, PERMISSIONS.CREATE_EVENTS));
}

// The voice channels you may hold an event in (Create Events and Connect there).
export function eventVoiceChannels(guild) {
  return (guild?.channels ?? []).filter((c) => c.type === 'voice' &&
    has(c.my_permissions, PERMISSIONS.CREATE_EVENTS) && has(c.my_permissions, PERMISSIONS.CONNECT));
}

// Whether you may make events at all: somewhere else, or in some voice channel.
export function canCreateEvents(guild) {
  return has(guild?.my_permissions, PERMISSIONS.CREATE_EVENTS) || eventVoiceChannels(guild).length > 0;
}

// Where it is: { voice: true, label: channel name } or { voice: false, label: the location, or
// null when its maker didn't say }.
export function eventPlace(event, guild) {
  if (event.entity_type === 'voice') {
    const channel = guild?.channels.find((c) => c.id === event.channel_id);
    return { voice: true, label: channel?.name ?? t('events.place.unknownChannel') };
  }
  return { voice: false, label: event.location || null };
}

// A word on when, next to its date: happening now, starting soon, waiting to be started (a
// voice event past its time), or null when it's more than a week away.
export function eventStatusText(event, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (event.status === 'active') return t('events.when.live');
  if (event.status === 'completed') return t('events.when.ended');
  const seconds = event.start_time - nowSeconds;
  if (seconds <= 0) return t('events.when.waiting');
  if (event.all_day && seconds < 86400) return t('events.when.inDays', { count: 1 });
  if (seconds < 3600) return t('events.when.inMinutes', { count: Math.max(1, Math.round(seconds / 60)) });
  if (seconds < 86400) return t('events.when.inHours', { count: Math.round(seconds / 3600) });
  if (seconds < 7 * 86400) return t('events.when.inDays', { count: Math.round(seconds / 86400) });
  return null;
}

// Unix seconds as the date and time inputs' values ('YYYY-MM-DD', 'HH:MM'), on this device.
export function toInputs(seconds) {
  if (seconds == null) return { date: '', time: '' };
  const d = new Date(seconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

// The inputs back as unix seconds (null if either is empty or invalid).
export function fromInputs(date, time) {
  if (!date || !time) return null;
  const ms = new Date(`${date}T${time}`).getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

// When an occurrence (`start`, `end`: unix s, the event's own by default) is, in words: "Tuesday
// 6 October 2026, 20:00" (with `withEnd`, "– 22:00" too), or for an all-day event its dates:
// "Tuesday 6 October 2026 · All day", "Tuesday 6 October 2026 – Thursday 8 October 2026".
export function formatEventWhen(event, { start = event.start_time, end = event.end_time, withEnd = false } = {}) {
  if (event.all_day) {
    const { first, last } = allDayDates(event, start, end);
    const day = (d) => `${formatWeekday(d)} ${formatLongDate(d)}`;
    return last > first ? `${day(first)} – ${day(last)}` : t('events.when.allDayOn', { date: day(first) });
  }
  const at = formatEventTime(start * 1000);
  return withEnd && end != null ? `${at} – ${formatTime(end * 1000)}` : at;
}

// The event's colour as CSS (#rrggbb), or null for the default.
export const eventColor = (event) => (event.color != null ? colorToHex(event.color) : null);

// What Interested offers on an occurrence of a repeating event (occurrenceView's): this one,
// and all of them, each added or taken away as fits how interested you are (`interested`:
// this one, `interested_all`: the series). { key (its label, events.interest.<key>),
// interested, occurrence (its original start, or null for all of them) }.
export const interestChoices = (view) => [
  { key: view.interested ? 'thisRemove' : 'thisAdd', interested: !view.interested, occurrence: view.original_start ?? null },
  { key: view.interested_all ? 'allRemove' : 'allAdd', interested: !view.interested_all, occurrence: null },
];

// Where you are interested in occurrences of the series apart from it (`mine`, original start
// -> interested), the current one's `interested` follows.
function withCurrent(event, all, mine) {
  const current = event.occurrence_start;
  return { interested: current != null && current in mine ? mine[current] : all, interested_all: all, my_occurrences: mine };
}

// { interested (the current occurrence), interested_all, my_occurrences } after a choice (as
// interestChoices'; a plain toggle has `occurrence` null), as the server's setInterest works
// it out: all of them replaces any single ones.
export function interestAfter(event, { interested, occurrence = null }) {
  if (!event.recurrence || occurrence == null) return { interested, interested_all: interested, my_occurrences: {} };
  const all = Boolean(event.interested_all);
  const mine = { ...(event.my_occurrences ?? {}) };
  if (interested === all) delete mine[occurrence];
  else mine[occurrence] = interested;
  return withCurrent(event, all, mine);
}

// Your interest (interestAfter's shape) in `event` when it's sent again changed, from what you
// had (`before`, null for a new one: its creator, `userId`, is interested in all of it). As on
// the server: occurrences gone by take their single interest with them, and a new `revision`
// (the series edited anew) all of it.
export function interestKept(before, event, userId = null) {
  if (!before) {
    const mine = event.creator_id === userId;
    return { interested: mine, interested_all: mine, my_occurrences: {} };
  }
  const all = Boolean(before.interested_all ?? before.interested);
  const kept = {};
  if ((before.revision ?? 0) === (event.revision ?? 0) && event.recurrence) {
    for (const [original, value] of Object.entries(before.my_occurrences ?? {})) {
      if (Number(original) >= event.occurrence_start) kept[original] = value;
    }
  }
  return withCurrent(event, all, kept);
}

// Your interest in an event "this and following" just made from `old` (the series it
// continues): the series' carries over, and single ones from its first occurrence on when its
// times stayed (the server moves them then).
export function interestContinued(old, event) {
  const all = Boolean(old.interested_all);
  const kept = {};
  if (event.recurrence && old.until === event.occurrence_start) {
    for (const [original, value] of Object.entries(old.my_occurrences ?? {})) {
      if (Number(original) >= event.occurrence_start) kept[original] = value;
    }
  }
  return withCurrent(event, all, kept);
}
