const crypto = require('crypto');
const db = require('./db');
const { s3Endpoint } = require('./config');
const { PERMISSIONS, has, channelPermissions } = require('./permissions');
const { sendToUserSockets } = require('./sockets');
const { sendPushToUser, getUserImageUrl } = require('./push');
const { ActionError } = require('./actionError');
const { logAudit, diff } = require('./auditLog');
const { cleanRule, cleanTimeZone, startsOnRule, nextOccurrence } = require('./eventRecurrence');

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
// - Lifecycle: scheduled -> active -> completed, or cancelled. One somewhere else starts and
//   ends by itself at its times; a voice channel's is started by hand (or is cancelled
//   UNSTARTED_SECONDS after its time) and ends by hand or once its channel has stayed empty
//   EMPTY_SECONDS. Ended and cancelled events are deleted; a repeating one moves on to its next
//   occurrence instead (eventRecurrence.js). Whoever's interested is told when one starts.

const MAX_NAME = 100;
const MAX_DESCRIPTION = 1000;
const MAX_LOCATION = 100;
const MAX_IMAGE = 1000;
const MAX_EVENTS_PER_GUILD = 100;
const MAX_AHEAD_SECONDS = 5 * 366 * 86400;
const UNSTARTED_SECONDS = 12 * 3600;
const EMPTY_SECONDS = 5 * 60;
const SWEEP_MS = 15 * 1000;
const MAX_IMAGE_UPLOAD_BYTES = 8 * 1024 * 1024;

const ENTITY_TYPES = ['voice', 'external'];

const now = () => Math.floor(Date.now() / 1000);
const badRequest = (message) => new ActionError(400, message);
const forbidden = () => new ActionError(403, "You don't have permission to do that");
const notFound = () => new ActionError(404, 'Event not found', 10070);

const EVENT_COLUMNS = `id, guild_id, channel_id, creator_id, name, description, entity_type, location, start_time,
  end_time, status, image, recurrence, timezone, occurrence_start, duration, started_at, created_at, updated_at`;

// ---- Reading ----

async function getEvent(id) {
  if (!Number.isInteger(id)) return null;
  return db.get(`SELECT ${EVENT_COLUMNS} FROM guild_events WHERE id = ?`, [id]);
}

// What clients get: the row with `recurrence` parsed and `user_count` (how many are interested).
function publicEvent(row, userCount = 0) {
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
    started_at: row.started_at,
    created_at: row.created_at,
    user_count: userCount,
  };
}

async function userCounts(ids) {
  if (!ids.length) return new Map();
  const rows = await db.all(
    `SELECT event_id, COUNT(*) AS count FROM guild_event_users WHERE event_id IN (${ids.map(() => '?').join(',')}) GROUP BY event_id`,
    ids
  );
  return new Map(rows.map((r) => [r.event_id, r.count]));
}

async function loadPublic(id) {
  const row = await getEvent(id);
  if (!row) return null;
  return publicEvent(row, (await userCounts([row.id])).get(row.id) ?? 0);
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

// { event, member, permissions } for event `eventId` as `userId` sees it, or null (not in its
// guild, or can't see it).
async function eventAccess(eventId, userId) {
  const event = await getEvent(eventId);
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

// The events of the guild `member` can see, soonest first, each with `interested` (theirs).
async function listEvents(member) {
  const { getOverrides } = require('./guilds');
  const rows = await db.all(`SELECT ${EVENT_COLUMNS} FROM guild_events WHERE guild_id = ? ORDER BY start_time, id`, [member.guild.id]);
  if (!rows.length) return [];
  const overrides = await getOverrides({ guildId: member.guild.id });
  const channels = new Set((await db.all("SELECT id FROM guild_channels WHERE guild_id = ? AND type = 'voice'", [member.guild.id])).map((c) => c.id));
  const visible = rows.filter((e) => e.channel_id == null || (channels.has(e.channel_id) &&
    has(channelPermissions(member, member.userId, overrides.get(e.channel_id) ?? []), PERMISSIONS.VIEW_CHANNEL)));
  const ids = visible.map((e) => e.id);
  const counts = await userCounts(ids);
  const mine = new Set(ids.length ? (await db.all(
    `SELECT event_id FROM guild_event_users WHERE user_id = ? AND event_id IN (${ids.map(() => '?').join(',')})`,
    [member.userId, ...ids]
  )).map((r) => r.event_id) : []);
  return visible.map((e) => ({ ...publicEvent(e, counts.get(e.id) ?? 0), interested: mine.has(e.id) }));
}

const isInterested = async (eventId, userId) => Boolean(
  await db.get('SELECT 1 FROM guild_event_users WHERE event_id = ? AND user_id = ?', [eventId, userId])
);

// Who's interested in `eventId` ({ user_id, created_at }, by user id), `limit` after user id `after` or
// before user id `before` (the bot API pages by user id, as Discord does).
async function interestedUsers(eventId, { limit = 100, after = null, before = null } = {}) {
  const where = ['event_id = ?'];
  const params = [eventId];
  if (after != null) {
    where.push('user_id > ?');
    params.push(after);
  }
  if (before != null) {
    where.push('user_id < ?');
    params.push(before);
  }
  const rows = await db.all(
    `SELECT user_id, created_at FROM guild_event_users WHERE ${where.join(' AND ')} ORDER BY user_id ${before != null && after == null ? 'DESC' : ''} LIMIT ?`,
    [...params, limit]
  );
  return rows.sort((a, b) => a.user_id - b.user_id);
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

// Tells whoever sees `event` that `userId` is or isn't interested any more.
async function broadcastInterest(event, userId, interested) {
  const count = (await userCounts([event.id])).get(event.id) ?? 0;
  for (const viewer of await viewersOf(event)) {
    sendToUserSockets(viewer, {
      type: 'guild_event_interest', guildId: event.guild_id, eventId: event.id, userId, interested, userCount: count,
    });
  }
}

// Where an event is, in words (for pushes, which the server writes in English like the others).
async function placeOf(event) {
  if (event.entity_type !== 'voice') return event.location;
  const channel = await db.get('SELECT name FROM guild_channels WHERE id = ?', [event.channel_id]);
  return channel ? `#${channel.name}` : null;
}

// Tells those interested in `event` (who can still see it) that it started: a push (unless
// their notification level for the guild is 'none'), never to whoever started it.
async function notifyStarted(event, actorId = null) {
  const interested = (await db.all('SELECT user_id FROM guild_event_users WHERE event_id = ?', [event.id])).map((r) => r.user_id);
  if (!interested.length) return;
  const viewers = new Set(await viewersOf(event));
  const recipients = interested.filter((id) => id !== actorId && viewers.has(id));
  if (!recipients.length) return;
  const levels = new Map((await db.all(
    `SELECT user_id, notify_level FROM guild_members WHERE guild_id = ? AND user_id IN (${recipients.map(() => '?').join(',')})`,
    [event.guild_id, ...recipients]
  )).map((r) => [r.user_id, r.notify_level]));
  const guild = await db.get('SELECT name, icon_version FROM guilds WHERE id = ?', [event.guild_id]);
  const place = await placeOf(event);
  const payload = {
    type: 'event',
    title: event.name,
    body: `Starting now${place ? ` · ${place}` : ''} (${guild.name})`,
    url: `/guild/${event.guild_id}${event.channel_id ? `/${event.channel_id}` : ''}?event=${event.id}`,
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
// startTime, endTime, image, recurrence, timezone }, each optional when `before` is given),
// checked; throws ActionError. `member` is who's doing it.
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
    if (!after.location) throw badRequest('Say where the event is');
    if (after.end_time == null) throw badRequest('Events somewhere else need an end time');
  }
  if (!Number.isInteger(after.start_time)) throw badRequest('Invalid start time');
  const startChanged = !before || after.start_time !== before.start_time;
  if (startChanged && after.status !== 'active') {
    if (after.start_time <= now()) throw badRequest('The start time must be in the future');
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

// ---- Actions ----

// `member` schedules an event; resolves to it (publicEvent). Its creator is interested.
async function createEvent(member, input) {
  const fields = await checkedFields(member, input);
  await checkCanCreate(member, fields);
  const id = await db.transaction(async () => {
    const { count } = await db.get('SELECT COUNT(*) AS count FROM guild_events WHERE guild_id = ?', [member.guild.id]);
    if (count >= MAX_EVENTS_PER_GUILD) throw badRequest(`A guild can have at most ${MAX_EVENTS_PER_GUILD} events`);
    const at = now();
    const repeating = Boolean(fields.recurrence);
    const { lastID } = await db.run(
      `INSERT INTO guild_events (guild_id, channel_id, creator_id, name, description, entity_type, location, start_time, end_time,
         status, image, recurrence, timezone, occurrence_start, duration, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?)`,
      [member.guild.id, fields.channel_id ?? null, member.userId, fields.name, fields.description ?? null, fields.entity_type,
        fields.location ?? null, fields.start_time, fields.end_time ?? null, fields.image ?? null, fields.recurrence ?? null,
        repeating ? fields.timezone : null, repeating ? fields.start_time : null,
        fields.end_time != null ? fields.end_time - fields.start_time : null, at, at]
    );
    await db.run('INSERT INTO guild_event_users (event_id, user_id, created_at) VALUES (?, ?, ?)', [lastID, member.userId, at]);
    await linkImage(lastID, fields.image);
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

// Edits the event (every occurrence of a repeating one); resolves to it. Moving it to another
// voice channel needs what creating it there would.
async function updateEvent(member, eventId, input) {
  const { event: before } = await managedAccess(member, eventId);
  const after = await checkedFields(member, input, { ...before, recurrence: before.recurrence });
  if (after.channel_id !== before.channel_id || after.entity_type !== before.entity_type) await checkCanCreate(member, after);
  const repeating = Boolean(after.recurrence);
  const retimed = after.start_time !== before.start_time || after.recurrence !== before.recurrence || after.timezone !== before.timezone;
  // A new start (or rule) re-anchors the series there.
  const occurrenceStart = !repeating ? null : retimed ? after.start_time : before.occurrence_start;
  const duration = after.end_time != null ? after.end_time - after.start_time : null;
  const changes = diff(before, {
    name: after.name, description: after.description, location: after.location, channel_id: after.channel_id,
    start_time: after.start_time, end_time: after.end_time, recurrence: after.recurrence,
  });
  if (after.image !== before.image) changes.image = before.image ? (after.image ? 'changed' : 'removed') : 'added';
  await db.transaction(async () => {
    await db.run(
      `UPDATE guild_events SET name = ?, description = ?, entity_type = ?, channel_id = ?, location = ?, start_time = ?, end_time = ?,
         image = ?, recurrence = ?, timezone = ?, occurrence_start = ?, duration = ?, updated_at = ? WHERE id = ?`,
      [after.name, after.description ?? null, after.entity_type, after.channel_id ?? null, after.location ?? null, after.start_time,
        after.end_time ?? null, after.image ?? null, after.recurrence ?? null, repeating ? after.timezone : null, occurrenceStart,
        duration, now(), before.id]
    );
    await linkImage(before.id, after.image);
    if (Object.keys(changes).length) {
      await logAudit({
        guildId: before.guild_id, actorId: member.userId, action: 'event_update', targetType: 'event', targetId: before.id,
        channelId: after.channel_id ?? null, details: { name: before.name, changes },
      });
    }
  });
  if (after.image !== before.image) require('./uploads').releaseUploads();
  const event = await loadPublic(before.id);
  await broadcast('update', event, before);
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

// A repeating event: skips its next occurrence (it moves on to the one after).
async function skipOccurrence(member, eventId) {
  const { event } = await managedAccess(member, eventId);
  if (!event.recurrence) throw badRequest("That event doesn't repeat");
  if (event.status !== 'scheduled') throw badRequest('That event has already started');
  return advance(event);
}

// A repeating event: moves only its next occurrence to { startTime, endTime } (the series
// keeps its times).
async function moveOccurrence(member, eventId, { startTime, endTime }) {
  const { event } = await managedAccess(member, eventId);
  if (!event.recurrence) throw badRequest("That event doesn't repeat");
  if (event.status !== 'scheduled') throw badRequest('That event has already started');
  const start = cleanTime(startTime, 'start time');
  const end = endTime === undefined ? (event.duration != null ? start + event.duration : null) : cleanTime(endTime, 'end time');
  if (start == null || start <= now()) throw badRequest('The start time must be in the future');
  if (end != null && end <= start) throw badRequest('The end time must be after the start time');
  if (event.entity_type === 'external' && end == null) throw badRequest('Events somewhere else need an end time');
  const next = nextOccurrence(JSON.parse(event.recurrence), event.timezone, event.occurrence_start);
  if (next != null && start >= next) throw badRequest('This occurrence must start before the next one');
  await db.run('UPDATE guild_events SET start_time = ?, end_time = ?, updated_at = ? WHERE id = ?', [start, end, now(), event.id]);
  const updated = await loadPublic(event.id);
  await broadcast('update', updated, event);
  return updated;
}

// `member` is (or isn't) interested in the event.
async function setInterest(member, eventId, interested) {
  const access = await eventAccess(eventId, member.userId);
  if (!access) throw notFound();
  const { changes } = interested
    ? await db.run('INSERT OR IGNORE INTO guild_event_users (event_id, user_id, created_at) VALUES (?, ?, ?)', [eventId, member.userId, now()])
    : await db.run('DELETE FROM guild_event_users WHERE event_id = ? AND user_id = ?', [eventId, member.userId]);
  if (changes) await broadcastInterest(access.event, member.userId, interested);
}

// ---- Moving through the lifecycle ----

async function activate(event, actorId = null) {
  await db.run("UPDATE guild_events SET status = 'active', started_at = ?, updated_at = ? WHERE id = ?", [now(), now(), event.id]);
  emptySince.delete(event.id);
  const updated = await loadPublic(event.id);
  await broadcast('update', updated);
  notifyStarted(event, actorId).catch((err) => console.error('Event notification failed:', err.message));
  return updated;
}

// Deletes the event; whoever saw it is sent it with `status` ('completed' or 'canceled'), as
// `kind` ('update', as Discord does when one ends, or 'delete').
async function remove(event, status, kind) {
  const last = { ...(await loadPublic(event.id)), status };
  await db.transaction(async () => {
    await db.run('DELETE FROM guild_event_users WHERE event_id = ?', [event.id]);
    await db.run('DELETE FROM guild_events WHERE id = ?', [event.id]);
  });
  emptySince.delete(event.id);
  require('./uploads').releaseUploads();
  await broadcast(kind, last);
  return last;
}

// A repeating event moves on to its next occurrence still to come (scheduled again, the same
// people interested); one that has none left (or doesn't repeat) is deleted.
async function advance(event) {
  const rule = JSON.parse(event.recurrence);
  let next = nextOccurrence(rule, event.timezone, event.occurrence_start);
  while (next != null && next <= now()) next = nextOccurrence(rule, event.timezone, next);
  if (next == null) return remove(event, 'completed', 'update');
  await db.run(
    `UPDATE guild_events SET status = 'scheduled', started_at = NULL, start_time = ?, end_time = ?, occurrence_start = ?, updated_at = ?
     WHERE id = ?`,
    [next, event.duration != null ? next + event.duration : null, next, now(), event.id]
  );
  emptySince.delete(event.id);
  const updated = await loadPublic(event.id);
  await broadcast('update', updated);
  return updated;
}

// The occurrence is over (`status`: 'completed', or 'canceled' if it never started).
async function finish(event, status) {
  if (event.recurrence) return advance(event);
  return remove(event, status, 'update');
}

// ---- Clean-up ----

// Every event of the channels (an SQL list of ids, as deleteChannelContents takes them), and
// who was interested. Inside the transaction.
async function deleteChannelEvents(channelIdsSql, params) {
  await db.run(
    `DELETE FROM guild_event_users WHERE event_id IN (SELECT id FROM guild_events WHERE channel_id IN (${channelIdsSql}))`,
    params
  );
  await db.run(`DELETE FROM guild_events WHERE channel_id IN (${channelIdsSql})`, params);
}

// Every event of the guild. Inside the transaction.
async function deleteGuildEvents(guildId) {
  await db.run('DELETE FROM guild_event_users WHERE event_id IN (SELECT id FROM guild_events WHERE guild_id = ?)', [guildId]);
  await db.run('DELETE FROM guild_events WHERE guild_id = ?', [guildId]);
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
    `SELECT ${EVENT_COLUMNS} FROM guild_events WHERE guild_id = ? AND id IN (SELECT event_id FROM guild_event_users WHERE user_id = ?)`,
    [guildId, userId]
  );
  if (events.length) {
    await db.run(
      'DELETE FROM guild_event_users WHERE user_id = ? AND event_id IN (SELECT id FROM guild_events WHERE guild_id = ?)',
      [userId, guildId]
    );
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

// Active voice events whose channel is empty: event id -> since when (unix s). In memory: after
// a restart they get a fresh EMPTY_SECONDS.
const emptySince = new Map();

// One pass at unix s `at`: starts and ends events somewhere else on time, cancels voice events
// nobody started, ends voice events whose channel has stayed empty. Exported for tests.
async function sweepEvents(at = now()) {
  const due = await db.all(
    `SELECT ${EVENT_COLUMNS} FROM guild_events
     WHERE (entity_type = 'external' AND ((status = 'scheduled' AND start_time <= ?) OR (status = 'active' AND end_time <= ?)))
        OR (entity_type = 'voice' AND ((status = 'scheduled' AND start_time <= ?) OR status = 'active'))`,
    [at, at, at - UNSTARTED_SECONDS]
  );
  const voice = require('./voice');
  for (const event of due) {
    try {
      if (event.entity_type === 'external') {
        if (event.status === 'active' || event.end_time <= at) await finish(event, 'completed');
        else await activate(event);
      } else if (event.status === 'scheduled') {
        await finish(event, 'canceled');
      } else if (voice.membersOf(event.channel_id).length) {
        emptySince.delete(event.id);
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
  UNSTARTED_SECONDS,
  EMPTY_SECONDS,
  getEvent,
  publicEvent,
  loadPublic,
  eventAccess,
  canManage,
  listEvents,
  interestedUsers,
  isInterested,
  broadcastInterest,
  createEvent,
  updateEvent,
  startEvent,
  endEvent,
  cancelEvent,
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
