const express = require('express');
const { authenticateJWT } = require('../auth');
const { ActionError, withActionErrors } = require('../actionError');
const { getMember, announceGuildUpdate } = require('../guilds');
const { PERMISSIONS, has } = require('../permissions');
const mediaServers = require('../mediaServers');
const watchParty = require('../watchParty');
const { rateLimitsEnabled } = require('../config');
const { createLimiter } = require('../rateLimit');

// A guild's media server (mediaServers.js), in Guild Settings → Watch Together: Manage Guild
// reads, connects and disconnects it. Members see only { kind, name, url } in the guild's
// layout (`media_server`); searching and playing are Watch Together's (routes/watchParty.js).
const router = express.Router();
const PATH = '/guilds/:guildId/media-server';

// req.member for the guild in the URL (404 for non-members), with Manage Guild.
async function requireManager(req, res, next) {
  const member = await getMember(Number(req.params.guildId), req.user.id);
  if (!member) return res.status(404).json({ error: 'Guild not found' });
  if (!has(member.permissions, PERMISSIONS.MANAGE_GUILD)) return res.status(403).json({ error: "You don't have permission to do that" });
  req.member = member;
  next();
}

// Everyone with the guild open learns the server changed, and its videos leave the queues.
async function changed(guildId) {
  await watchParty.mediaServerChanged(guildId);
  await announceGuildUpdate(guildId);
}

// { server } (mediaServers.js detailsOf; null: none).
router.get(PATH, authenticateJWT, requireManager, async (req, res) => {
  res.json({ server: await mediaServers.detailsOf(req.member.guild.id) });
});

// Connect (or replace): { kind: 'jellyfin' | 'emby', url, username, password } -> { server }.
// Each try logs in on that server, so a few a minute each.
const attempts = createLimiter({ windowMs: 60 * 1000, max: 10 });
router.put(PATH, authenticateJWT, requireManager, withActionErrors(async (req, res) => {
  if (rateLimitsEnabled && !attempts.hit(String(req.user.id)).allowed) {
    throw new ActionError(429, 'Too many tries. Wait a minute and try again.');
  }
  const { kind, url, username, password } = req.body ?? {};
  const server = await mediaServers.connect(req.member, { kind, url, username, password });
  await changed(req.member.guild.id);
  res.json({ server });
}));

router.delete(PATH, authenticateJWT, requireManager, withActionErrors(async (req, res) => {
  await mediaServers.disconnect(req.member);
  await changed(req.member.guild.id);
  res.json({ success: true });
}));

module.exports = router;
