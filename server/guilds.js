const db = require('./db');
const { sendToUserSockets } = require('./sockets');

// Shared by the guild routes: who's in a guild, what it looks like, and telling its members.
// Until roles exist, the owner manages everything and members can only chat and invite.

const MAX_GUILD_NAME = 100;
const MAX_CHANNEL_NAME = 100;
const MAX_CATEGORY_NAME = 100;
const MAX_TOPIC = 1024;

// The guild if `userId` is a member, else null.
async function getGuildForMember(guildId, userId) {
  if (!Number.isInteger(guildId)) return null;
  return (await db.get(
    `SELECT g.id, g.name, g.owner, g.icon_version, g.created_at
     FROM guilds g JOIN guild_members gm ON gm.guild_id = g.id
     WHERE g.id = ? AND gm.user_id = ?`,
    [guildId, userId]
  )) ?? null;
}

// The channel (with its guild's owner) if `userId` is a member of its guild, else null.
async function getChannelForMember(channelId, userId) {
  if (!Number.isInteger(channelId)) return null;
  return (await db.get(
    `SELECT c.id, c.guild_id, c.category_id, c.name, c.type, c.topic, c.position, g.owner
     FROM guild_channels c
     JOIN guilds g ON g.id = c.guild_id
     JOIN guild_members gm ON gm.guild_id = c.guild_id AND gm.user_id = ?
     WHERE c.id = ?`,
    [userId, channelId]
  )) ?? null;
}

// A guild with its categories and channels, each in display order: what the client draws the
// channel sidebar from (GET /guilds/:id, and the `guild_update` event).
async function getGuildLayout(guildId) {
  const guild = await db.get(
    'SELECT id, name, owner, icon_version, created_at FROM guilds WHERE id = ?',
    [guildId]
  );
  if (!guild) return null;
  const categories = await db.all(
    'SELECT id, name, position FROM guild_categories WHERE guild_id = ? ORDER BY position, id',
    [guildId]
  );
  const channels = await db.all(
    `SELECT id, category_id, name, type, topic, position FROM guild_channels
     WHERE guild_id = ? ORDER BY position, id`,
    [guildId]
  );
  return { ...guild, categories, channels };
}

async function getMemberIds(guildId) {
  const rows = await db.all('SELECT user_id FROM guild_members WHERE guild_id = ?', [guildId]);
  return rows.map((r) => r.user_id);
}

async function sendToGuild(guildId, payload) {
  for (const userId of await getMemberIds(guildId)) sendToUserSockets(userId, payload);
}

// Everyone in the guild gets its new layout.
async function announceGuildUpdate(guildId) {
  const guild = await getGuildLayout(guildId);
  if (guild) await sendToGuild(guildId, { type: 'guild_update', guild });
}

// Channel names are Discord style: lower case, no spaces.
function normalizeChannelName(name) {
  if (typeof name !== 'string') return null;
  const normalized = name.trim().toLowerCase().replace(/\s+/g, '-');
  return normalized && normalized.length <= MAX_CHANNEL_NAME ? normalized : null;
}

// A trimmed, non-empty name of at most `max` characters, else null.
function cleanName(name, max) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

// The next position at the end of a list.
async function nextPosition(table, where, params) {
  const row = await db.get(`SELECT MAX(position) AS max FROM ${table} WHERE ${where}`, params);
  return row.max == null ? 0 : row.max + 1;
}

// Deletes a channel's messages, their reactions, and read markers (not the channel).
async function deleteChannelContents(channelIdsSql, params) {
  await db.run(
    `DELETE FROM guild_reactions WHERE message_id IN
       (SELECT id FROM guild_messages WHERE channel_id IN (${channelIdsSql}))`,
    params
  );
  await db.run(`DELETE FROM guild_messages WHERE channel_id IN (${channelIdsSql})`, params);
  await db.run(`DELETE FROM guild_channel_reads WHERE channel_id IN (${channelIdsSql})`, params);
}

// Marks every channel of the guild read up to now for a new member, so joining doesn't show
// the whole history as unread.
async function markGuildRead(guildId, userId) {
  await db.run(
    `INSERT INTO guild_channel_reads (user_id, channel_id, last_read_id)
     SELECT ?, c.id, COALESCE((SELECT MAX(id) FROM guild_messages WHERE channel_id = c.id), 0)
     FROM guild_channels c WHERE c.guild_id = ?
     ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = excluded.last_read_id`,
    [userId, guildId]
  );
}

module.exports = {
  MAX_GUILD_NAME,
  MAX_CATEGORY_NAME,
  MAX_TOPIC,
  getGuildForMember,
  getChannelForMember,
  getGuildLayout,
  getMemberIds,
  sendToGuild,
  announceGuildUpdate,
  normalizeChannelName,
  cleanName,
  nextPosition,
  deleteChannelContents,
  markGuildRead,
};
