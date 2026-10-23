const express = require('express');
const { authenticateJWT } = require('../auth');
const { PERMISSIONS, has } = require('../permissions');
const { getChannelAccess } = require('../guilds');
const voice = require('../voice');
const watchParty = require('../watchParty');
const mediaServers = require('../mediaServers');
const { ActionError } = require('../actionError');
const { MAX_QUERY } = require('../youtubeSearch');
const { rateLimitsEnabled } = require('../config');
const { createLimiter } = require('../rateLimit');

// Watch Together in voice channels (see watchParty.js). Reading needs only View Channel; every
// change (and searching YouTube or the guild's media server, and getting a media server video's
// address) needs you in the channel's voice, and then Queue Videos (search,
// add, remove your own), Manage
// Queue (reorder, remove anyone's) or Control Playback (play, pause, seek, skip; whoever added
// the video playing may skip it too). Each answer is { party, server_time } (the server's clock,
// which players follow).
const router = express.Router();
const BASE = '/guilds/:guildId/channels/:channelId/watch-party';

const reply = (res, channelId) => res.json({ party: watchParty.publicParty(watchParty.getParty(channelId)), server_time: Date.now() });

// The channel (a voice channel you can see, in that guild) as req.access.
async function voiceChannel(req, res, next) {
  const channelId = Number(req.params.channelId);
  const access = await getChannelAccess(channelId, req.user.id);
  if (!access || access.channel.guild_id !== Number(req.params.guildId) || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) {
    return res.status(404).json({ error: 'Channel not found' });
  }
  if (access.channel.type !== 'voice') return res.status(400).json({ error: 'Not a voice channel' });
  req.access = access;
  req.channelId = channelId;
  next();
}

// …and you're in its voice (on any device).
function inVoice(req, res, next) {
  if (voice.states.get(req.user.id)?.channelId !== req.channelId) {
    return res.status(403).json({ error: 'Join the voice channel first' });
  }
  next();
}

// …and there's a party (as req.party).
function withParty(req, res, next) {
  req.party = watchParty.getParty(req.channelId);
  if (!req.party) return res.status(404).json({ error: 'Nothing is playing' });
  next();
}

const can = (req, bit) => has(req.access.permissions, bit);
const forbidden = (res) => res.status(403).json({ error: "You don't have permission to do that" });
const itemId = (value) => (Number.isInteger(value) ? value : Number.NaN);

// Errors watchParty.js and mediaServers.js throw ({ status, message }) as answers.
const handled = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (err) {
    if (!err.status && !(err instanceof ActionError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
};

// The party and its activity log ({ party, log, server_time }).
router.get(BASE, authenticateJWT, voiceChannel, (req, res) => res.json({
  party: watchParty.publicParty(watchParty.getParty(req.channelId)),
  log: watchParty.logOf(req.channelId),
  server_time: Date.now(),
}));

// Searches are limited per person, since each is a request from the server to YouTube or the
// media server: true when this one may go ahead (else it has answered 429).
const searches = createLimiter({ windowMs: 60 * 1000, max: 20 });
function searchAllowed(req, res) {
  if (!rateLimitsEnabled) return true;
  const { allowed, retryAfterMs } = searches.hit(String(req.user.id));
  if (allowed) return true;
  res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
  res.status(429).json({ error: 'Too many searches. Wait a moment and try again.' });
  return false;
}

// ?q= as a search, or null (having answered 400).
function searchQuery(req, res) {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  let error = null;
  if (!query) error = 'Type something to search for';
  else if (query.length > MAX_QUERY) error = `Searches can be at most ${MAX_QUERY} characters`;
  if (!error) return query;
  res.status(400).json({ error });
  return null;
}

// Search YouTube: ?q= (youtubeSearch.js) -> { results }.
router.get(`${BASE}/search`, authenticateJWT, voiceChannel, inVoice, handled(async (req, res) => {
  if (!can(req, PERMISSIONS.QUEUE_VIDEOS)) return forbidden(res);
  const query = searchQuery(req, res);
  if (query == null || !searchAllowed(req, res)) return;
  res.json({ results: await watchParty.youtube.search(query) });
}));

// Search the guild's media server: ?q= -> { results } (mediaServers.js itemOf; shows among
// them, whose episodes come from the next route).
router.get(`${BASE}/media-search`, authenticateJWT, voiceChannel, inVoice, handled(async (req, res) => {
  if (!can(req, PERMISSIONS.QUEUE_VIDEOS)) return forbidden(res);
  const query = searchQuery(req, res);
  if (query == null || !searchAllowed(req, res)) return;
  res.json({ results: await mediaServers.search(req.access.channel.guild_id, query) });
}));

// A show's episodes on the guild's media server -> { results }.
router.get(`${BASE}/media-episodes/:seriesId`, authenticateJWT, voiceChannel, inVoice, handled(async (req, res) => {
  if (!can(req, PERMISSIONS.QUEUE_VIDEOS)) return forbidden(res);
  if (!searchAllowed(req, res)) return;
  res.json({ results: await mediaServers.episodes(req.access.channel.guild_id, req.params.seriesId) });
}));

// Add a video: { videoId } (YouTube's 11-character id) or { mediaId } (the guild's media
// server's).
router.post(`${BASE}/queue`, authenticateJWT, voiceChannel, inVoice, handled(async (req, res) => {
  if (!can(req, PERMISSIONS.QUEUE_VIDEOS)) return forbidden(res);
  await watchParty.addVideo({
    guildId: req.access.channel.guild_id,
    channelId: req.channelId,
    userId: req.user.id,
    videoId: req.body?.videoId,
    mediaId: req.body?.mediaId,
  });
  reply(res, req.channelId);
}));

// Take a waiting video out: your own with Queue Videos, anyone's with Manage Queue.
router.delete(`${BASE}/queue/:itemId`, authenticateJWT, voiceChannel, inVoice, withParty, handled(async (req, res) => {
  const item = watchParty.queuedItem(req.party, Number(req.params.itemId));
  const own = item.addedBy === req.user.id && can(req, PERMISSIONS.QUEUE_VIDEOS);
  if (!own && !can(req, PERMISSIONS.MANAGE_QUEUE)) return forbidden(res);
  await watchParty.removeVideo(req.party, item.id, req.user.id);
  reply(res, req.channelId);
}));

// Move a waiting video: { beforeId } (another waiting video; null: to the end).
router.put(`${BASE}/queue/:itemId/move`, authenticateJWT, voiceChannel, inVoice, withParty, handled(async (req, res) => {
  if (!can(req, PERMISSIONS.MANAGE_QUEUE)) return forbidden(res);
  const beforeId = req.body?.beforeId ?? null;
  if (beforeId !== null && !Number.isInteger(beforeId)) return res.status(400).json({ error: 'beforeId must be a video in the queue or null' });
  await watchParty.moveVideo(req.party, Number(req.params.itemId), beforeId, req.user.id);
  reply(res, req.channelId);
}));

// Play, pause or seek: { playing?, position? } (seconds). `itemId` (the video it's meant for)
// keeps a late click from moving the next video.
router.put(`${BASE}/playback`, authenticateJWT, voiceChannel, inVoice, withParty, handled(async (req, res) => {
  if (!can(req, PERMISSIONS.CONTROL_PLAYBACK)) return forbidden(res);
  const { playing, position, itemId: forItem } = req.body ?? {};
  if (playing !== undefined && typeof playing !== 'boolean') return res.status(400).json({ error: 'playing must be true or false' });
  if (position !== undefined && !(Number.isFinite(position) && position >= 0)) return res.status(400).json({ error: 'position must be a number of seconds' });
  if (playing === undefined && position === undefined) return res.status(400).json({ error: 'Nothing to change' });
  if (forItem !== undefined && itemId(forItem) !== req.party.current.id) return res.status(409).json({ error: 'Another video is playing now' });
  await watchParty.setPlayback(req.party, { playing, position }, req.user.id);
  reply(res, req.channelId);
}));

// Skip the video playing: { itemId } (which one you mean, so two skips at once skip one).
router.post(`${BASE}/skip`, authenticateJWT, voiceChannel, inVoice, withParty, handled(async (req, res) => {
  const own = req.party.current.addedBy === req.user.id;
  if (!own && !can(req, PERMISSIONS.CONTROL_PLAYBACK)) return forbidden(res);
  await watchParty.skipVideo(req.party, itemId(req.body?.itemId), req.user.id);
  reply(res, req.channelId);
}));

// A player says how long a video is: { itemId, duration } (seconds; the first answer counts).
router.put(`${BASE}/duration`, authenticateJWT, voiceChannel, inVoice, withParty, handled(async (req, res) => {
  await watchParty.setDuration(req.party, itemId(req.body?.itemId), Number(req.body?.duration));
  res.json({ success: true });
}));

// Where your player loads the media server's video playing (`itemId`): { type: 'file' |
// 'hls', url }. The address carries the guild's token, so only for people in the channel.
router.get(`${BASE}/stream/:itemId`, authenticateJWT, voiceChannel, inVoice, withParty, handled(async (req, res) => {
  res.json(await watchParty.streamFor(req.party, Number(req.params.itemId)));
}));

module.exports = router;
