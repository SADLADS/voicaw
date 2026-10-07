const db = require('./db');
const { sendToUserSockets } = require('./sockets');
const {
  PERMISSIONS,
  has,
  guildPermissions,
  channelPermissions,
  threadPermissions,
  highestPosition,
} = require('./permissions');

// Shared by the guild routes: who's in a guild and what they may do there (permissions.js),
// what the guild looks like to each member, and telling members about changes (only those
// who can see a channel hear about its messages).

const MAX_GUILD_NAME = 100;
const MAX_CHANNEL_NAME = 100;
const MAX_CATEGORY_NAME = 100;
const MAX_ROLE_NAME = 100;
const MAX_TOPIC = 1024;

// `bot_id`: the bot whose own role it is (bots.js), else null.
const ROLE_COLUMNS = 'id, name, color, position, permissions, hoist, mentionable, is_everyone, bot_id';

// Every role of the guild, highest first (@everyone last).
async function getRoles(guildId) {
  return db.all(
    `SELECT ${ROLE_COLUMNS} FROM guild_roles WHERE guild_id = ? ORDER BY position DESC, id`,
    [guildId]
  );
}

// A member as permissions.js sees them, plus their guild-wide `permissions` and rank.
function memberContext(guild, userId, roles, roleIds, isBot = false) {
  const member = {
    guild,
    userId,
    isOwner: guild.owner === userId,
    isBot: Boolean(isBot), // a bot (bots.js): see permissions.js about Listen
    everyone: roles.find((r) => r.is_everyone),
    roles: roles.filter((r) => !r.is_everyone && roleIds.has(r.id)),
    allRoles: roles,
  };
  member.permissions = guildPermissions(member);
  member.highest = highestPosition(member);
  return member;
}

// The member (see memberContext) if `userId` is in the guild, else null.
async function getMember(guildId, userId) {
  if (!Number.isInteger(guildId)) return null;
  const row = await db.get(
    `SELECT g.id, g.name, g.owner, g.icon_version, g.created_at, u.bot AS member_bot
     FROM guilds g JOIN guild_members gm ON gm.guild_id = g.id JOIN users u ON u.id = gm.user_id
     WHERE g.id = ? AND gm.user_id = ?`,
    [guildId, userId]
  );
  if (!row) return null;
  const { member_bot: isBot, ...guild } = row;
  const roles = await getRoles(guildId);
  const roleRows = await db.all('SELECT role_id FROM guild_member_roles WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  return memberContext(guild, userId, roles, new Set(roleRows.map((r) => r.role_id)), isBot);
}

// Every member of the guild, by user id (for deciding who sees what).
async function getAllMembers(guildId) {
  const guild = await db.get('SELECT id, name, owner, icon_version, created_at FROM guilds WHERE id = ?', [guildId]);
  if (!guild) return new Map();
  const roles = await getRoles(guildId);
  const memberRows = await db.all(
    'SELECT gm.user_id, u.bot FROM guild_members gm JOIN users u ON u.id = gm.user_id WHERE gm.guild_id = ?',
    [guildId]
  );
  const roleRows = await db.all('SELECT user_id, role_id FROM guild_member_roles WHERE guild_id = ?', [guildId]);
  const roleIdsByUser = new Map(memberRows.map((m) => [m.user_id, new Set()]));
  const bots = new Set(memberRows.filter((m) => m.bot).map((m) => m.user_id));
  for (const { user_id: userId, role_id: roleId } of roleRows) roleIdsByUser.get(userId)?.add(roleId);
  return new Map([...roleIdsByUser].map(([userId, roleIds]) => [userId, memberContext(guild, userId, roles, roleIds, bots.has(userId))]));
}

// Overrides of the given channels (or every channel of `guildId`), by channel id. A thread has
// no overrides of its own: it gets its channel's (so whoever sees the channel sees its threads).
async function getOverrides({ guildId, channelIds }) {
  const threads = guildId != null
    ? await db.all("SELECT id, parent_id FROM guild_channels WHERE guild_id = ? AND type = 'thread'", [guildId])
    : await db.all(
      `SELECT id, parent_id FROM guild_channels WHERE type = 'thread' AND id IN (${channelIds.map(() => '?').join(',') || 'NULL'})`,
      channelIds
    );
  const ownIds = guildId != null ? null : [...new Set([...channelIds, ...threads.map((t) => t.parent_id)])];
  const rows = guildId != null
    ? await db.all(
      `SELECT o.channel_id, o.target_type, o.target_id, o.allow, o.deny FROM guild_channel_overrides o
       JOIN guild_channels c ON c.id = o.channel_id WHERE c.guild_id = ?`,
      [guildId]
    )
    : await db.all(
      `SELECT channel_id, target_type, target_id, allow, deny FROM guild_channel_overrides
       WHERE channel_id IN (${ownIds.map(() => '?').join(',') || 'NULL'})`,
      ownIds
    );
  const byChannel = new Map();
  for (const row of rows) {
    if (!byChannel.has(row.channel_id)) byChannel.set(row.channel_id, []);
    byChannel.get(row.channel_id).push(row);
  }
  for (const thread of threads) byChannel.set(thread.id, byChannel.get(thread.parent_id) ?? []);
  return byChannel;
}

// The channel with the caller's `member` context and `permissions` in it, if they're in its
// guild (whether they may see it is up to the caller: check VIEW_CHANNEL), else null. A thread
// comes with `parent_id`, `parent_name` and its channel's `nsfw`, and its permissions are its
// channel's with Send Messages standing for Send Messages in Threads (threadPermissions).
async function getChannelAccess(channelId, userId) {
  if (!Number.isInteger(channelId)) return null;
  const channel = await db.get(
    `SELECT c.id, c.guild_id, c.category_id, c.name, c.type, c.topic, COALESCE(p.nsfw, c.nsfw) AS nsfw, c.position,
       c.parent_id, p.name AS parent_name
     FROM guild_channels c LEFT JOIN guild_channels p ON p.id = c.parent_id WHERE c.id = ?`,
    [channelId]
  );
  if (!channel) return null;
  const member = await getMember(channel.guild_id, userId);
  if (!member) return null;
  const overrides = (await getOverrides({ channelIds: [channel.id] })).get(channel.id) ?? [];
  const permissions = channelPermissions(member, userId, overrides);
  return { channel, member, permissions: channel.type === 'thread' ? threadPermissions(permissions) : permissions };
}

// Whether @everyone can't see the channel (shown with a lock).
function isPrivate(member, overrides) {
  const everyone = overrides.find((o) => o.target_type === 'role' && o.target_id === member.everyone.id);
  return Boolean(everyone && has(everyone.deny, PERMISSIONS.VIEW_CHANNEL));
}

// The guild as `member` sees it: its roles (everyone sees every role, as in Discord), their own
// `my_permissions` and `my_role_ids`, and the categories and channels they can see, in order, each channel with
// `my_permissions`, `private` and `nsfw` (and a voice channel with `voice`, who's in it, and
// `watch_party`, what its Watch Together is playing), and
// `threads`: the active threads in those channels (threads.js, with `joined` and `my_permissions`). Categories left empty by hidden channels are hidden too,
// except from people who manage channels. What GET /guilds/:id returns and `guild_update` sends.
async function layoutFor(member, overridesByChannel) {
  const { guild } = member;
  const categories = await db.all(
    'SELECT id, name, position FROM guild_categories WHERE guild_id = ? ORDER BY position, id',
    [guild.id]
  );
  const allChannels = await db.all(
    `SELECT id, category_id, name, type, topic, nsfw, position FROM guild_channels
     WHERE guild_id = ? AND type != 'thread' ORDER BY position, id`,
    [guild.id]
  );
  const channels = [];
  for (const channel of allChannels) {
    const overrides = overridesByChannel.get(channel.id) ?? [];
    const permissions = channelPermissions(member, member.userId, overrides);
    if (!has(permissions, PERMISSIONS.VIEW_CHANNEL)) continue;
    const entry = { ...channel, nsfw: Boolean(channel.nsfw), my_permissions: permissions, private: isPrivate(member, overrides) };
    // Who's in it right now (voice.js; required here, since it requires this file), and what
    // its Watch Together is playing (watchParty.js; null: nothing).
    if (channel.type === 'voice') {
      entry.voice = require('./voice').membersOf(channel.id);
      entry.watch_party = require('./watchParty').summaryOf(channel.id);
    }
    channels.push(entry);
  }
  const managesChannels = has(member.permissions, PERMISSIONS.MANAGE_CHANNELS);
  const visibleCategories = categories.filter((category) => managesChannels ||
    channels.some((c) => c.category_id === category.id) ||
    !allChannels.some((c) => c.category_id === category.id));
  const own = await db.get('SELECT notify_level FROM guild_members WHERE guild_id = ? AND user_id = ?', [guild.id, member.userId]);
  // The active threads of the text channels they can see (threads.js).
  const textChannels = new Map(channels.filter((c) => c.type === 'text').map((c) => [c.id, c]));
  const threads = (await require('./threads').activeThreads(guild.id, member.userId))
    .filter((t) => textChannels.has(t.parent_id))
    .map((t) => ({ ...t, my_permissions: threadPermissions(textChannels.get(t.parent_id).my_permissions) }));
  // Levels' settings (guildLevels.js): every member draws levels with them.
  const levels = require('./guildLevels').parseSettings((await db.get('SELECT levels FROM guilds WHERE id = ?', [guild.id]))?.levels);
  return {
    ...guild,
    levels,
    my_notify_level: own?.notify_level ?? 'mentions',
    my_permissions: member.permissions,
    my_role_ids: member.roles.map((r) => r.id),
    roles: member.allRoles,
    categories: visibleCategories,
    channels,
    threads,
  };
}

async function getGuildLayout(guildId, userId) {
  const member = await getMember(guildId, userId);
  if (!member) return null;
  return layoutFor(member, await getOverrides({ guildId }));
}

async function getMemberIds(guildId) {
  const rows = await db.all('SELECT user_id FROM guild_members WHERE guild_id = ?', [guildId]);
  return rows.map((r) => r.user_id);
}

// To every member (membership and role changes; everyone sees the member list).
async function sendToGuild(guildId, payload) {
  for (const userId of await getMemberIds(guildId)) sendToUserSockets(userId, payload);
}

// The ids of the members who can see `channel`.
async function getChannelViewers(channel) {
  const members = await getAllMembers(channel.guild_id);
  const overrides = (await getOverrides({ channelIds: [channel.id] })).get(channel.id) ?? [];
  return [...members.values()]
    .filter((m) => has(channelPermissions(m, m.userId, overrides), PERMISSIONS.VIEW_CHANNEL))
    .map((m) => m.userId);
}

// To the members who can see `channel` ({ id, guild_id }): its messages and reactions.
async function sendToChannel(channel, payload) {
  for (const userId of await getChannelViewers(channel)) sendToUserSockets(userId, payload);
}

// Every member gets the guild's new layout as they see it (channels may have appeared or
// disappeared for them).
async function announceGuildUpdate(guildId) {
  const members = await getAllMembers(guildId);
  const overrides = await getOverrides({ guildId });
  for (const member of members.values()) {
    sendToUserSockets(member.userId, { type: 'guild_update', guild: await layoutFor(member, overrides) });
  }
  // Anyone who may no longer be in their voice channel leaves it.
  await require('./voice').enforceGuild(guildId);
}

// A member for the member list: id, name, join time, role ids, XP (guildLevels.js).
async function getMemberListEntry(guildId, userId) {
  const row = await db.get(
    `SELECT u.id, u.username, u.display_name, u.custom_status, u.bio, u.avatar, u.last_online, u.bot, gm.joined_at FROM guild_members gm JOIN users u ON u.id = gm.user_id
     WHERE gm.guild_id = ? AND gm.user_id = ?`,
    [guildId, userId]
  );
  if (!row) return null;
  const roles = await db.all('SELECT role_id FROM guild_member_roles WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  const xp = await db.get('SELECT xp FROM guild_member_xp WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  return { ...row, role_ids: roles.map((r) => r.role_id), xp: xp?.xp ?? 0 };
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

// Deletes channels' messages, their reactions, read markers, mutes, notification levels, overrides, tasks,
// documents and events (not the channels), their threads (with everything in them) and thread members.
// `threads` is false when the channels are threads themselves (they have none).
async function deleteChannelContents(channelIdsSql, params, { threads = true } = {}) {
  if (threads) {
    const threadIdsSql = `SELECT id FROM guild_channels WHERE type = 'thread' AND parent_id IN (${channelIdsSql})`;
    await deleteChannelContents(threadIdsSql, params, { threads: false });
    await db.run(`DELETE FROM guild_channels WHERE id IN (${threadIdsSql})`, params);
  }
  await db.run(`DELETE FROM guild_thread_members WHERE thread_id IN (${channelIdsSql})`, params);
  await require('./guildTasks').deleteChannelTasks(channelIdsSql, params);
  await require('./guildDocuments').deleteChannelDocuments(channelIdsSql, params);
  await require('./guildEvents').deleteChannelEvents(channelIdsSql, params);
  await db.run(
    `DELETE FROM guild_reactions WHERE message_id IN
       (SELECT id FROM guild_messages WHERE channel_id IN (${channelIdsSql}))`,
    params
  );
  await db.run(`DELETE FROM guild_mentions WHERE channel_id IN (${channelIdsSql})`, params);
  await db.run(`DELETE FROM guild_messages WHERE channel_id IN (${channelIdsSql})`, params);
  await db.run(`DELETE FROM guild_channel_reads WHERE channel_id IN (${channelIdsSql})`, params);
  await db.run(`DELETE FROM guild_channel_mutes WHERE channel_id IN (${channelIdsSql})`, params);
  await db.run(`DELETE FROM guild_channel_notify WHERE channel_id IN (${channelIdsSql})`, params);
  await db.run(`DELETE FROM guild_channel_overrides WHERE channel_id IN (${channelIdsSql})`, params);
  await db.run(`DELETE FROM guild_webhooks WHERE channel_id IN (${channelIdsSql})`, params);
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

// Takes `userId` out of the guild and tells everyone (including them). A bot's own role goes too.
async function removeMember(guildId, userId) {
  let events = [];
  const botRoleRemoved = await db.transaction(async () => {
    await db.run('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    await db.run('DELETE FROM guild_member_roles WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    await db.run(
      `DELETE FROM guild_channel_overrides WHERE target_type = 'member' AND target_id = ?
       AND channel_id IN (SELECT id FROM guild_channels WHERE guild_id = ?)`,
      [userId, guildId]
    );
    await db.run(
      'DELETE FROM guild_thread_members WHERE user_id = ? AND thread_id IN (SELECT id FROM guild_channels WHERE guild_id = ?)',
      [userId, guildId]
    );
    for (const table of ['guild_channel_reads', 'guild_channel_mutes', 'guild_channel_notify']) {
      await db.run(
        `DELETE FROM ${table} WHERE user_id = ? AND channel_id IN (SELECT id FROM guild_channels WHERE guild_id = ?)`,
        [userId, guildId]
      );
    }
    await require('./guildTasks').unassignFromGuild(guildId, userId);
    events = await require('./guildEvents').forgetMember(guildId, userId);
    return require('./bots').removeBotRole(guildId, userId);
  });
  sendToUserSockets(userId, { type: 'guild_remove', guildId });
  await sendToGuild(guildId, { type: 'guild_member_remove', guildId, userId });
  for (const event of events) await require('./guildEvents').broadcastInterest(event, userId, false);
  if (botRoleRemoved) await announceGuildUpdate(guildId);
  await require('./voice').enforceGuild(guildId);
}

// Deletes the guild and everything in it (its icon, emoji images and uploads too), and tells
// its members.
async function deleteGuild(guildId) {
  const memberIds = await getMemberIds(guildId);
  const { deleteObject } = require('./s3');

  await require('./voice').disconnectGuild(guildId);
  const emojis = await db.all('SELECT id, available FROM guild_emojis WHERE guild_id = ?', [guildId]);
  for (const { id, available } of emojis) await deleteObject('emojis', available ? String(id) : `src/${id}`);
  const guild = await db.get('SELECT icon_version FROM guilds WHERE id = ?', [guildId]);
  if (guild?.icon_version > 0) await deleteObject('guild-icons', String(guildId));
  await db.transaction(async () => {
    await deleteChannelContents('SELECT id FROM guild_channels WHERE guild_id = ?', [guildId]);
    await require('./guildEvents').deleteGuildEvents(guildId);
    await require('./guildLevels').deleteGuildLevels(guildId);
    for (const table of [
      'guild_emojis', 'guild_audit_log', 'webhook_blocks',
      'guild_channels', 'guild_categories', 'guild_invites', 'guild_bans',
      'guild_member_roles', 'guild_roles', 'guild_members',
    ]) {
      await db.run(`DELETE FROM ${table} WHERE guild_id = ?`, [guildId]);
    }
    await db.run('DELETE FROM guilds WHERE id = ?', [guildId]);
  });
  require('./uploads').releaseUploads();

  for (const userId of memberIds) sendToUserSockets(userId, { type: 'guild_remove', guildId });
}

module.exports = {
  MAX_GUILD_NAME,
  MAX_CATEGORY_NAME,
  MAX_ROLE_NAME,
  MAX_TOPIC,
  ROLE_COLUMNS,
  getRoles,
  getMember,
  getAllMembers,
  getOverrides,
  getChannelAccess,
  getGuildLayout,
  getMemberIds,
  getMemberListEntry,
  getChannelViewers,
  sendToGuild,
  sendToChannel,
  announceGuildUpdate,
  normalizeChannelName,
  cleanName,
  nextPosition,
  deleteChannelContents,
  markGuildRead,
  removeMember,
  deleteGuild,
};
