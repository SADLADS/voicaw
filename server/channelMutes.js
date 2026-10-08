const db = require('./db');

// Muted channels, each member's own (like Discord's "Mute Channel"): a muted channel's messages
// don't mark it unread on their devices and don't push to them (nor play the Message sound),
// except messages that mention them. A mute lasts `duration` seconds or, without one, until
// they unmute it. Expired rows are just ignored (and cleared the next time they're listed).

const MAX_MUTE_SECONDS = 366 * 24 * 60 * 60;

const now = () => Math.floor(Date.now() / 1000);

// The `duration` a request asked for: null (until unmuted), whole seconds (1 to a year), or
// undefined if it's neither.
function parseDuration(value) {
  if (value === null || value === undefined) return null;
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds > 0 && seconds <= MAX_MUTE_SECONDS ? seconds : undefined;
}

// `userId`'s mutes that are still on: [{ channel_id, guild_id, until }] (until: unix s or null).
async function listMutes(userId) {
  await db.run('DELETE FROM guild_channel_mutes WHERE user_id = ? AND until <= ?', [userId, now()]);
  return db.all(
    `SELECT m.channel_id, c.guild_id, m.until FROM guild_channel_mutes m
     JOIN guild_channels c ON c.id = m.channel_id WHERE m.user_id = ? ORDER BY m.channel_id`,
    [userId]
  );
}

// Mutes (duration: seconds or null) or unmutes (`muted` false) the channel for `userId`.
// Returns the mute ({ until }) or null.
async function setMute(userId, channelId, { muted, duration = null }) {
  if (!muted) {
    await db.run('DELETE FROM guild_channel_mutes WHERE user_id = ? AND channel_id = ?', [userId, channelId]);
    return null;
  }
  const until = duration == null ? null : now() + duration;
  await db.run(
    `INSERT INTO guild_channel_mutes (user_id, channel_id, until) VALUES (?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET until = excluded.until`,
    [userId, channelId, until]
  );
  return { until };
}

// The ids of the users who have the channel muted right now.
async function mutedUserIds(channelId) {
  const rows = await db.all(
    'SELECT user_id FROM guild_channel_mutes WHERE channel_id = ? AND (until IS NULL OR until > ?)',
    [channelId, now()]
  );
  return new Set(rows.map((r) => r.user_id));
}

// Muted guilds (Discord's Mute Server), each member's own: the same as muting every channel in
// it (threads too), for `duration` seconds or until unmuted. Mentions still get through.

// `userId`'s guild mutes that are still on: [{ guild_id, until }].
async function listGuildMutes(userId) {
  await db.run('DELETE FROM guild_mutes WHERE user_id = ? AND until <= ?', [userId, now()]);
  return db.all('SELECT guild_id, until FROM guild_mutes WHERE user_id = ? ORDER BY guild_id', [userId]);
}

// Mutes (duration: seconds or null) or unmutes (`muted` false) the guild for `userId`.
// Returns the mute ({ until }) or null.
async function setGuildMute(userId, guildId, { muted, duration = null }) {
  if (!muted) {
    await db.run('DELETE FROM guild_mutes WHERE user_id = ? AND guild_id = ?', [userId, guildId]);
    return null;
  }
  const until = duration == null ? null : now() + duration;
  await db.run(
    `INSERT INTO guild_mutes (user_id, guild_id, until) VALUES (?, ?, ?)
     ON CONFLICT(user_id, guild_id) DO UPDATE SET until = excluded.until`,
    [userId, guildId, until]
  );
  return { until };
}

// The ids of the users who have the guild muted right now.
async function guildMutedUserIds(guildId) {
  const rows = await db.all(
    'SELECT user_id FROM guild_mutes WHERE guild_id = ? AND (until IS NULL OR until > ?)',
    [guildId, now()]
  );
  return new Set(rows.map((r) => r.user_id));
}

// Each member's own notification level for a channel ('all', 'mentions', 'none'), overriding
// their guild's (guild_members.notify_level) for that channel's messages, like Discord's
// per-channel Notification Settings. Muting still wins over 'all' (mentions get through).
const CHANNEL_NOTIFY_LEVELS = ['all', 'mentions', 'none'];

// `userId`'s channel levels: [{ channel_id, guild_id, level }].
async function listChannelLevels(userId) {
  return db.all(
    `SELECT n.channel_id, c.guild_id, n.level FROM guild_channel_notify n
     JOIN guild_channels c ON c.id = n.channel_id WHERE n.user_id = ? ORDER BY n.channel_id`,
    [userId]
  );
}

// Sets `userId`'s level for the channel, or with null goes back to the guild's.
async function setChannelLevel(userId, channelId, level) {
  if (level == null) {
    await db.run('DELETE FROM guild_channel_notify WHERE user_id = ? AND channel_id = ?', [userId, channelId]);
    return;
  }
  await db.run(
    `INSERT INTO guild_channel_notify (user_id, channel_id, level) VALUES (?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET level = excluded.level`,
    [userId, channelId, level]
  );
}

// Everyone's level for the channel: Map(userId -> level), only those who set one.
async function channelLevels(channelId) {
  const rows = await db.all('SELECT user_id, level FROM guild_channel_notify WHERE channel_id = ?', [channelId]);
  return new Map(rows.map((r) => [r.user_id, r.level]));
}

module.exports = {
  MAX_MUTE_SECONDS,
  parseDuration,
  listMutes,
  setMute,
  mutedUserIds,
  listGuildMutes,
  setGuildMute,
  guildMutedUserIds,
  CHANNEL_NOTIFY_LEVELS,
  listChannelLevels,
  setChannelLevel,
  channelLevels,
};
