const express = require('express');
const { authenticateJWT } = require('../auth');
const { withActionErrors } = require('../actionError');
const { getMember } = require('../guilds');
const events = require('../guildEvents');

// Scheduled events (guildEvents.js has the rules; the bot API shares its actions). Events are
// sent to whoever can see them: guild_event_create / _update / _delete { guildId, event } and
// guild_event_interest { guildId, eventId, userId, interested, userCount }.
const router = express.Router();

const notFound = (res) => res.status(404).json({ error: 'Event not found' });

// req.member for the guild in the URL (404 for non-members).
async function requireMember(req, res, next) {
  const member = await getMember(Number(req.params.guildId), req.user.id);
  if (!member) return res.status(404).json({ error: 'Guild not found' });
  req.member = member;
  next();
}

// req.member for the event's guild, if the caller can see the event (404 otherwise).
async function requireEvent(req, res, next) {
  const id = Number(req.params.eventId);
  const access = await events.eventAccess(id, req.user.id);
  if (!access) return notFound(res);
  req.member = access.member;
  req.eventId = id;
  next();
}

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
});

// The guild's events the caller can see, soonest first (with `interested`: theirs).
router.get('/guilds/:guildId/events', authenticateJWT, requireMember, async (req, res) => {
  res.json(await events.listEvents(req.member));
});

// { name, description?, entityType: 'voice' | 'external', channelId (voice) | location?
// (external), startTime, endTime (required somewhere else and all day), image?, recurrence?,
// timezone?, allDay?, emoji?, color? }
router.post('/guilds/:guildId/events', authenticateJWT, requireMember, withActionErrors(async (req, res) => {
  const event = await events.createEvent(req.member, fieldsOf(req.body));
  res.status(201).json({ ...event, interested: true });
}));

// One event (event links open it), with `interested`.
router.get('/guild-events/:eventId', authenticateJWT, requireEvent, async (req, res) => {
  const event = await events.loadPublic(req.eventId);
  res.json({ ...event, interested: await events.isInterested(req.eventId, req.user.id) });
});

// Any of the fields above: every occurrence of a repeating event.
router.patch('/guild-events/:eventId', authenticateJWT, requireEvent, withActionErrors(async (req, res) => {
  res.json(await events.updateEvent(req.member, req.eventId, fieldsOf(req.body)));
}));

router.post('/guild-events/:eventId/start', authenticateJWT, requireEvent, withActionErrors(async (req, res) => {
  res.json(await events.startEvent(req.member, req.eventId));
}));

router.post('/guild-events/:eventId/end', authenticateJWT, requireEvent, withActionErrors(async (req, res) => {
  res.json(await events.endEvent(req.member, req.eventId));
}));

// A repeating event's next occurrence: skipped (POST .../skip), or moved ({ startTime, endTime? }).
router.post('/guild-events/:eventId/skip', authenticateJWT, requireEvent, withActionErrors(async (req, res) => {
  res.json(await events.skipOccurrence(req.member, req.eventId));
}));

router.put('/guild-events/:eventId/occurrence', authenticateJWT, requireEvent, withActionErrors(async (req, res) => {
  res.json(await events.moveOccurrence(req.member, req.eventId, { startTime: req.body?.startTime, endTime: req.body?.endTime }));
}));

// Cancels it (every occurrence).
router.delete('/guild-events/:eventId', authenticateJWT, requireEvent, withActionErrors(async (req, res) => {
  await events.cancelEvent(req.member, req.eventId);
  res.json({ success: true });
}));

router.put('/guild-events/:eventId/interest', authenticateJWT, requireEvent, withActionErrors(async (req, res) => {
  await events.setInterest(req.member, req.eventId, true);
  res.json({ success: true });
}));

router.delete('/guild-events/:eventId/interest', authenticateJWT, requireEvent, withActionErrors(async (req, res) => {
  await events.setInterest(req.member, req.eventId, false);
  res.json({ success: true });
}));

// Who's interested: user ids.
router.get('/guild-events/:eventId/users', authenticateJWT, requireEvent, async (req, res) => {
  const rows = await events.interestedUsers(req.eventId, { limit: 1000 });
  res.json(rows.map((r) => r.user_id));
});

module.exports = router;
