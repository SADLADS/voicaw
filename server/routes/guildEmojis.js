const express = require('express');
const db = require('../db');
const { authenticateJWT } = require('../auth');
const { sendToUserSockets } = require('../sockets');
const { getUploadUrl, getObject, putObject, deleteObject } = require('../s3');
const { shrinkEmoji, EmojiImageError, MAX_EMOJI_UPLOAD_BYTES } = require('../emojiImage');
const { PERMISSIONS, has } = require('../permissions');
const { getMember, getMemberIds } = require('../guilds');

// Custom emoji (per guild, like Discord's) and each member's order of their guilds in the
// server rail (which is also the order of the emoji picker's guild sections).
//
// Emoji are plain images (not encrypted), stored as emojis/<id> in the public "emojis" bucket
// and written `<:name:id>` in messages, so showing one needs nothing but its id. Adding one
// takes two steps: POST creates it (not yet available) and returns a pre-signed URL for the
// original (up to 10 MB, to emojis/src/<id>); once that's uploaded, POST .../ready has the
// server shrink it (emojiImage.js: 128×128 WebP, animation kept), store it as emojis/<id>,
// delete the original, and make the emoji available. Members of any of your guilds'
// emoji can use them anywhere (in DMs too); managing them needs Manage Emoji.
const router = express.Router();

const MAX_EMOJIS_PER_GUILD = 50;
const EMOJI_TYPES = new Set(['image/png', 'image/gif', 'image/webp', 'image/jpeg', 'image/avif']);
const EMOJI_NAME = /^[A-Za-z0-9_]{2,32}$/;
// An upload that never finished stops counting after this long.
const PENDING_TTL_SECONDS = 60 * 60;

const EMOJI_COLUMNS = 'e.id, e.guild_id, e.name, e.animated';

async function requireMember(req, res, next) {
  const member = await getMember(Number(req.params.guildId), req.user.id);
  if (!member) return res.status(404).json({ error: 'Guild not found' });
  req.member = member;
  req.guild = member.guild;
  next();
}

function requireManageEmojis(req, res, next) {
  if (!has(req.member.permissions, PERMISSIONS.MANAGE_EMOJIS)) {
    return res.status(403).json({ error: "You don't have permission to do that" });
  }
  next();
}

const manage = [authenticateJWT, requireMember, requireManageEmojis];

// The guild's available emoji, oldest first.
async function guildEmojis(guildId) {
  return db.all(
    `SELECT ${EMOJI_COLUMNS} FROM guild_emojis e WHERE e.guild_id = ? AND e.available = 1 ORDER BY e.id`,
    [guildId]
  );
}

// Every member gets the guild's new emoji list.
async function announceEmojis(guildId) {
  const emojis = await guildEmojis(guildId);
  for (const userId of await getMemberIds(guildId)) {
    sendToUserSockets(userId, { type: 'guild_emojis_update', guildId, emojis });
  }
}

async function findEmoji(req) {
  return db.get(
    'SELECT id, guild_id, name, animated, available FROM guild_emojis WHERE id = ? AND guild_id = ?',
    [Number(req.params.emojiId), req.guild.id]
  );
}

// The emoji of all the caller's guilds (what the picker offers), as [{ id, guild_id, name,
// animated }], by guild in the caller's rail order, then oldest first.
router.get('/emojis', authenticateJWT, async (req, res) => {
  res.json(await db.all(
    `SELECT ${EMOJI_COLUMNS} FROM guild_emojis e
     JOIN guild_members gm ON gm.guild_id = e.guild_id AND gm.user_id = ?
     WHERE e.available = 1 ORDER BY gm.position, gm.joined_at, e.guild_id, e.id`,
    [req.user.id]
  ));
});

// A guild's emoji with who added them (the settings list).
router.get('/guilds/:guildId/emojis', authenticateJWT, requireMember, async (req, res) => {
  res.json(await db.all(
    `SELECT ${EMOJI_COLUMNS}, e.creator_id, u.username AS creator_username, e.created_at
     FROM guild_emojis e JOIN users u ON u.id = e.creator_id
     WHERE e.guild_id = ? AND e.available = 1 ORDER BY e.id`,
    [req.guild.id]
  ));
});

// Starts adding an emoji: { name, type, size } → { emoji, uploadUrl }. Then PUT the image to
// uploadUrl (the size and type are signed into it) and POST .../ready.
router.post('/guilds/:guildId/emojis', manage, async (req, res) => {
  const { name, type } = req.body ?? {};
  const size = Number(req.body?.size);
  if (typeof name !== 'string' || !EMOJI_NAME.test(name)) {
    return res.status(400).json({ error: 'Emoji names are 2–32 letters, numbers or underscores' });
  }
  if (!EMOJI_TYPES.has(type)) return res.status(400).json({ error: 'Emoji must be PNG, GIF, WebP, JPEG or AVIF images' });
  if (!Number.isInteger(size) || size <= 0) return res.status(400).json({ error: 'Missing or invalid size' });
  if (size > MAX_EMOJI_UPLOAD_BYTES) {
    return res.status(413).json({ error: `Emoji images must be under ${MAX_EMOJI_UPLOAD_BYTES / 1024 / 1024} MB` });
  }

  // Uploads that were never finished are forgotten (with any original left behind).
  const stale = await db.all(
    `SELECT id FROM guild_emojis WHERE guild_id = ? AND available = 0 AND created_at < strftime('%s','now') - ?`,
    [req.guild.id, PENDING_TTL_SECONDS]
  );
  for (const { id } of stale) {
    await db.run('DELETE FROM guild_emojis WHERE id = ?', [id]);
    await deleteObject('emojis', `src/${id}`);
  }
  const { count } = await db.get('SELECT COUNT(*) AS count FROM guild_emojis WHERE guild_id = ?', [req.guild.id]);
  if (count >= MAX_EMOJIS_PER_GUILD) {
    return res.status(400).json({ error: `A server can have at most ${MAX_EMOJIS_PER_GUILD} emoji` });
  }
  if (await db.get('SELECT 1 FROM guild_emojis WHERE guild_id = ? AND name = ?', [req.guild.id, name])) {
    return res.status(409).json({ error: `This server already has an emoji called :${name}:` });
  }

  const { lastID } = await db.run(
    'INSERT INTO guild_emojis (guild_id, name, animated, creator_id) VALUES (?, ?, ?, ?)',
    [req.guild.id, name, type === 'image/gif' ? 1 : 0, req.user.id]
  );
  try {
    const uploadUrl = await getUploadUrl(`src/${lastID}`, 'emojis', type, size);
    res.status(201).json({ emoji: { id: lastID, guild_id: req.guild.id, name, animated: type === 'image/gif' ? 1 : 0 }, uploadUrl });
  } catch (err) {
    console.error(err);
    await db.run('DELETE FROM guild_emojis WHERE id = ?', [lastID]);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// The original is uploaded: shrink it into the emoji and make that available to everyone. If
// it's not a usable image, the emoji is dropped (400 with the reason).
router.post('/guilds/:guildId/emojis/:emojiId/ready', manage, async (req, res) => {
  const emoji = await findEmoji(req);
  if (!emoji) return res.status(404).json({ error: 'Emoji not found' });
  if (emoji.available) return res.json({ id: emoji.id, guild_id: emoji.guild_id, name: emoji.name, animated: emoji.animated });

  const source = `src/${emoji.id}`;
  let original;
  try {
    original = await getObject('emojis', source);
  } catch (err) {
    console.error('Emoji original missing:', err.code || err.name);
    return res.status(400).json({ error: "The image wasn't uploaded. Try again." });
  }

  let image;
  try {
    image = await shrinkEmoji(original);
  } catch (err) {
    await db.run('DELETE FROM guild_emojis WHERE id = ?', [emoji.id]);
    await deleteObject('emojis', source);
    if (err instanceof EmojiImageError) return res.status(400).json({ error: err.message });
    throw err;
  }

  await putObject('emojis', String(emoji.id), image.buffer, image.contentType);
  await deleteObject('emojis', source);
  await db.run('UPDATE guild_emojis SET available = 1, animated = ? WHERE id = ?', [image.animated ? 1 : 0, emoji.id]);
  await announceEmojis(req.guild.id);
  res.json({ id: emoji.id, guild_id: emoji.guild_id, name: emoji.name, animated: image.animated ? 1 : 0 });
});

// Rename. (Messages keep the old name in their `<:name:id>`; the image follows the id.)
router.patch('/guilds/:guildId/emojis/:emojiId', manage, async (req, res) => {
  const emoji = await findEmoji(req);
  if (!emoji || !emoji.available) return res.status(404).json({ error: 'Emoji not found' });
  const { name } = req.body ?? {};
  if (typeof name !== 'string' || !EMOJI_NAME.test(name)) {
    return res.status(400).json({ error: 'Emoji names are 2–32 letters, numbers or underscores' });
  }
  if (await db.get('SELECT 1 FROM guild_emojis WHERE guild_id = ? AND name = ? AND id != ?', [req.guild.id, name, emoji.id])) {
    return res.status(409).json({ error: `This server already has an emoji called :${name}:` });
  }
  await db.run('UPDATE guild_emojis SET name = ? WHERE id = ?', [name, emoji.id]);
  await announceEmojis(req.guild.id);
  res.json({ id: emoji.id, guild_id: emoji.guild_id, name, animated: emoji.animated });
});

// Delete: the image goes too, so messages using it fall back to showing `:name:`.
router.delete('/guilds/:guildId/emojis/:emojiId', manage, async (req, res) => {
  const emoji = await findEmoji(req);
  if (!emoji) return res.status(404).json({ error: 'Emoji not found' });
  await db.run('DELETE FROM guild_emojis WHERE id = ?', [emoji.id]);
  await deleteObject('emojis', String(emoji.id));
  await announceEmojis(req.guild.id);
  res.json({ success: true });
});

// ---- Server rail order ----

// Sets the caller's order of their guilds: `guildIds`, every guild they're in, top first.
// Their other devices follow (`guild_order`).
router.put('/guilds-order', authenticateJWT, async (req, res) => {
  const { guildIds } = req.body ?? {};
  const mine = (await db.all('SELECT guild_id FROM guild_members WHERE user_id = ?', [req.user.id])).map((r) => r.guild_id);
  const valid = Array.isArray(guildIds) && guildIds.length === mine.length &&
    new Set(guildIds).size === guildIds.length && guildIds.every((id) => mine.includes(id));
  if (!valid) return res.status(400).json({ error: 'guildIds must list each of your guilds once' });

  for (const [position, guildId] of guildIds.entries()) {
    await db.run('UPDATE guild_members SET position = ? WHERE guild_id = ? AND user_id = ?', [position, guildId, req.user.id]);
  }
  sendToUserSockets(req.user.id, { type: 'guild_order', guildIds });
  res.json({ success: true });
});

module.exports = router;
