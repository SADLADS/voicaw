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

// RSVPs (server/guildEvents.js setRsvp): 'going', 'maybe', 'declined' (Can't go), or null for
// no answer. Discord's Interested is going or maybe.
export const RSVPS = ['going', 'maybe', 'declined'];
export const isInterested = (rsvp) => rsvp === 'going' || rsvp === 'maybe';

// Your answers to an event: to the series (`all`), to occurrences apart from it (`mine`,
// original start -> rsvp or null), and the current one's, which follows them.
function withCurrent(event, all, mine) {
  const current = event.occurrence_start;
  const rsvp = current != null && current in mine ? mine[current] : all;
  return { rsvp, rsvp_all: all, my_rsvps: mine, interested: isInterested(rsvp) };
}

// { rsvp (the current occurrence), rsvp_all, my_rsvps, interested } after a choice ({ rsvp,
// occurrence: an original start, or null for all of them }), as the server's setRsvp works it
// out: all of them replaces any single ones, and a date answered as the series is goes.
export function rsvpAfter(event, { rsvp, occurrence = null }) {
  if (!event.recurrence || occurrence == null) return withCurrent({}, rsvp, {});
  const all = event.rsvp_all ?? null;
  const mine = { ...(event.my_rsvps ?? {}) };
  if (rsvp === all) delete mine[occurrence];
  else mine[occurrence] = rsvp;
  return withCurrent(event, all, mine);
}

// Single dates' answers of `from` still to come in `event` (from its current occurrence on).
function laterOnes(from, event) {
  const kept = {};
  for (const [original, value] of Object.entries(from ?? {})) {
    if (Number(original) >= event.occurrence_start) kept[original] = value;
  }
  return kept;
}

// Your answers (rsvpAfter's shape) to `event` when it's sent again changed, from what you had
// (`before`, null for a new one: its creator, `userId`, is going to all of it). As on the
// server: occurrences gone by take their own answers with them, and a new `revision` (the
// series edited anew) all of them.
export function rsvpKept(before, event, userId = null) {
  if (!before) return withCurrent(event, event.creator_id === userId ? 'going' : null, {});
  const kept = (before.revision ?? 0) === (event.revision ?? 0) && event.recurrence ? laterOnes(before.my_rsvps, event) : {};
  return withCurrent(event, before.rsvp_all ?? null, kept);
}

// Your answers to an event "this and following" just made from `old` (the series it
// continues): the series' carries over, and single dates' from its first occurrence on when
// its times stayed (the server moves them then).
export function rsvpContinued(old, event) {
  const kept = event.recurrence && old.until === event.occurrence_start ? laterOnes(old.my_rsvps, event) : {};
  return withCurrent(event, old.rsvp_all ?? null, kept);
}

// How many answered the occurrence shown, in words ("3 of 10 going · 1 maybe · 2 on the
// waitlist"); "N interested" where only that is known (what took place, the editor's preview).
export function rsvpSummary(event) {
  const counts = event.rsvp_counts;
  if (!counts) return t('events.interestedCount', { count: event.user_count ?? 0 });
  const parts = [
    event.rsvp_limit != null
      ? t('events.rsvp.goingOf', { count: counts.going, limit: event.rsvp_limit })
      : t('events.rsvp.goingCount', { count: counts.going }),
  ];
  if (counts.maybe) parts.push(t('events.rsvp.maybeCount', { count: counts.maybe }));
  if (counts.waitlisted) parts.push(t('events.rsvp.waitlistCount', { count: counts.waitlisted }));
  return parts.join(' · ');
}
