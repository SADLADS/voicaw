const express = require('express');
const { authenticateJWT } = require('../auth');
const { withActionErrors } = require('../actionError');
const { getMember } = require('../guilds');
const events = require('../guildEvents');

// Scheduled events (guildEvents.js has the rules; the bot API shares its actions). Events are
// sent to whoever can see them: guild_event_create / _update / _delete { guildId, event } and
// guild_event_interest { guildId, eventId, userId, rsvp (the current occurrence: 'going',
// 'maybe', 'declined' or null), rsvpAll (the series), rsvps ({ original start: rsvp } where one
// differs), the same as Discord's interest (going or maybe; for older apps): interested,
// interestedAll, occurrences; changed (who's interested in the current occurrence), userCount,
// rsvpCounts, waitlist }. A repeating event's
// occurrences are named by their original start (`occurrence`, `from`).
const router = express.Router();

const notFound = (res) => res.status(404).json({ error: 'Event not found' });

// req.member for the guild in the URL (404 for non-members).
async function requireMember(req, res, next) {
  const member = await getMember(Number(req.params.guildId), req.user.id);
  if (!member) return res.status(404).json({ error: 'Guild not found' });
  req.member = member;
  next();
}

// req.member for the event's guild, if the caller can see the event (404 otherwise). An event
// "this and following" continued (and that has ended since) is the series that did.
async function requireEvent(req, res, next) {
  const access = await events.eventAccess(Number(req.params.eventId), req.user.id);
  if (!access) return notFound(res);
  req.member = access.member;
  req.eventId = access.event.id;
  next();
}

// An original start in the query or body (unix s), or null.
const originalOf = (value) => (/^\d+$/.test(String(value ?? '')) ? Number(value) : null);

// The fields the app sends, as the actions take them.
const fieldsOf = (body = {}) => ({
  name: body.name,
  description: body.description,
  entityType: body.entityType,
  channelId: body.channelId,
  location: body.location,
  startTime: body.startTime,
  endTime: body.endTime,
  image: body.image,
  recurrence: body.recurrence,
  timezone: body.timezone,
  allDay: body.allDay,
  emoji: body.emoji,
  color: body.color,
  rsvpLimit: body.rsvpLimit,
});

// The guild's events the caller can see, soonest first (with `rsvp`, `rsvp_all` and `my_rsvps`:
// theirs; guildEvents.interestState).
router.get('/guilds/:guildId/events', authenticateJWT, requireMember, async (req, res) => {
  res.json(await events.listEvents(req.member));
});

// { name, description?, entityType: 'voice' | 'external', channelId (voice) | location?
// (external), startTime, endTime (required somewhere else and all day), image?, recurrence?,
// timezone?, allDay?, emoji?, color?, rsvpLimit? (null: none) }
router.post('/guilds/:guildId/events', authenticateJWT, requireMember, withActionErrors(async (req, res) => {
  const event = await events.createEvent(req.member, fieldsOf(req.body));
  res.status(201).json({
    ...event, rsvp: 'going', rsvp_all: 'going', my_rsvps: {}, interested: true, interested_all: true, my_occurrences: {},
  });
}));

// What took place between ?from and ?to (unix s, at most 100 days apart), for the calendar's
// past days: occurrences as they were (each with the event's id and its original_start).
router.get('/guilds/:guildId/event-history', authenticateJWT, requireMember, withActionErrors(async (req, res) => {
  res.json(await events.listHistory(req.member, Number(req.query.from), Number(req.query.to)));
}));

// One event (event links open it), with your answers (`rsvp`, `rsvp_all`, `my_rsvps`...).
// A repeating one's ?occurrence=<original start> or ?on=YYYY-MM-DD (a link's date) adds that
// `occurrence` (guildEvents.occurrenceDetail: still to come, cancelled, taken place, or null).
router.get('/guild-events/:eventId', authenticateJWT, requireEvent, async (req, res) => {
  const row = await events.getEvent(req.eventId);
  const body = { ...(await events.loadPublic(row.id)), ...(await events.interestOf(row, req.user.id)) };
  if (req.query.occurrence != null || req.query.on != null) {
    body.occurrence = await events.occurrenceDetail(row, { occurrence: originalOf(req.query.occurrence), on: req.query.on ?? null });
  }
  res.json(body);
});

// Any of the fields above: every occurrence of a repeating event, or with ?from=<original
// start> that one and those after it (a new event from then on, which it answers with).
router.patch('/guild-events/:eventId', authenticateJWT, requireEvent, withActionErrors(async (req, res) => {
  const event = await events.updateEvent(req.member, req.eventId, fieldsOf(req.body), { from: originalOf(req.query.from) });
  res.json({ ...event, ...(await events.interestOf(await events.getEvent(event.id), req.user.id)) });
}));

router.post('/guild-events/:eventId/start', authenticateJWT, requireEvent, withActionErrors(async (req, res) => {
  res.json(await events.startEvent(req.member, req.eventId));
}));

router.post('/guild-events/:eventId/end', authenticateJWT, requireEvent, withActionErrors(async (req, res) => {
  res.json(await events.endEvent(req.member, req.eventId));
}));

// One occurrence of a repeating event ({ occurrence?: original start, the current one by
// default }): cancelled (POST .../skip), or changed ({ startTime, endTime?, name?,
// description?, location? }: PUT .../occurrence).
router.post('/guild-events/:eventId/skip', authenticateJWT, requireEvent, withActionErrors(async (req, res) => {
  res.json(await events.skipOccurrence(req.member, req.eventId, { occurrence: originalOf(req.body?.occurrence) }));
}));

router.put('/guild-events/:eventId/occurrence', authenticateJWT, requireEvent, withActionErrors(async (req, res) => {
  const body = req.body ?? {};
  res.json(await events.moveOccurrence(req.member, req.eventId, {
    occurrence: originalOf(body.occurrence), startTime: body.startTime, endTime: body.endTime,
    name: body.name, description: body.description, location: body.location,
  }));
}));

// Cancels it (every occurrence), or with ?from=<original start> that occurrence and every one
// after it (answers with the event, or { success } once it's gone).
router.delete('/guild-events/:eventId', authenticateJWT, requireEvent, withActionErrors(async (req, res) => {
  const from = originalOf(req.query.from);
  if (from != null) {
    const event = await events.cancelFollowing(req.member, req.eventId, from);
    return res.json(event ?? { success: true });
  }
  await events.cancelEvent(req.member, req.eventId);
  res.json({ success: true });
}));

// ?occurrence=<original start> (1: the current one), or null for every occurrence.
function occurrenceParam(value) {
  const text = String(value ?? '');
  return ['1', 'true'].includes(text) ? 'current' : originalOf(text);
}

// An RSVP { rsvp: 'going' | 'maybe' | 'declined' | null (none), occurrence? (as above) }: to
// every occurrence, or only that one. Answers with your answers (interestState), `rsvp` and
// `interested` being that occurrence's.
router.put('/guild-events/:eventId/rsvp', authenticateJWT, requireEvent, withActionErrors(async (req, res) => {
  const body = req.body ?? {};
  res.json(await events.setRsvp(req.member, req.eventId, body.rsvp ?? null, { occurrence: occurrenceParam(body.occurrence) }));
}));

// Interested (PUT: going) or not (DELETE: no answer), as before RSVPs (older apps): in every
// occurrence, or with ?occurrence= only that one. Answers as an RSVP does.
const interestRoute = (interested) => withActionErrors(async (req, res) => {
  res.json(await events.setInterest(req.member, req.eventId, interested, { occurrence: occurrenceParam(req.query.occurrence) }));
});
router.put('/guild-events/:eventId/interest', authenticateJWT, requireEvent, interestRoute(true));
router.delete('/guild-events/:eventId/interest', authenticateJWT, requireEvent, interestRoute(false));

// Everyone's answer to the current occurrence (or ?occurrence=<original start>): [{ user_id,
// rsvp: 'going' | 'waitlisted' | 'maybe' | 'declined' }], in the order given (the waitlist's).
router.get('/guild-events/:eventId/rsvps', authenticateJWT, requireEvent, async (req, res) => {
  const occurrence = originalOf(req.query.occurrence);
  res.json(await events.eventRsvps(req.eventId, occurrence != null ? { occurrence } : {}));
});

// Who's interested in the current occurrence (or ?occurrence=<original start>): user ids.
router.get('/guild-events/:eventId/users', authenticateJWT, requireEvent, async (req, res) => {
  const occurrence = originalOf(req.query.occurrence);
  const rows = await events.interestedUsers(req.eventId, { limit: 1000, ...(occurrence != null ? { occurrence } : {}) });
  res.json(rows.map((r) => r.user_id));
});

module.exports = router;
