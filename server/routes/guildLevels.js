const express = require('express');
const db = require('../db');
const { authenticateJWT } = require('../auth');
const { withActionErrors } = require('../actionError');
const { getMember, announceGuildUpdate } = require('../guilds');
const levels = require('../guildLevels');

// Levels (guildLevels.js has the rules; the bot API shares its actions). Members read the
// settings (also in the guild's layout, `levels`), the leaderboard and anyone's level; Manage
// Guild changes the settings, Manage Levels anyone's XP or level.
const router = express.Router();

// req.member for the guild in the URL (404 for non-members).
async function requireMember(req, res, next) {
  const member = await getMember(Number(req.params.guildId), req.user.id);
  if (!member) return res.status(404).json({ error: 'Guild not found' });
  req.member = member;
  next();
}

// Clamps a query number to [min, max], `fallback` when it isn't one.
const queryNumber = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(Math.max(number, min), max) : fallback;
};

router.get('/guilds/:guildId/levels', authenticateJWT, requireMember, async (req, res) => {
  res.json(await levels.getSettings(req.member.guild.id));
});

// Any of the settings (see guildLevels.js applyPatch); everyone gets the new layout.
router.patch('/guilds/:guildId/levels', authenticateJWT, requireMember, withActionErrors(async (req, res) => {
  const settings = await levels.updateSettings(req.member, req.body);
  await announceGuildUpdate(req.member.guild.id);
  res.json(settings);
}));

// The leaderboard: members with XP, most first (`limit` up to 100, `offset`).
router.get('/guilds/:guildId/levels/members', authenticateJWT, requireMember, async (req, res) => {
  res.json(await levels.leaderboard(req.member.guild.id, {
    limit: queryNumber(req.query.limit, 50, 1, 100),
    offset: queryNumber(req.query.offset, 0, 0, 100000),
  }));
});

router.get('/guilds/:guildId/levels/members/:userId', authenticateJWT, requireMember, async (req, res) => {
  const userId = Number(req.params.userId);
  const isMember = Number.isInteger(userId) && await db.get('SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?', [req.member.guild.id, userId]);
  if (!isMember) return res.status(404).json({ error: 'Member not found' });
  res.json(await levels.memberLevel(req.member.guild.id, userId));
});

// One of { xp } or { level } (set), { addXp } or { addLevels } (add, or take away below 0).
router.patch('/guilds/:guildId/levels/members/:userId', authenticateJWT, requireMember, withActionErrors(async (req, res) => {
  res.json(await levels.changeMemberXp(req.member, Number(req.params.userId), req.body ?? {}));
}));

module.exports = router;
