const db = require('./db');
const { sendToUserSockets } = require('./sockets');
const {
  PERMISSIONS,
  has,
  guildPermissions,
  channelPermissions,
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

const ROLE_COLUMNS = 'id, name, color, position, permissions, hoist, mentionable, is_everyone';

// Every role of the guild, highest first (@everyone last).
async function getRoles(guildId) {
  return db.all(
    `SELECT ${ROLE_COLUMNS} FROM guild_roles WHERE guild_id = ? ORDER BY position DESC, id`,
    [guildId]
  );
}

// A member as permissions.js sees them, plus their guild-wide `permissions` and rank.
function memberContext(guild, userId, roles, roleIds) {
  const member = {
    guild,
    userId,
    isOwner: guild.owner === userId,
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
  const guild = await db.get(
    `SELECT g.id, g.name, g.owner, g.icon_version, g.created_at
     FROM guilds g JOIN guild_members gm ON gm.guild_id = g.id
     WHERE g.id = ? AND gm.user_id = ?`,
    [guildId, userId]
  );
  if (!guild) return null;
  const roles = await getRoles(guildId);
  const roleRows = await db.all('SELECT role_id FROM guild_member_roles WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  return memberContext(guild, userId, roles, new Set(roleRows.map((r) => r.role_id)));
}

// Every member of the guild, by user id (for deciding who sees what).
async function getAllMembers(guildId) {
  const guild = await db.get('SELECT id, name, owner, icon_version, created_at FROM guilds WHERE id = ?', [guildId]);
  if (!guild) return new Map();
  const roles = await getRoles(guildId);
  const memberRows = await db.all('SELECT user_id FROM guild_members WHERE guild_id = ?', [guildId]);
  const roleRows = await db.all('SELECT user_id, role_id FROM guild_member_roles WHERE guild_id = ?', [guildId]);
  const roleIdsByUser = new Map(memberRows.map((m) => [m.user_id, new Set()]));
  for (const { user_id: userId, role_id: roleId } of roleRows) roleIdsByUser.get(userId)?.add(roleId);
  return new Map([...roleIdsByUser].map(([userId, roleIds]) => [userId, memberContext(guild, userId, roles, roleIds)]));
}

// Overrides of the given channels (or every channel of `guildId`), by channel id.
async function getOverrides({ guildId, channelIds }) {
  const rows = guildId != null
    ? await db.all(
      `SELECT o.channel_id, o.target_type, o.target_id, o.allow, o.deny FROM guild_channel_overrides o
       JOIN guild_channels c ON c.id = o.channel_id WHERE c.guild_id = ?`,
      [guildId]
    )
    : await db.all(
      `SELECT channel_id, target_type, target_id, allow, deny FROM guild_channel_overrides
       WHERE channel_id IN (${channelIds.map(() => '?').join(',') || 'NULL'})`,
      channelIds
    );
  const byChannel = new Map();
  for (const row of rows) {
    if (!byChannel.has(row.channel_id)) byChannel.set(row.channel_id, []);
    byChannel.get(row.channel_id).push(row);
  }
  return byChannel;
}

// The channel with the caller's `member` context and `permissions` in it, if they're in its
// guild (whether they may see it is up to the caller: check VIEW_CHANNEL), else null.
async function getChannelAccess(channelId, userId) {
  if (!Number.isInteger(channelId)) return null;
  const channel = await db.get(
    'SELECT id, guild_id, category_id, name, type, topic, position FROM guild_channels WHERE id = ?',
    [channelId]
  );
  if (!channel) return null;
  const member = await getMember(channel.guild_id, userId);
  if (!member) return null;
  const overrides = (await getOverrides({ channelIds: [channel.id] })).get(channel.id) ?? [];
  return { channel, member, permissions: channelPermissions(member, userId, overrides) };
}

// Whether @everyone can't see the channel (shown with a lock).
function isPrivate(member, overrides) {
  const everyone = overrides.find((o) => o.target_type === 'role' && o.target_id === member.everyone.id);
  return Boolean(everyone && has(everyone.deny, PERMISSIONS.VIEW_CHANNEL));
}

// The guild as `member` sees it: its roles (everyone sees every role, as in Discord), their own
// `my_permissions` and `my_role_ids`, and the categories and channels they can see, in order, each channel with
// `my_permissions` and `private` (and a voice channel with `voice`, who's in it). Categories left empty by hidden channels are hidden too,
// except from people who manage channels. What GET /guilds/:id returns and `guild_update` sends.
async function layoutFor(member, overridesByChannel) {
  const { guild } = member;
  const categories = await db.all(
    'SELECT id, name, position FROM guild_categories WHERE guild_id = ? ORDER BY position, id',
    [guild.id]
  );
  const allChannels = await db.all(
    `SELECT id, category_id, name, type, topic, position FROM guild_channels
     WHERE guild_id = ? ORDER BY position, id`,
    [guild.id]
  );
  const channels = [];
  for (const channel of allChannels) {
    const overrides = overridesByChannel.get(channel.id) ?? [];
    const permissions = channelPermissions(member, member.userId, overrides);
    if (!has(permissions, PERMISSIONS.VIEW_CHANNEL)) continue;
    const entry = { ...channel, my_permissions: permissions, private: isPrivate(member, overrides) };
    // Who's in it right now (voice.js; required here, since it requires this file).
    if (channel.type === 'voice') entry.voice = require('./voice').membersOf(channel.id);
    channels.push(entry);
  }
  const managesChannels = has(member.permissions, PERMISSIONS.MANAGE_CHANNELS);
  const visibleCategories = categories.filter((category) => managesChannels ||
    channels.some((c) => c.category_id === category.id) ||
    !allChannels.some((c) => c.category_id === category.id));
  const own = await db.get('SELECT notify_level FROM guild_members WHERE guild_id = ? AND user_id = ?', [guild.id, member.userId]);
  return {
    ...guild,
    my_notify_level: own?.notify_level ?? 'mentions',
    my_permissions: member.permissions,
    my_role_ids: member.roles.map((r) => r.id),
    roles: member.allRoles,
    categories: visibleCategories,
    channels,
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

// A member for the member list: id, name, join time, role ids.
async function getMemberListEntry(guildId, userId) {
  const row = await db.get(
    `SELECT u.id, u.username, u.last_online, gm.joined_at FROM guild_members gm JOIN users u ON u.id = gm.user_id
     WHERE gm.guild_id = ? AND gm.user_id = ?`,
    [guildId, userId]
  );
  if (!row) return null;
  const roles = await db.all('SELECT role_id FROM guild_member_roles WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  return { ...row, role_ids: roles.map((r) => r.role_id) };
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

// Deletes channels' messages, their reactions, read markers and overrides (not the channels).
async function deleteChannelContents(channelIdsSql, params) {
  await db.run(
    `DELETE FROM guild_reactions WHERE message_id IN
       (SELECT id FROM guild_messages WHERE channel_id IN (${channelIdsSql}))`,
    params
  );
  await db.run(`DELETE FROM guild_mentions WHERE channel_id IN (${channelIdsSql})`, params);
  await db.run(`DELETE FROM guild_messages WHERE channel_id IN (${channelIdsSql})`, params);
  await db.run(`DELETE FROM guild_channel_reads WHERE channel_id IN (${channelIdsSql})`, params);
  await db.run(`DELETE FROM guild_channel_overrides WHERE channel_id IN (${channelIdsSql})`, params);
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
};
