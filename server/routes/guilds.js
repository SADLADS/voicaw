const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const { authenticateJWT } = require('../auth');
const { sendToUserSockets, isOnline } = require('../sockets');
const {
  MAX_GUILD_NAME,
  MAX_CATEGORY_NAME,
  MAX_TOPIC,
  getGuildForMember,
  getGuildLayout,
  getMemberIds,
  sendToGuild,
  announceGuildUpdate,
  normalizeChannelName,
  cleanName,
  nextPosition,
  deleteChannelContents,
  markGuildRead,
} = require('../guilds');

// Guilds (servers): creating and managing them, members, bans, invites, categories and
// channels. Messages are in routes/guildMessages.js. Guilds are not end-to-end encrypted.
const router = express.Router();

const MAX_INVITE_AGE = 30 * 24 * 60 * 60;
const MAX_INVITE_USES = 1000;

const now = () => Math.floor(Date.now() / 1000);

// Loads the guild into req.guild if the caller is a member (404 otherwise, so non-members
// can't tell which guilds exist).
async function requireMember(req, res, next) {
  const guild = await getGuildForMember(Number(req.params.guildId), req.user.id);
  if (!guild) return res.status(404).json({ error: 'Guild not found' });
  req.guild = guild;
  next();
}

function requireOwner(req, res, next) {
  if (req.guild.owner !== req.user.id) return res.status(403).json({ error: 'Only the owner can do that' });
  next();
}

const member = [authenticateJWT, requireMember];
const owner = [authenticateJWT, requireMember, requireOwner];

// ---- Guilds ----

// The caller's guilds, in the order they joined them.
router.get('/guilds', authenticateJWT, async (req, res) => {
  res.json(await db.all(
    `SELECT g.id, g.name, g.owner, g.icon_version, g.created_at
     FROM guilds g JOIN guild_members gm ON gm.guild_id = g.id
     WHERE gm.user_id = ? ORDER BY gm.joined_at, g.id`,
    [req.user.id]
  ));
});

// A new guild starts with a "Text Channels" category holding #general.
router.post('/guilds', authenticateJWT, async (req, res) => {
  const name = cleanName(req.body?.name, MAX_GUILD_NAME);
  if (!name) return res.status(400).json({ error: `Guild names are 1–${MAX_GUILD_NAME} characters` });

  const { lastID: guildId } = await db.run(
    'INSERT INTO guilds (owner, name, created_at) VALUES (?, ?, ?)',
    [req.user.id, name, now()]
  );
  await db.run('INSERT INTO guild_members (guild_id, user_id) VALUES (?, ?)', [guildId, req.user.id]);
  const { lastID: categoryId } = await db.run(
    'INSERT INTO guild_categories (guild_id, name, position) VALUES (?, ?, 0)',
    [guildId, 'Text Channels']
  );
  await db.run(
    `INSERT INTO guild_channels (guild_id, category_id, name, type, position) VALUES (?, ?, 'general', 'text', 0)`,
    [guildId, categoryId]
  );

  const guild = await getGuildLayout(guildId);
  sendToUserSockets(req.user.id, { type: 'guild_add', guild });
  res.status(201).json(guild);
});

router.get('/guilds/:guildId', member, async (req, res) => {
  res.json(await getGuildLayout(req.guild.id));
});

// Rename, and/or `iconUploaded: true` once a new icon is in the object store (see
// /upload_guild_icon), or `icon: null` to remove it.
router.patch('/guilds/:guildId', owner, async (req, res) => {
  const { name: rawName, iconUploaded, icon } = req.body ?? {};
  if (rawName !== undefined) {
    const name = cleanName(rawName, MAX_GUILD_NAME);
    if (!name) return res.status(400).json({ error: `Guild names are 1–${MAX_GUILD_NAME} characters` });
    await db.run('UPDATE guilds SET name = ? WHERE id = ?', [name, req.guild.id]);
  }
  if (iconUploaded === true) {
    await db.run('UPDATE guilds SET icon_version = icon_version + 1 WHERE id = ?', [req.guild.id]);
  } else if (icon === null) {
    await db.run('UPDATE guilds SET icon_version = 0 WHERE id = ?', [req.guild.id]);
  }
  await announceGuildUpdate(req.guild.id);
  res.json(await getGuildLayout(req.guild.id));
});

router.delete('/guilds/:guildId', owner, async (req, res) => {
  const guildId = req.guild.id;
  const memberIds = await getMemberIds(guildId);

  await deleteChannelContents('SELECT id FROM guild_channels WHERE guild_id = ?', [guildId]);
  for (const table of ['guild_channels', 'guild_categories', 'guild_invites', 'guild_bans', 'guild_members']) {
    await db.run(`DELETE FROM ${table} WHERE guild_id = ?`, [guildId]);
  }
  await db.run('DELETE FROM guilds WHERE id = ?', [guildId]);

  for (const userId of memberIds) sendToUserSockets(userId, { type: 'guild_remove', guildId });
  res.json({ success: true });
});

// Hands the guild to another member.
router.post('/guilds/:guildId/transfer', owner, async (req, res) => {
  const userId = Number(req.body?.userId);
  if (!(await getGuildForMember(req.guild.id, userId))) {
    return res.status(400).json({ error: 'The new owner must be a member' });
  }
  await db.run('UPDATE guilds SET owner = ? WHERE id = ?', [userId, req.guild.id]);
  await announceGuildUpdate(req.guild.id);
  res.json({ success: true });
});

// ---- Members and bans ----

router.get('/guilds/:guildId/members', member, async (req, res) => {
  const members = await db.all(
    `SELECT u.id, u.username, gm.joined_at
     FROM guild_members gm JOIN users u ON u.id = gm.user_id
     WHERE gm.guild_id = ? ORDER BY u.username COLLATE NOCASE`,
    [req.guild.id]
  );
  res.json(members.map((m) => ({ ...m, online: isOnline(m.id) })));
});

// Takes `userId` out of the guild and tells everyone (including them).
async function removeMember(guildId, userId) {
  await db.run('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  await db.run(
    'DELETE FROM guild_channel_reads WHERE user_id = ? AND channel_id IN (SELECT id FROM guild_channels WHERE guild_id = ?)',
    [userId, guildId]
  );
  sendToUserSockets(userId, { type: 'guild_remove', guildId });
  await sendToGuild(guildId, { type: 'guild_member_remove', guildId, userId });
}

// Leave. The owner has to hand the guild over (or delete it) first.
router.delete('/guilds/:guildId/members/me', member, async (req, res) => {
  if (req.guild.owner === req.user.id) {
    return res.status(400).json({ error: 'Transfer ownership or delete the guild before leaving' });
  }
  await removeMember(req.guild.id, req.user.id);
  res.json({ success: true });
});

// Kick.
router.delete('/guilds/:guildId/members/:userId', owner, async (req, res) => {
  const userId = Number(req.params.userId);
  if (userId === req.user.id) return res.status(400).json({ error: "You can't kick yourself" });
  if (!(await getGuildForMember(req.guild.id, userId))) return res.status(404).json({ error: 'Not a member' });
  await removeMember(req.guild.id, userId);
  res.json({ success: true });
});

router.get('/guilds/:guildId/bans', owner, async (req, res) => {
  res.json(await db.all(
    `SELECT u.id, u.username, b.created_at FROM guild_bans b JOIN users u ON u.id = b.user_id
     WHERE b.guild_id = ? ORDER BY b.created_at DESC`,
    [req.guild.id]
  ));
});

// Bans (and removes) a user; they can't rejoin through an invite until unbanned.
router.put('/guilds/:guildId/bans/:userId', owner, async (req, res) => {
  const userId = Number(req.params.userId);
  if (userId === req.user.id) return res.status(400).json({ error: "You can't ban yourself" });
  if (!Number.isInteger(userId) || !(await db.get('SELECT id FROM users WHERE id = ?', [userId]))) {
    return res.status(404).json({ error: 'User not found' });
  }
  await db.run(
    'INSERT OR IGNORE INTO guild_bans (guild_id, user_id, banned_by) VALUES (?, ?, ?)',
    [req.guild.id, userId, req.user.id]
  );
  if (await getGuildForMember(req.guild.id, userId)) await removeMember(req.guild.id, userId);
  res.json({ success: true });
});

router.delete('/guilds/:guildId/bans/:userId', owner, async (req, res) => {
  await db.run('DELETE FROM guild_bans WHERE guild_id = ? AND user_id = ?', [req.guild.id, Number(req.params.userId)]);
  res.json({ success: true });
});

// ---- Invites ----

// 8 characters from [A-Za-z0-9].
function newInviteCode() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join('');
}

const INVITE_SELECT = `
  SELECT i.code, i.guild_id, i.creator_id, u.username AS creator_username, i.created_at,
         i.expires_at, i.max_uses, i.uses
  FROM guild_invites i JOIN users u ON u.id = i.creator_id`;

// An invite that can still be used.
const INVITE_VALID = `(i.expires_at IS NULL OR i.expires_at > strftime('%s','now'))
  AND (i.max_uses IS NULL OR i.uses < i.max_uses)`;

// Any member can invite. `maxAge` (seconds) and `maxUses`: 0 or missing = no limit.
router.post('/guilds/:guildId/invites', member, async (req, res) => {
  const maxAge = Number(req.body?.maxAge ?? 0);
  const maxUses = Number(req.body?.maxUses ?? 0);
  if (!Number.isInteger(maxAge) || maxAge < 0 || maxAge > MAX_INVITE_AGE) {
    return res.status(400).json({ error: 'Invalid maxAge' });
  }
  if (!Number.isInteger(maxUses) || maxUses < 0 || maxUses > MAX_INVITE_USES) {
    return res.status(400).json({ error: 'Invalid maxUses' });
  }
  const code = newInviteCode();
  await db.run(
    'INSERT INTO guild_invites (code, guild_id, creator_id, expires_at, max_uses) VALUES (?, ?, ?, ?, ?)',
    [code, req.guild.id, req.user.id, maxAge ? now() + maxAge : null, maxUses || null]
  );
  res.status(201).json(await db.get(`${INVITE_SELECT} WHERE i.code = ?`, [code]));
});

// The guild's working invites (the owner's view, to revoke them).
router.get('/guilds/:guildId/invites', owner, async (req, res) => {
  res.json(await db.all(
    `${INVITE_SELECT} WHERE i.guild_id = ? AND ${INVITE_VALID} ORDER BY i.created_at DESC`,
    [req.guild.id]
  ));
});

// The creator or the owner can revoke an invite.
router.delete('/invites/:code', authenticateJWT, async (req, res) => {
  const invite = await db.get(
    'SELECT i.code, i.creator_id, g.owner FROM guild_invites i JOIN guilds g ON g.id = i.guild_id WHERE i.code = ?',
    [req.params.code]
  );
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  if (invite.creator_id !== req.user.id && invite.owner !== req.user.id) {
    return res.status(403).json({ error: 'Not your invite' });
  }
  await db.run('DELETE FROM guild_invites WHERE code = ?', [invite.code]);
  res.json({ success: true });
});

// What the invite page shows before joining.
router.get('/invites/:code', authenticateJWT, async (req, res) => {
  const invite = await db.get(
    `SELECT i.code, g.id AS guild_id, g.name, g.icon_version, u.username AS creator_username,
            (SELECT COUNT(*) FROM guild_members WHERE guild_id = g.id) AS member_count,
            EXISTS (SELECT 1 FROM guild_members WHERE guild_id = g.id AND user_id = ?) AS is_member
     FROM guild_invites i JOIN guilds g ON g.id = i.guild_id JOIN users u ON u.id = i.creator_id
     WHERE i.code = ? AND ${INVITE_VALID}`,
    [req.user.id, req.params.code]
  );
  if (!invite) return res.status(404).json({ error: 'This invite is invalid or has expired' });
  res.json({ ...invite, is_member: Boolean(invite.is_member) });
});

// Joins through an invite. Joining a guild you're already in is a no-op (uses no use).
router.post('/invites/:code', authenticateJWT, async (req, res) => {
  const userId = req.user.id;
  const invite = await db.get('SELECT guild_id FROM guild_invites WHERE code = ?', [req.params.code]);
  if (!invite) return res.status(404).json({ error: 'This invite is invalid or has expired' });
  const guildId = invite.guild_id;

  if (await getGuildForMember(guildId, userId)) return res.json(await getGuildLayout(guildId));
  if (await db.get('SELECT 1 FROM guild_bans WHERE guild_id = ? AND user_id = ?', [guildId, userId])) {
    return res.status(403).json({ error: 'You are banned from this guild' });
  }

  // Claims a use only if the invite is still good (atomic, so the last use can't go twice).
  const { changes } = await db.run(
    `UPDATE guild_invites AS i SET uses = uses + 1 WHERE code = ? AND ${INVITE_VALID}`,
    [req.params.code]
  );
  if (!changes) return res.status(404).json({ error: 'This invite is invalid or has expired' });

  await db.run('INSERT OR IGNORE INTO guild_members (guild_id, user_id) VALUES (?, ?)', [guildId, userId]);
  await markGuildRead(guildId, userId);

  const guild = await getGuildLayout(guildId);
  const joined = await db.get(
    `SELECT u.id, u.username, gm.joined_at FROM guild_members gm JOIN users u ON u.id = gm.user_id
     WHERE gm.guild_id = ? AND gm.user_id = ?`,
    [guildId, userId]
  );
  sendToUserSockets(userId, { type: 'guild_add', guild });
  await sendToGuild(guildId, { type: 'guild_member_add', guildId, member: { ...joined, online: isOnline(userId) } });
  res.status(201).json(guild);
});

// ---- Categories and channels (owner only) ----

router.post('/guilds/:guildId/categories', owner, async (req, res) => {
  const name = cleanName(req.body?.name, MAX_CATEGORY_NAME);
  if (!name) return res.status(400).json({ error: `Category names are 1–${MAX_CATEGORY_NAME} characters` });
  const position = await nextPosition('guild_categories', 'guild_id = ?', [req.guild.id]);
  const { lastID } = await db.run(
    'INSERT INTO guild_categories (guild_id, name, position) VALUES (?, ?, ?)',
    [req.guild.id, name, position]
  );
  await announceGuildUpdate(req.guild.id);
  res.status(201).json({ id: lastID, name, position });
});

router.patch('/guilds/:guildId/categories/:categoryId', owner, async (req, res) => {
  const name = cleanName(req.body?.name, MAX_CATEGORY_NAME);
  if (!name) return res.status(400).json({ error: `Category names are 1–${MAX_CATEGORY_NAME} characters` });
  const { changes } = await db.run(
    'UPDATE guild_categories SET name = ? WHERE id = ? AND guild_id = ?',
    [name, Number(req.params.categoryId), req.guild.id]
  );
  if (!changes) return res.status(404).json({ error: 'Category not found' });
  await announceGuildUpdate(req.guild.id);
  res.json({ success: true });
});

// Its channels move out of it (to the top, uncategorised), as in Discord.
router.delete('/guilds/:guildId/categories/:categoryId', owner, async (req, res) => {
  const categoryId = Number(req.params.categoryId);
  const { changes } = await db.run(
    'DELETE FROM guild_categories WHERE id = ? AND guild_id = ?',
    [categoryId, req.guild.id]
  );
  if (!changes) return res.status(404).json({ error: 'Category not found' });
  await db.run('UPDATE guild_channels SET category_id = NULL WHERE category_id = ?', [categoryId]);
  await announceGuildUpdate(req.guild.id);
  res.json({ success: true });
});

// `categoryId` must be one of this guild's categories (or null).
async function checkCategory(guildId, categoryId) {
  if (categoryId == null) return true;
  return Boolean(Number.isInteger(categoryId) && await db.get(
    'SELECT id FROM guild_categories WHERE id = ? AND guild_id = ?',
    [categoryId, guildId]
  ));
}

router.post('/guilds/:guildId/channels', owner, async (req, res) => {
  const { type = 'text', topic } = req.body ?? {};
  const categoryId = req.body?.categoryId ?? null;
  const name = normalizeChannelName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Channel names are 1–100 characters' });
  if (type !== 'text' && type !== 'voice') return res.status(400).json({ error: 'Invalid channel type' });
  if (topic != null && (typeof topic !== 'string' || topic.length > MAX_TOPIC)) {
    return res.status(400).json({ error: 'Invalid topic' });
  }
  if (!(await checkCategory(req.guild.id, categoryId))) return res.status(400).json({ error: 'Invalid category' });

  const position = await nextPosition('guild_channels', 'guild_id = ?', [req.guild.id]);
  const { lastID } = await db.run(
    'INSERT INTO guild_channels (guild_id, category_id, name, type, topic, position) VALUES (?, ?, ?, ?, ?, ?)',
    [req.guild.id, categoryId, name, type, topic?.trim() || null, position]
  );
  await announceGuildUpdate(req.guild.id);
  res.status(201).json(await db.get(
    'SELECT id, category_id, name, type, topic, position FROM guild_channels WHERE id = ?',
    [lastID]
  ));
});

// Rename, change the topic, or move to another category.
router.patch('/guilds/:guildId/channels/:channelId', owner, async (req, res) => {
  const channelId = Number(req.params.channelId);
  const channel = await db.get('SELECT id FROM guild_channels WHERE id = ? AND guild_id = ?', [channelId, req.guild.id]);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  const body = req.body ?? {};
  const updates = [];
  const params = [];
  if (body.name !== undefined) {
    const name = normalizeChannelName(body.name);
    if (!name) return res.status(400).json({ error: 'Channel names are 1–100 characters' });
    updates.push('name = ?');
    params.push(name);
  }
  if (body.topic !== undefined) {
    if (body.topic !== null && (typeof body.topic !== 'string' || body.topic.length > MAX_TOPIC)) {
      return res.status(400).json({ error: 'Invalid topic' });
    }
    updates.push('topic = ?');
    params.push(body.topic?.trim() || null);
  }
  if (body.categoryId !== undefined) {
    if (!(await checkCategory(req.guild.id, body.categoryId))) return res.status(400).json({ error: 'Invalid category' });
    updates.push('category_id = ?');
    params.push(body.categoryId);
  }
  if (updates.length) {
    await db.run(`UPDATE guild_channels SET ${updates.join(', ')} WHERE id = ?`, [...params, channelId]);
    await announceGuildUpdate(req.guild.id);
  }
  res.json(await db.get('SELECT id, category_id, name, type, topic, position FROM guild_channels WHERE id = ?', [channelId]));
});

// Deletes the channel and its messages.
router.delete('/guilds/:guildId/channels/:channelId', owner, async (req, res) => {
  const channelId = Number(req.params.channelId);
  const channel = await db.get('SELECT id FROM guild_channels WHERE id = ? AND guild_id = ?', [channelId, req.guild.id]);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  await deleteChannelContents('?', [channelId]);
  await db.run('DELETE FROM guild_channels WHERE id = ?', [channelId]);
  await announceGuildUpdate(req.guild.id);
  res.json({ success: true });
});

// Reorders everything at once (what a drag and drop produces): `categories` is every category
// id in order, `channels` every channel as { id, categoryId } in order.
router.put('/guilds/:guildId/layout', owner, async (req, res) => {
  const { categories, channels } = req.body ?? {};
  const layout = await getGuildLayout(req.guild.id);
  const sameIds = (given, existing) =>
    Array.isArray(given) && given.length === existing.length &&
    new Set(given).size === given.length &&
    given.every((id) => existing.some((e) => e.id === id));

  if (!sameIds(categories, layout.categories)) {
    return res.status(400).json({ error: 'categories must list every category once' });
  }
  if (!Array.isArray(channels) || !sameIds(channels.map((c) => c?.id), layout.channels)) {
    return res.status(400).json({ error: 'channels must list every channel once' });
  }
  if (channels.some((c) => c.categoryId != null && !categories.includes(c.categoryId))) {
    return res.status(400).json({ error: 'Invalid category' });
  }

  for (const [position, id] of categories.entries()) {
    await db.run('UPDATE guild_categories SET position = ? WHERE id = ?', [position, id]);
  }
  for (const [position, { id, categoryId }] of channels.entries()) {
    await db.run('UPDATE guild_channels SET position = ?, category_id = ? WHERE id = ?', [position, categoryId ?? null, id]);
  }
  await announceGuildUpdate(req.guild.id);
  res.json(await getGuildLayout(req.guild.id));
});

module.exports = router;
