const crypto = require('crypto');
const db = require('./db');
const { s3Endpoint } = require('./config');
const { PERMISSIONS, has, channelPermissions } = require('./permissions');
const { sendToUserSockets } = require('./sockets');
const { sendPushToUser, getUserImageUrl } = require('./push');
const { ActionError } = require('./actionError');
const { logAudit, diff } = require('./auditLog');
const {
  cleanRule, cleanTimeZone, startsOnRule, nextOccurrence, isOccurrence, occurrenceOnDate, dateKeyIn, addDays,
} = require('./eventRecurrence');

// Scheduled events (Discord's guild events; docs/guilds.md, Events): something happening in a
// voice channel of the guild, or somewhere else, at a time, with who's interested. The actions
// here are shared by the app's routes (routes/guildEvents.js) and the bot API, and throw
// ActionError.
//
// - Seeing an event: a voice channel's needs View Channel there (like everything about the
//   channel); one somewhere else, being in the guild.
// - Create Events makes them (a voice channel's also needs Connect there; both are channel
//   permissions too, as in Discord) and lets their creator edit, start, end and cancel them;
//   Manage Events does that to anyone's.
// - Lifecycle: scheduled -> active -> completed, or cancelled. Every event starts by itself at
//   its time (or earlier by hand: Start; unlike Discord, whose voice events wait for one). One
//   with an end ends by itself then; a voice one without ends once its channel has stayed empty
//   EMPTY_SECONDS after someone was in it, or UNATTENDED_SECONDS after it started if nobody
//   came. All-day ones are on for their whole dates. Any can be ended by hand. Ended and
//   cancelled events are deleted; a repeating one moves on to its next occurrence instead
//   (eventRecurrence.js). An occurrence that took place is kept a year in guild_event_history
//   for the calendar. Whoever's interested is told when one starts (not an all-day one's
//   midnight).
// - Occurrences (as iCalendar's): a repeating event is one row, the series, whose start_time /
//   end_time are its current occurrence's. Every occurrence is named by its `original_start`,
//   when the rule puts it; the ones still to come that differ (moved, renamed..., cancelled) are
//   guild_event_occurrences rows. Changing "this and following" ends the series there (`until`)
//   and makes a new one from then on (`continued_as`); old links follow it once the old one ends
//   (guild_event_redirects).
// - Interest: in the whole series (guild_event_users), and per occurrence where it differs
//   (guild_event_occurrence_users: in it alone, or in all but it). `user_count`, who's listed
//   and who's notified are for the current occurrence unless an occurrence is asked for.

const MAX_NAME = 100;
const MAX_DESCRIPTION = 1000;
const MAX_LOCATION = 100;
const MAX_EMOJI_LENGTH = 64; // as reactions'
const MAX_IMAGE = 1000;
const MAX_EVENTS_PER_GUILD = 100;
// Changed or cancelled occurrences still to come, per series.
const MAX_EXCEPTIONS = 50;
const MAX_AHEAD_SECONDS = 5 * 366 * 86400;
const UNATTENDED_SECONDS = 12 * 3600;
const EMPTY_SECONDS = 5 * 60;
const SWEEP_MS = 15 * 1000;
const MAX_IMAGE_UPLOAD_BYTES = 8 * 1024 * 1024;
// How long occurrences that happened are kept, and the longest stretch asked for at once.
const HISTORY_SECONDS = 366 * 86400;
const MAX_HISTORY_RANGE = 100 * 86400;
// How many occurrences we step through looking for one (five years of a daily event).
const MAX_STEPS = 2000;

const ENTITY_TYPES = ['voice', 'external'];

const now = () => Math.floor(Date.now() / 1000);
const badRequest = (message) => new ActionError(400, message);
const forbidden = () => new ActionError(403, "You don't have permission to do that");
const notFound = () => new ActionError(404, 'Event not found', 10070);

const EVENT_COLUMNS = `id, guild_id, channel_id, creator_id, name, description, entity_type, location, start_time,
  end_time, status, image, recurrence, timezone, occurrence_start, duration, started_at, created_at, updated_at, all_day, emoji, color,
  until, continued_as, revision`;
const EXCEPTION_COLUMNS = 'event_id, original_start, start_time, end_time, status, name, description, location';

// ---- Reading ----

async function getEvent(id) {
  if (!Number.isInteger(id)) return null;
  return db.get(`SELECT ${EVENT_COLUMNS} FROM guild_events WHERE id = ?`, [id]);
}

// Event `id`, or the series that continued it if it has ended since ("this and following").
async function resolveEvent(id) {
  let event = await getEvent(id);
  for (let hops = 0; !event && Number.isInteger(id) && hops < 10; hops++) {
    const redirect = await db.get('SELECT new_id FROM guild_event_redirects WHERE old_id = ?', [id]);
    if (!redirect) break;
    id = redirect.new_id;
    event = await getEvent(id);
  }
  return event ?? null;
}

// A changed or cancelled occurrence as clients get it.
const publicException = (row) => ({
  original_start: row.original_start,
  start_time: row.start_time,
  end_time: row.end_time,
  status: row.status,
  name: row.name,
  description: row.description,
  location: row.location,
});

// What clients get: the row with `recurrence` parsed, `user_count` (how many are interested in
// the current occurrence) and `occurrences`, the changed or cancelled ones still to come.
function publicEvent(row, userCount = 0, exceptions = []) {
  return {
    id: row.id,
    guild_id: row.guild_id,
    channel_id: row.channel_id,
    creator_id: row.creator_id,
    name: row.name,
    description: row.description,
    entity_type: row.entity_type,
    location: row.location,
    start_time: row.start_time,
    end_time: row.end_time,
    status: row.status,
    image: row.image,
    recurrence: row.recurrence ? JSON.parse(row.recurrence) : null,
    timezone: row.timezone,
    occurrence_start: row.occurrence_start,
    duration: row.duration,
    until: row.until ?? null,
    continued_as: row.continued_as ?? null,
    revision: row.revision ?? 0,
    occurrences: exceptions.map(publicException),
    all_day: Boolean(row.all_day),
    emoji: row.emoji ?? null,
    color: row.color ?? null,
    started_at: row.started_at,
    created_at: row.created_at,
    user_count: userCount,
  };
}

// The changed and cancelled occurrences of the events: Map of event id -> rows, soonest first.
async function exceptionsFor(ids) {
  const map = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return map;
  const rows = await db.all(
    `SELECT ${EXCEPTION_COLUMNS} FROM guild_event_occurrences WHERE event_id IN (${ids.map(() => '?').join(',')}) ORDER BY original_start`,
    ids
  );
  for (const row of rows) map.get(row.event_id)?.push(row);
  return map;
}

// One event's, by original start.
async function exceptionMap(eventId) {
  return new Map(((await exceptionsFor([eventId])).get(eventId) ?? []).map((r) => [r.original_start, r]));
}

// SQL for who's interested in occurrences `pairs` ([[event id, original start]]; the original
// is ignored for an event that doesn't repeat): a `who` table (event_id, user_id, created_at)
// to select from, and its params. The series' people, but those not coming to that one, and
// those coming to it alone.
function whoQuery(pairs) {
  return {
    cte: `WITH occ(event_id, original) AS (VALUES ${pairs.map(() => '(?, ?)').join(', ')}),
      who AS (
        SELECT event_id, user_id, MIN(created_at) AS created_at FROM (
          SELECT u.event_id, u.user_id, u.created_at FROM guild_event_users u JOIN occ ON occ.event_id = u.event_id
           WHERE NOT EXISTS (SELECT 1 FROM guild_event_occurrence_users x WHERE x.event_id = u.event_id AND x.user_id = u.user_id
             AND x.original_start = occ.original AND x.interested = 0)
          UNION ALL
          SELECT x.event_id, x.user_id, x.created_at FROM guild_event_occurrence_users x
           JOIN occ ON occ.event_id = x.event_id AND x.original_start = occ.original WHERE x.interested = 1
        ) GROUP BY event_id, user_id
      )`,
    params: pairs.flatMap(([id, original]) => [id, original ?? -1]),
  };
}

// How many are interested in each event's current occurrence (rows), or in `original` of one.
async function userCounts(events, original = undefined) {
  if (!events.length) return new Map();
  const { cte, params } = whoQuery(events.map((e) => [e.id, original !== undefined ? original : e.occurrence_start]));
  const rows = await db.all(`${cte} SELECT event_id, COUNT(*) AS count FROM who GROUP BY event_id`, params);
  return new Map(rows.map((r) => [r.event_id, r.count]));
}

async function loadPublic(id) {
  const row = await getEvent(id);
  if (!row) return null;
  return publicEvent(row, (await userCounts([row])).get(row.id) ?? 0, (await exceptionsFor([row.id])).get(row.id));
}

// The permissions that apply to `event` for `member`: its voice channel's (null if they can't
// see it, or it's gone), or the guild's.
async function eventPermissions(member, event) {
  if (event.channel_id == null) return member.permissions;
  const { getOverrides } = require('./guilds');
  const channel = await db.get('SELECT id, type FROM guild_channels WHERE id = ? AND guild_id = ?', [event.channel_id, event.guild_id]);
  if (!channel) return null;
  const overrides = (await getOverrides({ channelIds: [channel.id] })).get(channel.id) ?? [];
  const permissions = channelPermissions(member, member.userId, overrides);
  return has(permissions, PERMISSIONS.VIEW_CHANNEL) ? permissions : null;
}

// { event, member, permissions } for event `eventId` (or the series continuing it) as `userId`
// sees it, or null (not in its guild, or can't see it).
async function eventAccess(eventId, userId) {
  const event = await resolveEvent(eventId);
  if (!event) return null;
  const member = await require('./guilds').getMember(event.guild_id, userId);
  if (!member) return null;
  const permissions = await eventPermissions(member, event);
  return permissions == null ? null : { event, member, permissions };
}

// Whether the member whose `permissions` (eventPermissions) these are may change `event`.
function canManage(member, event, permissions) {
  return has(permissions, PERMISSIONS.MANAGE_EVENTS) ||
    (event.creator_id === member.userId && has(permissions, PERMISSIONS.CREATE_EVENTS));
}

// Which of the guild's events (rows, or history rows) `member` can see: a filter.
async function visibleFilter(member) {
  const { getOverrides } = require('./guilds');
  const overrides = await getOverrides({ guildId: member.guild.id });
  const channels = new Set((await db.all("SELECT id FROM guild_channels WHERE guild_id = ? AND type = 'voice'", [member.guild.id])).map((c) => c.id));
  return (e) => e.channel_id == null || (channels.has(e.channel_id) &&
    has(channelPermissions(member, member.userId, overrides.get(e.channel_id) ?? []), PERMISSIONS.VIEW_CHANNEL));
}

// How interested someone is in `event` (a row): `interested_all` in the series (`inSeries`),
// `my_occurrences` { original start: interested } where an occurrence differs (`overrides`,
// guild_event_occurrence_users rows), and `interested` in the current occurrence.
function interestState(event, inSeries, overrides = []) {
  const mine = {};
  for (const o of overrides) if (o.original_start >= (event.occurrence_start ?? Infinity)) mine[o.original_start] = Boolean(o.interested);
  const current = event.occurrence_start;
  return {
    interested: current != null && current in mine ? mine[current] : inSeries,
    interested_all: inSeries,
    my_occurrences: mine,
  };
}

// Whether that state (interestState) is interested in occurrence `original`.
const interestedIn = (state, original) => (original != null && original in state.my_occurrences ? state.my_occurrences[original] : state.interested_all);

// The events of the guild `member` can see, soonest first, each with their interestState.
async function listEvents(member) {
  const rows = await db.all(`SELECT ${EVENT_COLUMNS} FROM guild_events WHERE guild_id = ? ORDER BY start_time, id`, [member.guild.id]);
  if (!rows.length) return [];
  const visible = rows.filter(await visibleFilter(member));
  const ids = visible.map((e) => e.id);
  if (!ids.length) return [];
  const counts = await userCounts(visible);
  const exceptions = await exceptionsFor(ids);
  const marks = ids.map(() => '?').join(',');
  const series = new Set((await db.all(
    `SELECT event_id FROM guild_event_users WHERE user_id = ? AND event_id IN (${marks})`, [member.userId, ...ids]
  )).map((r) => r.event_id));
  const overrides = await db.all(
    `SELECT event_id, original_start, interested FROM guild_event_occurrence_users WHERE user_id = ? AND event_id IN (${marks})`,
    [member.userId, ...ids]
  );
  return visible.map((e) => ({
    ...publicEvent(e, counts.get(e.id) ?? 0, exceptions.get(e.id)),
    ...interestState(e, series.has(e.id), overrides.filter((o) => o.event_id === e.id)),
  }));
}

// `userId`'s interestState for `event` (a row).
async function interestOf(event, userId) {
  const inSeries = Boolean(await db.get('SELECT 1 AS yes FROM guild_event_users WHERE event_id = ? AND user_id = ?', [event.id, userId]));
  const overrides = await db.all(
    'SELECT original_start, interested FROM guild_event_occurrence_users WHERE event_id = ? AND user_id = ?', [event.id, userId]
  );
  return interestState(event, inSeries, overrides);
}

// Who's interested in the current occurrence of `eventId`, or in `occurrence` (an original
// start) ({ user_id, created_at }, by user id), `limit` after user id `after` or before user id
// `before` (the bot API pages by user id, as Discord does).
async function interestedUsers(eventId, { limit = 100, after = null, before = null, occurrence = undefined } = {}) {
  const event = await getEvent(eventId);
  if (!event) return [];
  const { cte, params } = whoQuery([[event.id, occurrence !== undefined ? occurrence : event.occurrence_start]]);
  const where = ['1'];
  if (after != null) {
    where.push('user_id > ?');
    params.push(after);
  }
  if (before != null) {
    where.push('user_id < ?');
    params.push(before);
  }
  const rows = await db.all(
    `${cte} SELECT user_id, created_at FROM who WHERE ${where.join(' AND ')}
     ORDER BY user_id ${before != null && after == null ? 'DESC' : ''} LIMIT ?`,
    [...params, limit]
  );
  return rows.map((r) => ({ user_id: r.user_id, created_at: r.created_at })).sort((a, b) => a.user_id - b.user_id);
}

// ---- Occurrences ----

const ruleOf = (event) => JSON.parse(event.recurrence);

// The occurrence of a repeating `event` after the one the rule puts at `original` (unix s), up
// to the series' `until`: its original start, or null.
function followingOriginal(event, original) {
  const next = nextOccurrence(ruleOf(event), event.timezone || 'UTC', original);
  return next != null && (event.until == null || next < event.until) ? next : null;
}

// When occurrence `original` happens: { start, end } (the current one's are the event's own;
// `exception` is its guild_event_occurrences row, if any).
function timesOf(event, original, exception = null) {
  if (original === event.occurrence_start) return { start: event.start_time, end: event.end_time };
  if (exception?.start_time != null) return { start: exception.start_time, end: exception.end_time };
  return { start: original, end: occurrenceEnd(event, original) };
}

// Throws unless `original` is an occurrence of `event` still to come (the current one or
// later, before `until`).
function checkOriginal(event, original) {
  if (!event.recurrence) throw badRequest("That event doesn't repeat");
  if (!Number.isInteger(original) || original < event.occurrence_start || (event.until != null && original >= event.until) ||
    !isOccurrence(ruleOf(event), event.timezone || 'UTC', event.occurrence_start, original)) {
    throw badRequest("That isn't one of the event's dates");
  }
}

// The occurrences either side of `original` that will happen: { prev, next } start times (or
// null), so a moved one stays between them.
function neighbours(event, original, exceptions) {
  let prev = null;
  let at = event.occurrence_start;
  for (let steps = 0; at != null && at < original && steps < MAX_STEPS; steps++) {
    if (exceptions.get(at)?.status !== 'canceled') prev = at;
    at = followingOriginal(event, at);
  }
  let next = followingOriginal(event, original);
  for (let steps = 0; next != null && exceptions.get(next)?.status === 'canceled' && steps < MAX_STEPS; steps++) next = followingOriginal(event, next);
  const startOf = (o) => (o == null ? null : timesOf(event, o, exceptions.get(o)).start);
  return { prev: startOf(prev), next: startOf(next) };
}

// One occurrence of `event` (a row) as asked for in a link or by the app: `occurrence` (its
// original start) or `on` (its date, 'YYYY-MM-DD' in the event's time zone). Still to come:
// { original_start, start_time, end_time, status, name, description, location, user_count }
// with its own values; cancelled: { original_start, status: 'canceled' }; one that took place
// (from the history): that record; none on that date: null.
async function occurrenceDetail(event, { occurrence = null, on = null } = {}) {
  if (!event.recurrence) return null;
  const zone = event.timezone || 'UTC';
  let original = Number.isInteger(occurrence) ? occurrence : null;
  if (original == null && on != null) {
    const past = await db.all('SELECT * FROM guild_event_history WHERE event_id = ? ORDER BY start_time', [event.id]);
    const record = past.find((h) => dateKeyIn(h.original_start ?? h.start_time, h.timezone || zone) === on);
    if (record) return publicHistory(record);
    original = occurrenceOnDate(ruleOf(event), zone, event.occurrence_start, on);
  }
  if (original == null) return null;
  try {
    checkOriginal(event, original);
  } catch {
    return null;
  }
  const exception = await db.get(`SELECT ${EXCEPTION_COLUMNS} FROM guild_event_occurrences WHERE event_id = ? AND original_start = ?`, [event.id, original]);
  if (exception?.status === 'canceled') return { original_start: original, status: 'canceled' };
  const { start, end } = timesOf(event, original, exception);
  return {
    original_start: original,
    start_time: start,
    end_time: end,
    status: original === event.occurrence_start ? event.status : 'scheduled',
    name: exception?.name ?? null,
    description: exception?.description ?? null,
    location: exception?.location ?? null,
    user_count: (await userCounts([event], original)).get(event.id) ?? 0,
  };
}

// ---- Telling people ----

// Who can see `event`: user ids.
async function viewersOf(event) {
  const { getChannelViewers, getMemberIds } = require('./guilds');
  if (event.channel_id == null) return getMemberIds(event.guild_id);
  const channel = await db.get('SELECT id, guild_id FROM guild_channels WHERE id = ?', [event.channel_id]);
  return channel ? getChannelViewers(channel) : [];
}

// Sends `guild_event_<kind>` ('create', 'update' or 'delete') with the event (publicEvent) to
// whoever can see it. `before` (the row before an update): those who could see it then and
// can't now are sent a delete.
async function broadcast(kind, event, before = null) {
  const viewers = await viewersOf(event);
  for (const userId of viewers) sendToUserSockets(userId, { type: `guild_event_${kind}`, guildId: event.guild_id, event });
  if (before && before.channel_id !== event.channel_id) {
    const now_ = new Set(viewers);
    for (const userId of await viewersOf(before)) {
      if (!now_.has(userId)) sendToUserSockets(userId, { type: 'guild_event_delete', guildId: event.guild_id, event });
    }
  }
}

// Tells whoever sees `event` how interested `userId` is now (interestState; not at all by
// default). `changed`: whether that changed who's interested in the current occurrence (bots
// are only told then).
async function broadcastInterest(event, userId, state = interestState(event, false), changed = true) {
  const count = (await userCounts([event])).get(event.id) ?? 0;
  for (const viewer of await viewersOf(event)) {
    sendToUserSockets(viewer, {
      type: 'guild_event_interest', guildId: event.guild_id, eventId: event.id, userId,
      interested: state.interested, interestedAll: state.interested_all, occurrences: state.my_occurrences, changed, userCount: count,
    });
  }
}

// Where an event is, in words (for pushes, which the server writes in English like the others).
async function placeOf(event, location = event.location) {
  if (event.entity_type !== 'voice') return location;
  const channel = await db.get('SELECT name FROM guild_channels WHERE id = ?', [event.channel_id]);
  return channel ? `#${channel.name}` : null;
}

// The app's path to `event` (a row): its current occurrence's, for a repeating one.
function eventPath(event) {
  const on = event.recurrence && event.occurrence_start != null ? `&on=${dateKeyIn(event.occurrence_start, event.timezone || 'UTC')}` : '';
  return `/guild/${event.guild_id}${event.channel_id ? `/${event.channel_id}` : ''}?event=${event.id}${on}`;
}

// Tells those interested in `event`'s current occurrence (who can still see it) that it
// started: a push (unless their notification level for the guild is 'none'), never to whoever
// started it.
async function notifyStarted(event, actorId = null) {
  const interested = (await interestedUsers(event.id, { limit: 1000000 })).map((r) => r.user_id);
  if (!interested.length) return;
  const viewers = new Set(await viewersOf(event));
  const recipients = interested.filter((id) => id !== actorId && viewers.has(id));
  if (!recipients.length) return;
  const levels = new Map((await db.all(
    `SELECT user_id, notify_level FROM guild_members WHERE guild_id = ? AND user_id IN (${recipients.map(() => '?').join(',')})`,
    [event.guild_id, ...recipients]
  )).map((r) => [r.user_id, r.notify_level]));
  const guild = await db.get('SELECT name, icon_version FROM guilds WHERE id = ?', [event.guild_id]);
  const own = event.occurrence_start != null
    ? await db.get('SELECT name, location FROM guild_event_occurrences WHERE event_id = ? AND original_start = ?', [event.id, event.occurrence_start])
    : null;
  const place = await placeOf(event, own?.location ?? event.location);
  const payload = {
    type: 'event',
    title: own?.name ?? event.name,
    body: `Starting now${place ? ` · ${place}` : ''} (${guild.name})`,
    url: eventPath(event),
    tag: `event-${event.id}`,
    image: guild.icon_version > 0
      ? `${s3Endpoint}/guild-icons/${event.guild_id}?v=${guild.icon_version}`
      : await getUserImageUrl(event.creator_id),
    timestamp: now(),
  };
  for (const userId of recipients) {
    if (levels.get(userId) === 'none') continue;
    sendPushToUser(userId, payload, { urgency: 'high' }).catch(() => {});
  }
}

// ---- Checking what's sent ----

function cleanText(value, max, field, { required = false } = {}) {
  if (value === undefined) return undefined;
  if (value === null || (typeof value === 'string' && !value.trim())) {
    if (required) throw badRequest(`The ${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw badRequest(`Invalid ${field}`);
  const trimmed = field === 'description' ? value.replace(/\s+$/, '').replace(/^\s*\n/, '') : value.replace(/\s+/g, ' ').trim();
  if (trimmed.length > max) throw badRequest(`The ${field} can be at most ${max} characters`);
  return trimmed;
}

// An emoji (Unicode, or a custom one as '<:name:id>'), checked like a reaction's; null for none.
function cleanEmoji(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_EMOJI_LENGTH || /\s/.test(value)) throw badRequest('Invalid emoji');
  return value;
}

function cleanTime(value, field) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Number.isInteger(value) || value <= 0) throw badRequest(`Invalid ${field}`);
  return value;
}

// An upload of ours (like a document's cover): undefined, null or the URL.
function cleanImage(image) {
  if (image === undefined) return undefined;
  if (image === null || image === '') return null;
  if (typeof image !== 'string' || image.length > MAX_IMAGE || /\s/.test(image) || !image.startsWith(`${s3Endpoint}/uploads/`)) {
    throw badRequest('Invalid cover image');
  }
  return image;
}

// The event as it would be after `input` ({ name, description, entityType, channelId, location,
// startTime, endTime, image, recurrence, timezone, allDay, emoji, color }, each optional when
// `before` is given), checked; throws ActionError. `member` is who's doing it. An all-day event
// runs from a midnight to a later one in `timezone` (the client works them out) and may start
// on a day that has begun, as long as it hasn't ended.
async function checkedFields(member, input, before = null) {
  const fields = {
    name: cleanText(input.name, MAX_NAME, 'name', { required: true }),
    description: cleanText(input.description, MAX_DESCRIPTION, 'description'),
    location: cleanText(input.location, MAX_LOCATION, 'location'),
    start_time: cleanTime(input.startTime, 'start time'),
    end_time: cleanTime(input.endTime, 'end time'),
    image: cleanImage(input.image),
  };
  if (input.entityType !== undefined) {
    if (!ENTITY_TYPES.includes(input.entityType)) throw badRequest('Events are in a voice channel or somewhere else');
    fields.entity_type = input.entityType;
  }
  if (input.channelId !== undefined) fields.channel_id = input.channelId;
  if (input.allDay !== undefined) {
    if (typeof input.allDay !== 'boolean') throw badRequest('Invalid all-day choice');
    fields.all_day = input.allDay ? 1 : 0;
  }
  if (input.color !== undefined) {
    if (input.color !== null && !(Number.isInteger(input.color) && input.color >= 0 && input.color <= 0xffffff)) throw badRequest('Invalid colour');
    fields.color = input.color;
  }
  if (input.emoji !== undefined) fields.emoji = cleanEmoji(input.emoji);
  if (input.timezone !== undefined) {
    fields.timezone = input.timezone == null ? null : cleanTimeZone(input.timezone);
    if (input.timezone != null && !fields.timezone) throw badRequest('Unknown time zone');
  }
  if (input.recurrence !== undefined) {
    if (input.recurrence === null) fields.recurrence = null;
    else {
      const rule = cleanRule(input.recurrence);
      if (!rule) throw badRequest('Events repeat daily, weekly, every other week, monthly or yearly');
      fields.recurrence = JSON.stringify(rule);
    }
  }
  for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key];

  const after = { ...(before ?? {}), ...fields };
  if (!before && after.name == null) throw badRequest('The name is required');
  if (!after.entity_type) throw badRequest('Events are in a voice channel or somewhere else');
  if (after.entity_type === 'voice') {
    after.location = null;
    if (!Number.isInteger(after.channel_id)) throw badRequest('Pick a voice channel');
    const channel = await db.get('SELECT id, type FROM guild_channels WHERE id = ? AND guild_id = ?', [after.channel_id, member.guild.id]);
    if (channel?.type !== 'voice') throw badRequest('Pick a voice channel');
  } else {
    after.channel_id = null;
    after.location = after.location || null; // optional: "somewhere else" may be left unsaid
    if (after.end_time == null) throw badRequest('Events somewhere else need an end time');
  }
  if (!Number.isInteger(after.start_time)) throw badRequest('Invalid start time');
  if (after.all_day) {
    if (after.end_time == null) throw badRequest('All-day events need an end date');
    after.timezone = after.timezone ?? 'UTC';
  }
  const startChanged = !before || after.start_time !== before.start_time;
  if (startChanged && after.status !== 'active') {
    if (after.all_day ? after.end_time <= now() : after.start_time <= now()) throw badRequest('The start time must be in the future');
    if (after.start_time > now() + MAX_AHEAD_SECONDS) throw badRequest('Events can be at most five years ahead');
  }
  if (before?.status === 'active' && startChanged) throw badRequest("A started event's start time can't change");
  if (after.end_time != null && after.end_time <= after.start_time) throw badRequest('The end time must be after the start time');
  if (after.recurrence) {
    after.timezone = after.timezone ?? 'UTC';
    if (!startsOnRule(JSON.parse(after.recurrence), after.start_time, after.timezone)) {
      throw badRequest("The start time isn't one of the days the event repeats on");
    }
  }
  return after;
}

// Throws unless `member` may make an event `fields` describes: Create Events (and in a voice
// channel, seeing and joining it).
async function checkCanCreate(member, fields) {
  if (fields.entity_type === 'voice') {
    const permissions = await eventPermissions(member, { guild_id: member.guild.id, channel_id: fields.channel_id });
    if (permissions == null) throw badRequest('Pick a voice channel');
    if (!has(permissions, PERMISSIONS.CREATE_EVENTS) || !has(permissions, PERMISSIONS.CONNECT)) throw forbidden();
  } else if (!has(member.permissions, PERMISSIONS.CREATE_EVENTS)) {
    throw forbidden();
  }
}

// Links the event to the upload its cover is (uploads.js). Inside the transaction.
async function linkImage(eventId, image) {
  const { linkUploads } = require('./uploads');
  const { uploadKeysIn } = require('./uploadKeys');
  await linkUploads('event', eventId, image ? uploadKeysIn(image) : []);
}

// Inserts an event (`fields`, checkedFields) made by `creatorId`, throwing if the guild has
// as many as it may; resolves to its id. Inside the transaction.
async function insertEvent(guildId, creatorId, fields) {
  const { count } = await db.get('SELECT COUNT(*) AS count FROM guild_events WHERE guild_id = ?', [guildId]);
  if (count >= MAX_EVENTS_PER_GUILD) throw badRequest(`A guild can have at most ${MAX_EVENTS_PER_GUILD} events`);
  const at = now();
  const repeating = Boolean(fields.recurrence);
  const { lastID } = await db.run(
    `INSERT INTO guild_events (guild_id, channel_id, creator_id, name, description, entity_type, location, start_time, end_time,
       status, image, recurrence, timezone, occurrence_start, duration, created_at, updated_at, all_day, emoji, color)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [guildId, fields.channel_id ?? null, creatorId, fields.name, fields.description ?? null, fields.entity_type,
      fields.location ?? null, fields.start_time, fields.end_time ?? null, fields.image ?? null, fields.recurrence ?? null,
      repeating || fields.all_day ? fields.timezone : null, repeating ? fields.start_time : null,
      fields.end_time != null ? fields.end_time - fields.start_time : null, at, at,
      fields.all_day ? 1 : 0, fields.emoji ?? null, fields.color ?? null]
  );
  await linkImage(lastID, fields.image);
  return lastID;
}

// ---- Actions ----

// `member` schedules an event; resolves to it (publicEvent). Its creator is interested.
async function createEvent(member, input) {
  const fields = await checkedFields(member, input);
  await checkCanCreate(member, fields);
  const id = await db.transaction(async () => {
    const lastID = await insertEvent(member.guild.id, member.userId, fields);
    await db.run('INSERT INTO guild_event_users (event_id, user_id, created_at) VALUES (?, ?, ?)', [lastID, member.userId, now()]);
    await logAudit({
      guildId: member.guild.id, actorId: member.userId, action: 'event_create', targetType: 'event', targetId: lastID,
      channelId: fields.channel_id ?? null, details: { name: fields.name },
    });
    return lastID;
  });
  const event = await loadPublic(id);
  await broadcast('create', event);
  return event;
}

// The access (eventAccess) if `member` may change it; throws otherwise.
async function managedAccess(member, eventId) {
  const access = await eventAccess(eventId, member.userId);
  if (!access) throw notFound();
  if (!canManage(member, access.event, access.permissions)) throw forbidden();
  return access;
}

// The single occurrences of event `eventId` from original start `from` on (all of them by
// default) are gone: their changes and who's interested in them alone. Inside the transaction.
async function dropOccurrences(eventId, from = -Infinity) {
  const at = Number.isFinite(from) ? from : -1;
  await db.run('DELETE FROM guild_event_occurrences WHERE event_id = ? AND original_start >= ?', [eventId, at]);
  await db.run('DELETE FROM guild_event_occurrence_users WHERE event_id = ? AND original_start >= ?', [eventId, at]);
}

// What changed, for the audit log: the channel by name, the cover and the repeating as notes.
async function auditChanges(before, after) {
  const changes = diff(before, {
    name: after.name, description: after.description, location: after.location, start_time: after.start_time, end_time: after.end_time,
    all_day: after.all_day, emoji: after.emoji, color: after.color,
  });
  if ((after.channel_id ?? null) !== (before.channel_id ?? null)) {
    const nameOf = async (id) => (id == null ? null : (await db.get('SELECT name FROM guild_channels WHERE id = ?', [id]))?.name ?? null);
    changes.channel = [await nameOf(before.channel_id), await nameOf(after.channel_id)];
  }
  const notes = {};
  if (after.image !== before.image) notes.cover = before.image ? (after.image ? 'changed' : 'removed') : 'added';
  if ((after.recurrence ?? null) !== (before.recurrence ?? null)) notes.repeat = after.recurrence ? 'changed' : 'removed';
  return { changes, notes };
}

// Edits the event: every occurrence of a repeating one, or with `from` (an original start
// after the current occurrence) "this and following" (splitEvent); resolves to it (the new
// series after a split). Moving it to another voice channel needs what creating it there would.
// A new start (or rule) re-anchors the series there, and drops its occurrences' own changes.
async function updateEvent(member, eventId, input, { from = null } = {}) {
  const { event: before } = await managedAccess(member, eventId);
  if (from != null && before.recurrence && from !== before.occurrence_start) return splitEvent(member, before, input, from);
  const after = await checkedFields(member, input, { ...before, recurrence: before.recurrence });
  if (after.channel_id !== before.channel_id || after.entity_type !== before.entity_type) await checkCanCreate(member, after);
  const repeating = Boolean(after.recurrence);
  const retimed = after.start_time !== before.start_time || after.recurrence !== before.recurrence || after.timezone !== before.timezone;
  const occurrenceStart = !repeating ? null : retimed ? after.start_time : before.occurrence_start;
  const duration = after.end_time != null ? after.end_time - after.start_time : null;
  const { changes, notes } = await auditChanges(before, after);
  await db.transaction(async () => {
    await db.run(
      `UPDATE guild_events SET name = ?, description = ?, entity_type = ?, channel_id = ?, location = ?, start_time = ?, end_time = ?,
         image = ?, recurrence = ?, timezone = ?, occurrence_start = ?, duration = ?, all_day = ?, emoji = ?, color = ?, updated_at = ?,
         revision = revision + ?
       WHERE id = ?`,
      [after.name, after.description ?? null, after.entity_type, after.channel_id ?? null, after.location ?? null, after.start_time,
        after.end_time ?? null, after.image ?? null, after.recurrence ?? null, repeating || after.all_day ? after.timezone : null,
        occurrenceStart, duration, after.all_day ? 1 : 0, after.emoji ?? null, after.color ?? null, now(), retimed ? 1 : 0, before.id]
    );
    if (retimed) await dropOccurrences(before.id);
    await linkImage(before.id, after.image);
    if (Object.keys(changes).length || Object.keys(notes).length) {
      await logAudit({
        guildId: before.guild_id, actorId: member.userId, action: 'event_update', targetType: 'event', targetId: before.id,
        channelId: after.channel_id ?? null, details: { name: before.name, changes, ...notes },
      });
    }
  });
  if (after.image !== before.image) require('./uploads').releaseUploads();
  const event = await loadPublic(before.id);
  await broadcast('update', event, before);
  return event;
}

// "This and following": the series `before` (a row) ends before occurrence `from`, and a new
// series, edited by `input`, takes over from there (its first occurrence is `from`'s, or where
// the edit moves it). Who's interested in the series is interested in the new one; occurrences'
// own changes and interest move with it unless its times or rule changed. Resolves to the new
// series.
async function splitEvent(member, before, input, from) {
  checkOriginal(before, from);
  const exceptions = await exceptionMap(before.id);
  const own = exceptions.get(from);
  if (own?.status === 'canceled') throw badRequest('That occurrence was cancelled');
  const { start, end } = timesOf(before, from, own);
  const base = {
    ...before, start_time: start, end_time: end, status: 'scheduled', started_at: null,
    name: own?.name ?? before.name, description: own?.description ?? before.description, location: own?.location ?? before.location,
  };
  const after = await checkedFields(member, input, base);
  if (after.channel_id !== before.channel_id || after.entity_type !== before.entity_type) await checkCanCreate(member, after);
  const keep = Boolean(after.recurrence) && after.start_time === from && after.recurrence === before.recurrence && after.timezone === before.timezone;
  const { changes, notes } = await auditChanges(base, after);
  const id = await db.transaction(async () => {
    const newId = await insertEvent(before.guild_id, before.creator_id, after);
    await db.run(
      'INSERT INTO guild_event_users (event_id, user_id, created_at) SELECT ?, user_id, created_at FROM guild_event_users WHERE event_id = ?',
      [newId, before.id]
    );
    // `from`'s own changes are the new series' values now.
    await db.run('DELETE FROM guild_event_occurrences WHERE event_id = ? AND original_start = ?', [before.id, from]);
    if (keep) {
      await db.run('UPDATE guild_event_occurrences SET event_id = ? WHERE event_id = ? AND original_start >= ?', [newId, before.id, from]);
      await db.run('UPDATE guild_event_occurrence_users SET event_id = ? WHERE event_id = ? AND original_start >= ?', [newId, before.id, from]);
    }
    await dropOccurrences(before.id, from);
    await db.run('UPDATE guild_events SET until = ?, continued_as = ?, updated_at = ? WHERE id = ?', [from, newId, now(), before.id]);
    await logAudit({
      guildId: before.guild_id, actorId: member.userId, action: 'event_update', targetType: 'event', targetId: before.id,
      channelId: before.channel_id ?? null, details: { name: before.name, changes: {}, repeat: 'split' },
    });
    await logAudit({
      guildId: before.guild_id, actorId: member.userId, action: 'event_create', targetType: 'event', targetId: newId,
      channelId: after.channel_id ?? null, details: { name: after.name, ...(Object.keys(changes).length ? { changes } : {}), ...notes },
    });
    return newId;
  });
  // The old one first: apps carry the viewer's interest over to the one it's `continued_as`.
  await broadcast('update', await loadPublic(before.id));
  const event = await loadPublic(id);
  await broadcast('create', event);
  return event;
}

// Starts a scheduled event now (whatever its start time).
async function startEvent(member, eventId) {
  const { event } = await managedAccess(member, eventId);
  if (event.status !== 'scheduled') throw badRequest('That event has already started');
  return activate(event, member.userId);
}

// Ends an active event.
async function endEvent(member, eventId) {
  const { event } = await managedAccess(member, eventId);
  if (event.status !== 'active') throw badRequest("That event hasn't started");
  return finish(event, 'completed');
}

// Cancels an event (every occurrence of a repeating one), or deletes an active one: it's gone.
async function cancelEvent(member, eventId) {
  const { event } = await managedAccess(member, eventId);
  await db.transaction(() => logAudit({
    guildId: event.guild_id, actorId: member.userId, action: 'event_delete', targetType: 'event', targetId: event.id,
    channelId: event.channel_id, details: { name: event.name },
  }));
  await remove(event, 'canceled', 'delete');
}

// A repeating event: cancels occurrence `from` (an original start) and every one after it
// ("this and following"); from the current one, that's the whole event. Resolves to the
// event, or null once it's gone.
async function cancelFollowing(member, eventId, from) {
  const { event } = await managedAccess(member, eventId);
  if (!event.recurrence) throw badRequest("That event doesn't repeat");
  if (from === event.occurrence_start) {
    await cancelEvent(member, eventId);
    return null;
  }
  checkOriginal(event, from);
  await db.transaction(async () => {
    await dropOccurrences(event.id, from);
    await db.run('UPDATE guild_events SET until = ?, continued_as = NULL, updated_at = ? WHERE id = ?', [from, now(), event.id]);
    await logAudit({
      guildId: event.guild_id, actorId: member.userId, action: 'event_update', targetType: 'event', targetId: event.id,
      channelId: event.channel_id, details: { name: event.name, changes: {}, repeat: 'shortened' },
    });
  });
  const updated = await loadPublic(event.id);
  await broadcast('update', updated);
  return updated;
}

// Throws if the series already has as many changed occurrences as it may (and `original`
// isn't one of them).
async function checkExceptionRoom(event, original) {
  const { count } = await db.get(
    'SELECT COUNT(*) AS count FROM guild_event_occurrences WHERE event_id = ? AND original_start != ?', [event.id, original]
  );
  if (count >= MAX_EXCEPTIONS) throw badRequest(`An event can have at most ${MAX_EXCEPTIONS} dates changed or cancelled`);
}

// A repeating event: cancels one occurrence (`occurrence`, an original start; the current one
// by default, which moves the event on to the next).
async function skipOccurrence(member, eventId, { occurrence = null } = {}) {
  const { event } = await managedAccess(member, eventId);
  if (!event.recurrence) throw badRequest("That event doesn't repeat");
  const original = occurrence ?? event.occurrence_start;
  checkOriginal(event, original);
  if (original === event.occurrence_start) {
    if (event.status !== 'scheduled') throw badRequest('That event has already started');
    return advance(event);
  }
  await checkExceptionRoom(event, original);
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO guild_event_occurrences (event_id, original_start, status) VALUES (?, ?, 'canceled')
       ON CONFLICT (event_id, original_start) DO UPDATE SET status = 'canceled', start_time = NULL, end_time = NULL,
         name = NULL, description = NULL, location = NULL`,
      [event.id, original]
    );
    await db.run('DELETE FROM guild_event_occurrence_users WHERE event_id = ? AND original_start = ?', [event.id, original]);
  });
  const updated = await loadPublic(event.id);
  await broadcast('update', updated);
  return updated;
}

// A repeating event: changes one occurrence (`occurrence`, an original start; the current one
// by default) and not the series: { startTime, endTime } move it (between the occurrences
// either side), and `name`, `description`, `location` (somewhere else) are its own (the
// series' again when they're the same, or null).
async function moveOccurrence(member, eventId, { occurrence = null, startTime, endTime, name, description, location } = {}) {
  const { event } = await managedAccess(member, eventId);
  if (!event.recurrence) throw badRequest("That event doesn't repeat");
  const original = occurrence ?? event.occurrence_start;
  checkOriginal(event, original);
  const current = original === event.occurrence_start;
  if (current && event.status !== 'scheduled') throw badRequest('That event has already started');
  const exceptions = await exceptionMap(event.id);
  const exception = exceptions.get(original) ?? null;
  if (exception?.status === 'canceled') throw badRequest('That occurrence was cancelled');
  let { start, end } = timesOf(event, original, exception);
  if (startTime !== undefined) {
    start = cleanTime(startTime, 'start time');
    end = endTime === undefined ? (start == null ? null : occurrenceEnd(event, start)) : cleanTime(endTime, 'end time');
  } else if (endTime !== undefined) {
    end = cleanTime(endTime, 'end time');
  }
  if (start == null || (event.all_day ? end <= now() : start <= now())) throw badRequest('The start time must be in the future');
  if (end != null && end <= start) throw badRequest('The end time must be after the start time');
  if (event.entity_type === 'external' && end == null) throw badRequest('Events somewhere else need an end time');
  const { prev, next } = neighbours(event, original, exceptions);
  if (prev != null && start <= prev) throw badRequest('This occurrence must start after the one before it');
  if (next != null && start >= next) throw badRequest('This occurrence must start before the next one');
  // Its own text, or null where it's the series'.
  const ownText = (value, max, field, base) => {
    const cleaned = cleanText(value, max, field, { required: field === 'name' });
    const text = cleaned === undefined ? exception?.[field] ?? null : cleaned;
    return text === (base ?? null) ? null : text;
  };
  const ownName = ownText(name, MAX_NAME, 'name', event.name);
  const ownDescription = ownText(description, MAX_DESCRIPTION, 'description', event.description);
  const ownLocation = event.entity_type === 'external' ? ownText(location, MAX_LOCATION, 'location', event.location) : null;
  const moved = start !== original || end !== occurrenceEnd(event, original);
  if (!exception && (moved || ownName != null || ownDescription != null || ownLocation != null)) await checkExceptionRoom(event, original);
  await db.transaction(async () => {
    if (!moved && ownName == null && ownDescription == null && ownLocation == null) {
      await db.run('DELETE FROM guild_event_occurrences WHERE event_id = ? AND original_start = ?', [event.id, original]);
    } else {
      await db.run(
        `INSERT INTO guild_event_occurrences (event_id, original_start, start_time, end_time, status, name, description, location)
         VALUES (?, ?, ?, ?, 'scheduled', ?, ?, ?)
         ON CONFLICT (event_id, original_start) DO UPDATE SET start_time = excluded.start_time, end_time = excluded.end_time,
           status = 'scheduled', name = excluded.name, description = excluded.description, location = excluded.location`,
        [event.id, original, moved ? start : null, moved ? end : null, ownName, ownDescription, ownLocation]
      );
    }
    if (current) await db.run('UPDATE guild_events SET start_time = ?, end_time = ?, updated_at = ? WHERE id = ?', [start, end, now(), event.id]);
  });
  const updated = await loadPublic(event.id);
  await broadcast('update', updated, event);
  return updated;
}

// `member` is (or isn't) interested in the event: the whole series (`occurrence` null), or one
// occurrence ('current', or an original start; the same thing for one that doesn't repeat).
// Interest in the series replaces any in single occurrences. Resolves to their interestState,
// with `interested` for the occurrence asked about.
async function setInterest(member, eventId, interested, { occurrence = null } = {}) {
  const access = await eventAccess(eventId, member.userId);
  if (!access) throw notFound();
  const { event } = access;
  const { userId } = member;
  const before = await interestOf(event, userId);
  const original = event.occurrence_start == null ? null : occurrence === 'current' ? event.occurrence_start : occurrence;
  if (original == null) {
    await db.transaction(async () => {
      if (interested) {
        await db.run('INSERT OR IGNORE INTO guild_event_users (event_id, user_id, created_at) VALUES (?, ?, ?)', [event.id, userId, now()]);
      } else {
        await db.run('DELETE FROM guild_event_users WHERE event_id = ? AND user_id = ?', [event.id, userId]);
      }
      await db.run('DELETE FROM guild_event_occurrence_users WHERE event_id = ? AND user_id = ?', [event.id, userId]);
    });
  } else {
    checkOriginal(event, original);
    const cancelled = await db.get(
      "SELECT 1 AS yes FROM guild_event_occurrences WHERE event_id = ? AND original_start = ? AND status = 'canceled'", [event.id, original]
    );
    if (cancelled) throw badRequest('That occurrence was cancelled');
    if (interested === before.interested_all) {
      await db.run('DELETE FROM guild_event_occurrence_users WHERE event_id = ? AND user_id = ? AND original_start = ?', [event.id, userId, original]);
    } else {
      await db.run(
        `INSERT INTO guild_event_occurrence_users (event_id, user_id, original_start, interested, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (event_id, user_id, original_start) DO UPDATE SET interested = excluded.interested`,
        [event.id, userId, original, interested ? 1 : 0, now()]
      );
    }
  }
  const after = await interestOf(event, userId);
  const unchanged = after.interested === before.interested && after.interested_all === before.interested_all &&
    JSON.stringify(after.my_occurrences) === JSON.stringify(before.my_occurrences);
  if (!unchanged) await broadcastInterest(event, userId, after, after.interested !== before.interested);
  return { ...after, interested: original == null ? after.interested : interestedIn(after, original) };
}

// ---- Moving through the lifecycle ----

// When an occurrence starting at `start` ends: as many whole days on for an all-day event (a
// clock change doesn't move its midnight), else `duration` later.
function occurrenceEnd(event, start) {
  if (event.duration == null) return null;
  if (!event.all_day) return start + event.duration;
  return addDays(start, Math.max(1, Math.round(event.duration / 86400)), event.timezone || 'UTC');
}

async function activate(event, actorId = null) {
  await db.run("UPDATE guild_events SET status = 'active', started_at = ?, updated_at = ? WHERE id = ?", [now(), now(), event.id]);
  forgetPresence(event.id);
  const updated = await loadPublic(event.id);
  await broadcast('update', updated);
  // An all-day event somewhere else starts by itself at midnight: no push then.
  if (!(event.all_day && actorId == null)) notifyStarted(event, actorId).catch((err) => console.error('Event notification failed:', err.message));
  return updated;
}

// Deletes the event; whoever saw it is sent it with `status` ('completed' or 'canceled'), as
// `kind` ('update', as Discord does when one ends, or 'delete'). Links to one that "this and
// following" continued go to the series that did.
async function remove(event, status, kind) {
  const last = { ...(await loadPublic(event.id)), status };
  await db.transaction(async () => {
    await db.run('DELETE FROM guild_event_users WHERE event_id = ?', [event.id]);
    await dropOccurrences(event.id);
    await db.run('DELETE FROM guild_events WHERE id = ?', [event.id]);
    if (event.continued_as != null && await getEvent(event.continued_as)) {
      await db.run('INSERT OR REPLACE INTO guild_event_redirects (old_id, new_id) VALUES (?, ?)', [event.id, event.continued_as]);
      await db.run('UPDATE guild_event_redirects SET new_id = ? WHERE new_id = ?', [event.continued_as, event.id]);
    } else {
      await db.run('DELETE FROM guild_event_redirects WHERE new_id = ?', [event.id]);
    }
  });
  forgetPresence(event.id);
  require('./uploads').releaseUploads();
  await broadcast(kind, last);
  return last;
}

// A repeating event moves on to its next occurrence still to come (scheduled again, the same
// people interested in the series), past cancelled ones; one that has none left (or doesn't
// repeat) is deleted.
async function advance(event) {
  const exceptions = await exceptionMap(event.id);
  // Past ones are skipped (an all-day one still on today isn't: it has begun but not ended).
  const over = (original) => {
    const { start, end } = timesOf(event, original, exceptions.get(original));
    return (event.all_day ? end ?? start : start) <= now();
  };
  let next = followingOriginal(event, event.occurrence_start);
  for (let steps = 0; next != null && (exceptions.get(next)?.status === 'canceled' || over(next)); steps++) {
    next = steps < MAX_STEPS ? followingOriginal(event, next) : null;
  }
  if (next == null) return remove(event, 'completed', 'update');
  const { start, end } = timesOf(event, next, exceptions.get(next));
  await db.transaction(async () => {
    await db.run(
      `UPDATE guild_events SET status = 'scheduled', started_at = NULL, start_time = ?, end_time = ?, occurrence_start = ?, updated_at = ?
       WHERE id = ?`,
      [start, end, next, now(), event.id]
    );
    await db.run('DELETE FROM guild_event_occurrences WHERE event_id = ? AND original_start < ?', [event.id, next]);
    await db.run('DELETE FROM guild_event_occurrence_users WHERE event_id = ? AND original_start < ?', [event.id, next]);
  });
  forgetPresence(event.id);
  const updated = await loadPublic(event.id);
  await broadcast('update', updated);
  return updated;
}

// The occurrence is over (`status`: 'completed', or 'canceled' if it never started). One that
// took place is recorded first.
async function finish(event, status) {
  if (event.status === 'active') await recordHistory(event);
  if (event.recurrence) return advance(event);
  return remove(event, status, 'update');
}

// ---- History ----

// An occurrence that took place, as clients get it: like an event (publicEvent's fields, its
// id the event's), with `status` 'completed' and its `original_start`.
function publicHistory(row) {
  return {
    id: row.event_id,
    guild_id: row.guild_id,
    channel_id: row.channel_id,
    creator_id: row.creator_id,
    name: row.name,
    description: row.description,
    entity_type: row.entity_type,
    location: row.location,
    start_time: row.start_time,
    end_time: row.end_time,
    status: 'completed',
    recurrence: row.recurrence ? JSON.parse(row.recurrence) : null,
    timezone: row.timezone,
    original_start: row.original_start,
    all_day: Boolean(row.all_day),
    emoji: row.emoji ?? null,
    color: row.color ?? null,
    user_count: row.user_count,
  };
}

// Keeps what `event`'s current occurrence was as it ends (its own name and place, when it
// started and ended, how many were interested), and forgets those over a year old.
async function recordHistory(event) {
  const own = event.occurrence_start != null
    ? await db.get(`SELECT ${EXCEPTION_COLUMNS} FROM guild_event_occurrences WHERE event_id = ? AND original_start = ?`, [event.id, event.occurrence_start])
    : null;
  const count = (await userCounts([event])).get(event.id) ?? 0;
  const at = now();
  // Where it sits on the calendar: its dates all day; else from when it started (Start may be
  // early) to its end, or now if it ended sooner or had none.
  const start = event.all_day ? event.start_time : Math.min(event.start_time, event.started_at ?? event.start_time);
  const end = event.all_day ? event.end_time : Math.max(start + 60, event.end_time != null && event.end_time <= at ? event.end_time : at);
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO guild_event_history (guild_id, event_id, original_start, channel_id, creator_id, name, description, entity_type,
         location, start_time, end_time, all_day, timezone, recurrence, emoji, color, user_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.guild_id, event.id, event.occurrence_start ?? null, event.channel_id ?? null, event.creator_id, own?.name ?? event.name,
        own?.description ?? event.description ?? null, event.entity_type, own?.location ?? event.location ?? null, start, end,
        event.all_day ? 1 : 0, event.timezone ?? null, event.recurrence ?? null, event.emoji ?? null, event.color ?? null, count]
    );
    await db.run('DELETE FROM guild_event_history WHERE end_time < ?', [at - HISTORY_SECONDS]);
  });
}

// The occurrences that took place between unix s `from` and `to` (at most MAX_HISTORY_RANGE
// apart) that `member` can see (publicHistory), soonest first.
async function listHistory(member, from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from || to - from > MAX_HISTORY_RANGE) throw badRequest('Invalid range');
  const rows = await db.all(
    'SELECT * FROM guild_event_history WHERE guild_id = ? AND start_time < ? AND end_time > ? ORDER BY start_time, id',
    [member.guild.id, to, from]
  );
  return rows.filter(await visibleFilter(member)).map(publicHistory);
}

// ---- Clean-up ----

// Every event of the channels (an SQL list of ids, as deleteChannelContents takes them), who
// was interested, and what took place there. Inside the transaction.
async function deleteChannelEvents(channelIdsSql, params) {
  const events = `SELECT id FROM guild_events WHERE channel_id IN (${channelIdsSql})`;
  await db.run(`DELETE FROM guild_event_users WHERE event_id IN (${events})`, params);
  await db.run(`DELETE FROM guild_event_occurrences WHERE event_id IN (${events})`, params);
  await db.run(`DELETE FROM guild_event_occurrence_users WHERE event_id IN (${events})`, params);
  await db.run(`DELETE FROM guild_events WHERE channel_id IN (${channelIdsSql})`, params);
  await db.run(`DELETE FROM guild_event_history WHERE channel_id IN (${channelIdsSql})`, params);
}

// Every event of the guild. Inside the transaction.
async function deleteGuildEvents(guildId) {
  const events = 'SELECT id FROM guild_events WHERE guild_id = ?';
  await db.run(`DELETE FROM guild_event_users WHERE event_id IN (${events})`, [guildId]);
  await db.run(`DELETE FROM guild_event_occurrences WHERE event_id IN (${events})`, [guildId]);
  await db.run(`DELETE FROM guild_event_occurrence_users WHERE event_id IN (${events})`, [guildId]);
  await db.run(`DELETE FROM guild_event_redirects WHERE new_id IN (${events})`, [guildId]);
  await db.run('DELETE FROM guild_events WHERE guild_id = ?', [guildId]);
  await db.run('DELETE FROM guild_event_history WHERE guild_id = ?', [guildId]);
}

// The events (publicEvent) of the channel, before it's deleted: to tell people afterwards.
async function channelEvents(channelId) {
  const rows = await db.all(`SELECT ${EVENT_COLUMNS} FROM guild_events WHERE channel_id = ?`, [channelId]);
  return rows.map((r) => publicEvent(r));
}

// Tells the guild that these events (channelEvents) went with their channel.
async function announceDeleted(guildId, events) {
  if (!events.length) return;
  const { sendToGuild } = require('./guilds');
  for (const event of events) await sendToGuild(guildId, { type: 'guild_event_delete', guildId, event: { ...event, status: 'canceled' } });
}

// Someone leaving the guild stops being interested in its events. Inside the transaction;
// resolves to the events (rows) they were interested in.
async function forgetMember(guildId, userId) {
  const events = await db.all(
    `SELECT ${EVENT_COLUMNS} FROM guild_events WHERE guild_id = ? AND (id IN (SELECT event_id FROM guild_event_users WHERE user_id = ?)
       OR id IN (SELECT event_id FROM guild_event_occurrence_users WHERE user_id = ?))`,
    [guildId, userId, userId]
  );
  if (events.length) {
    for (const table of ['guild_event_users', 'guild_event_occurrence_users']) {
      await db.run(`DELETE FROM ${table} WHERE user_id = ? AND event_id IN (SELECT id FROM guild_events WHERE guild_id = ?)`, [userId, guildId]);
    }
  }
  return events;
}

// ---- Bots' cover images ----

// Discord's image data (a data URI) as a cover: a WebP of at most 1600 pixels across in the
// uploads bucket, registered to `userId` (linked once the event is saved). Resolves to its URL.
async function storeImageData(dataUri, userId) {
  const match = typeof dataUri === 'string' && dataUri.match(/^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) throw badRequest('Invalid image data');
  const original = Buffer.from(match[1], 'base64');
  if (original.length > MAX_IMAGE_UPLOAD_BYTES) throw badRequest('File cannot be larger than 8 MB.');
  const sharp = require('sharp');
  let buffer;
  try {
    buffer = await sharp(original, { limitInputPixels: 60 * 1000 * 1000 }).timeout({ seconds: 20 }).rotate()
      .resize({ width: 1600, withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
  } catch {
    throw badRequest("That file isn't an image we can read");
  }
  const { BUCKET, registerUpload } = require('./uploads');
  const key = `${crypto.randomUUID()}.webp`;
  await require('./s3').putObject(BUCKET, key, buffer, 'image/webp');
  await registerUpload(key, userId);
  return `${s3Endpoint}/${BUCKET}/${key}`;
}

// ---- The clock ----

// Active voice events without an end: whose channel is empty, event id -> since when (unix s),
// and which have had someone in their channel since they started. In memory: after a restart
// an empty one waits for someone again (or UNATTENDED_SECONDS).
const emptySince = new Map();
const attended = new Set();

// A new occurrence (or none): who came to the last one no longer counts.
function forgetPresence(eventId) {
  emptySince.delete(eventId);
  attended.delete(eventId);
}

// One pass at unix s `at`: starts events whose time has come, ends those whose end has, and
// voice events without an end whose channel has stayed empty (or that nobody came to). An
// occurrence whose end passed before it could start (the server was down) just ends. Exported
// for tests.
async function sweepEvents(at = now()) {
  const due = await db.all(
    `SELECT ${EVENT_COLUMNS} FROM guild_events
     WHERE (status = 'scheduled' AND start_time <= ?) OR status = 'active'`,
    [at]
  );
  const voice = require('./voice');
  for (const event of due) {
    try {
      const ended = event.end_time != null && event.end_time <= at;
      if (event.status === 'scheduled') {
        if (ended) await finish(event, 'completed');
        else await activate(event);
      } else if (ended) {
        await finish(event, 'completed');
      } else if (event.entity_type !== 'voice' || event.end_time != null) {
        continue; // on until its end
      } else if (voice.membersOf(event.channel_id).length) {
        attended.add(event.id);
        emptySince.delete(event.id);
      } else if (!attended.has(event.id)) {
        if (at - (event.started_at ?? event.start_time) >= UNATTENDED_SECONDS) await finish(event, 'completed');
      } else if (!emptySince.has(event.id)) {
        emptySince.set(event.id, at);
      } else if (at - emptySince.get(event.id) >= EMPTY_SECONDS) {
        await finish(event, 'completed');
      }
    } catch (err) {
      console.error('Event sweep failed:', err.message);
    }
  }
}

function startEventTimers() {
  const timer = setInterval(() => sweepEvents().catch((err) => console.error('Event sweep failed:', err.message)), SWEEP_MS);
  timer.unref?.();
  return timer;
}

module.exports = {
  MAX_NAME,
  MAX_DESCRIPTION,
  MAX_LOCATION,
  MAX_EVENTS_PER_GUILD,
  MAX_EXCEPTIONS,
  UNATTENDED_SECONDS,
  EMPTY_SECONDS,
  getEvent,
  publicEvent,
  loadPublic,
  eventAccess,
  canManage,
  listEvents,
  listHistory,
  occurrenceDetail,
  interestedUsers,
  interestOf,
  broadcastInterest,
  createEvent,
  updateEvent,
  startEvent,
  endEvent,
  cancelEvent,
  cancelFollowing,
  skipOccurrence,
  moveOccurrence,
  setInterest,
  deleteChannelEvents,
  deleteGuildEvents,
  channelEvents,
  announceDeleted,
  forgetMember,
  storeImageData,
  sweepEvents,
  startEventTimers,
};
