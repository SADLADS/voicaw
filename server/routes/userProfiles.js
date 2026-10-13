const express = require('express');
const db = require('../db');
const { authenticateJWT } = require('../auth');
const { PROFILE_COLUMNS } = require('../profiles');
const { getPreferences } = require('../preferences');
const { blockedBetween } = require('../blocks');
const { historyOf } = require('../activityHistory');

// Someone's full profile's tabs (the profile window): beyond what everyone already has of their
// profile (names, picture, banner, bio...), the games they played over the last 30 days
// (activityHistory.js), the friends you share and the guilds you're both in. Each is null when
// they've hidden it (Settings → Privacy: showActivity, showMutualFriends, showMutualGuilds),
// and all of them when either of you blocked the other. Your own: your activity (shown even if
// hidden from others, with `hidden` saying which are), no mutuals.
const router = express.Router();

router.get('/users/:userId/profile', authenticateJWT, async (req, res) => {
  const userId = Number(req.params.userId);
  const viewerId = req.user.id;
  const user = Number.isInteger(userId)
    ? await db.get('SELECT id, bot, account_created FROM users WHERE id = ? AND pending = 0 AND deleted_at IS NULL', [userId])
    : null;
  if (!user) return res.status(404).json({ error: 'User not found' });
  const prefs = await getPreferences(userId);
  const memberSince = user.account_created ?? null;

  if (userId === viewerId) {
    return res.json({
      memberSince,
      activity: await historyOf(userId),
      mutualFriends: null,
      mutualGuilds: null,
      hidden: { activity: !prefs.showActivity, mutualFriends: !prefs.showMutualFriends, mutualGuilds: !prefs.showMutualGuilds },
    });
  }
  if (await blockedBetween(viewerId, userId)) {
    return res.json({ memberSince, activity: null, mutualFriends: null, mutualGuilds: null });
  }

  const columns = PROFILE_COLUMNS.split(', ').map((c) => `u.${c}`).join(', ');
  const mutualFriends = prefs.showMutualFriends
    ? await db.all(
      `SELECT u.id, u.username, ${columns} FROM friends a
         JOIN friends b ON b.friend_id = a.friend_id
         JOIN users u ON u.id = a.friend_id
        WHERE a.user_id = ? AND b.user_id = ? AND u.deleted_at IS NULL
        ORDER BY LOWER(COALESCE(u.display_name, u.username))`,
      [userId, viewerId]
    )
    : null;
  const mutualGuilds = prefs.showMutualGuilds
    ? await db.all(
      `SELECT g.id, g.name, g.icon_version FROM guild_members a
         JOIN guild_members b ON b.guild_id = a.guild_id
         JOIN guilds g ON g.id = a.guild_id
        WHERE a.user_id = ? AND b.user_id = ?
        ORDER BY LOWER(g.name)`,
      [userId, viewerId]
    )
    : null;
  res.json({
    memberSince,
    // Bots never have any (activityHistory.js records people only).
    activity: prefs.showActivity && !user.bot ? await historyOf(userId) : null,
    mutualFriends,
    mutualGuilds,
  });
});

module.exports = router;
