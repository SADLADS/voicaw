import api from '../utils/api';

// The guild API (server/routes/guilds.js and guildMessages.js). Guilds aren't encrypted:
// messages and reactions go to the server as plain text.

export async function fetchGuilds() {
  return (await api.get('/guilds')).data;
}

// The guild with its `categories` and `channels`, in order.
export async function fetchGuild(guildId) {
  return (await api.get(`/guilds/${guildId}`)).data;
}

export async function createGuild(name) {
  return (await api.post('/guilds', { name })).data;
}

export async function updateGuild(guildId, changes) {
  return (await api.patch(`/guilds/${guildId}`, changes)).data;
}

export async function deleteGuild(guildId) {
  await api.delete(`/guilds/${guildId}`);
}

export async function transferGuild(guildId, userId) {
  await api.post(`/guilds/${guildId}/transfer`, { userId });
}

// Uploads `file` as the guild's icon (owner only), then tells the server it's there.
export async function uploadGuildIcon(guildId, file) {
  const { data } = await api.get('/upload_guild_icon', { params: { guildId, type: file.type, size: file.size } });
  if (!data?.url) throw new Error('No upload URL');
  const res = await fetch(data.url, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
  if (!res.ok) throw new Error('Upload failed');
  return updateGuild(guildId, { iconUploaded: true });
}

export async function fetchMembers(guildId) {
  return (await api.get(`/guilds/${guildId}/members`)).data;
}

export async function leaveGuild(guildId) {
  await api.delete(`/guilds/${guildId}/members/me`);
}

export async function kickMember(guildId, userId) {
  await api.delete(`/guilds/${guildId}/members/${userId}`);
}

export async function banMember(guildId, userId) {
  await api.put(`/guilds/${guildId}/bans/${userId}`);
}

export async function unbanMember(guildId, userId) {
  await api.delete(`/guilds/${guildId}/bans/${userId}`);
}

export async function fetchBans(guildId) {
  return (await api.get(`/guilds/${guildId}/bans`)).data;
}

// `maxAge` in seconds and `maxUses`; 0 = no limit.
export async function createInvite(guildId, { maxAge = 0, maxUses = 0 } = {}) {
  return (await api.post(`/guilds/${guildId}/invites`, { maxAge, maxUses })).data;
}

export async function fetchInvites(guildId) {
  return (await api.get(`/guilds/${guildId}/invites`)).data;
}

export async function revokeInvite(code) {
  await api.delete(`/invites/${code}`);
}

export async function fetchInvite(code) {
  return (await api.get(`/invites/${code}`)).data;
}

// Invite embeds in chats: each code is asked about once per session (an invalid one stays
// invalid; other failures are asked again next time).
const invitePreviews = new Map();

export function fetchInvitePreview(code) {
  if (!invitePreviews.has(code)) {
    invitePreviews.set(code, fetchInvite(code).catch((err) => {
      if (err?.response?.status !== 404) invitePreviews.delete(code);
      throw err;
    }));
  }
  return invitePreviews.get(code);
}

// Whether this session has asked about the code already (so asking again tells the server nothing new).
export function invitePreviewRequested(code) {
  return invitePreviews.has(code);
}

// Joins; resolves to the guild's layout.
export async function acceptInvite(code) {
  return (await api.post(`/invites/${code}`)).data;
}

export async function createCategory(guildId, name) {
  return (await api.post(`/guilds/${guildId}/categories`, { name })).data;
}

export async function renameCategory(guildId, categoryId, name) {
  await api.patch(`/guilds/${guildId}/categories/${categoryId}`, { name });
}

export async function deleteCategory(guildId, categoryId) {
  await api.delete(`/guilds/${guildId}/categories/${categoryId}`);
}

// { name, type: 'text' | 'voice', topic, categoryId }
export async function createChannel(guildId, channel) {
  return (await api.post(`/guilds/${guildId}/channels`, channel)).data;
}

// Any of { name, topic, categoryId }.
export async function updateChannel(guildId, channelId, changes) {
  return (await api.patch(`/guilds/${guildId}/channels/${channelId}`, changes)).data;
}

export async function deleteChannel(guildId, channelId) {
  await api.delete(`/guilds/${guildId}/channels/${channelId}`);
}

export async function fetchChannelMessages(channelId, params = {}) {
  return (await api.get(`/channels/${channelId}/messages`, { params })).data;
}

export async function sendChannelMessage(channelId, content, replyTo = null) {
  return (await api.post(`/channels/${channelId}/messages`, { content, replyTo })).data;
}

export async function editChannelMessage(messageId, content) {
  await api.put(`/guild-messages/${messageId}`, { content });
}

export async function deleteChannelMessage(messageId) {
  await api.delete(`/guild-messages/${messageId}`);
}

export async function fetchChannelPins(channelId) {
  return (await api.get(`/channels/${channelId}/pins`)).data;
}

export async function setChannelMessagePinned(messageId, pinned) {
  return (await api[pinned ? 'put' : 'delete'](`/guild-messages/${messageId}/pin`)).data;
}

export async function addGuildReaction(messageId, emoji) {
  return (await api.post(`/guild-messages/${messageId}/reactions`, { emoji })).data;
}

export async function removeGuildReaction(reactionId) {
  await api.delete(`/guild-reactions/${reactionId}`);
}

export async function markChannelRead(channelId, messageId) {
  await api.post(`/channels/${channelId}/read`, { messageId });
}

// Moves a channel into `categoryId` (null: no category), before channel `beforeId` or at the
// end of it.
export async function moveChannel(guildId, channelId, { categoryId, beforeId }) {
  return (await api.put(`/guilds/${guildId}/channels/${channelId}/move`, { categoryId, beforeId })).data;
}

// Moves a category before category `beforeId`, or last.
export async function moveCategory(guildId, categoryId, beforeId) {
  return (await api.put(`/guilds/${guildId}/categories/${categoryId}/move`, { beforeId })).data;
}

// The ids of the members who can see a channel.
export async function fetchChannelMembers(channelId) {
  return (await api.get(`/channels/${channelId}/members`)).data;
}

// Your notification level for a guild: 'all', 'mentions' or 'none'.
export async function setGuildNotifications(guildId, level) {
  await api.put(`/guilds/${guildId}/notifications`, { level });
}

// [{ channel_id, guild_id, count, mentions }] for channels with unread messages (`mentions`:
// how many of them mention you).
export async function fetchGuildUnread() {
  return (await api.get('/guild-unread')).data;
}

// ---- Roles and channel permissions ----

// { name, color (0xRRGGBB or null), permissions, hoist }; all optional.
export async function createRole(guildId, role = {}) {
  return (await api.post(`/guilds/${guildId}/roles`, role)).data;
}

export async function updateRole(guildId, roleId, changes) {
  return (await api.patch(`/guilds/${guildId}/roles/${roleId}`, changes)).data;
}

export async function deleteRole(guildId, roleId) {
  await api.delete(`/guilds/${guildId}/roles/${roleId}`);
}

// Every role but @everyone, top first.
export async function reorderRoles(guildId, roleIds) {
  await api.put(`/guilds/${guildId}/roles/order`, { roleIds });
}

export async function setMemberRoles(guildId, userId, roleIds) {
  return (await api.put(`/guilds/${guildId}/members/${userId}/roles`, { roleIds })).data;
}

// [{ target_type: 'role' | 'member', target_id, allow, deny }]
export async function fetchChannelOverrides(guildId, channelId) {
  return (await api.get(`/guilds/${guildId}/channels/${channelId}/overrides`)).data;
}

// allow = deny = 0 removes the override.
export async function setChannelOverride(guildId, channelId, targetType, targetId, { allow = 0, deny = 0 }) {
  return (await api.put(`/guilds/${guildId}/channels/${channelId}/overrides/${targetType}/${targetId}`, { allow, deny })).data;
}

// ---- Custom emoji and the guild rail order ----

// Every emoji of every guild you're in: [{ id, guild_id, name, animated }].
export async function fetchAllEmojis() {
  return (await api.get('/emojis')).data;
}

export async function fetchGuildEmojis(guildId) {
  return (await api.get(`/guilds/${guildId}/emojis`)).data;
}

// Creates the emoji, uploads `file` for it, then makes it available.
export async function addGuildEmoji(guildId, name, file) {
  const { data } = await api.post(`/guilds/${guildId}/emojis`, { name, type: file.type, size: file.size });
  const res = await fetch(data.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
  if (!res.ok) throw new Error('Upload failed');
  return (await api.post(`/guilds/${guildId}/emojis/${data.emoji.id}/ready`)).data;
}

export async function renameGuildEmoji(guildId, emojiId, name) {
  return (await api.patch(`/guilds/${guildId}/emojis/${emojiId}`, { name })).data;
}

export async function deleteGuildEmoji(guildId, emojiId) {
  await api.delete(`/guilds/${guildId}/emojis/${emojiId}`);
}

// Your guilds, top first, as the guild rail should show them.
export async function saveGuildOrder(guildIds) {
  await api.put('/guilds-order', { guildIds });
}

// ---- Webhooks (server/routes/webhooks.js; Discord's API) ----

// A channel's webhooks ([{ id, name, avatar_url, token, url, user, created_at }]).
export async function fetchChannelWebhooks(channelId) {
  return (await api.get(`/channels/${channelId}/webhooks`)).data;
}

// `avatar`: a data: URI (the server makes it a picture), as Discord's API takes it.
export async function createWebhook(channelId, { name, avatar } = {}) {
  return (await api.post(`/channels/${channelId}/webhooks`, { name, ...(avatar ? { avatar } : {}) })).data;
}

// Any of { name, avatar (data: URI, or null for none) }.
export async function updateWebhook(webhookId, changes) {
  return (await api.patch(`/webhooks/${webhookId}`, changes)).data;
}

export async function deleteWebhook(webhookId) {
  await api.delete(`/webhooks/${webhookId}`);
}

// Searches the guild's messages (routes/guildSearch.js): `params` from parseSearch
// (utils/searchQuery.js) plus `offset` and `sort_order`. { total_results, messages }.
export async function searchGuildMessages(guildId, params) {
  const query = Object.fromEntries(Object.entries(params)
    .map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value])
    .filter(([, value]) => value !== '' && value != null));
  return (await api.get(`/guilds/${guildId}/messages/search`, { params: query })).data;
}

// A page of the guild's audit log (server/auditLog.js; View Audit Log), newest first:
// { entries, users, webhooks, next }. `before` is the last page's `next`; `actions` limits it
// to those actions, `userId` to what that member did.
// Deletes audit log entries older than `olderThanDays` (30, 90, 365; 0: all). Owner only.
export async function clearAuditLog(guildId, olderThanDays) {
  return (await api.post(`/guilds/${guildId}/audit-log/clear`, { olderThanDays })).data;
}

export async function fetchAuditLog(guildId, { before, actions, userId } = {}) {
  const params = { before, actions: actions?.join(','), userId };
  return (await api.get(`/guilds/${guildId}/audit-log`, {
    params: Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== '')),
  })).data;
}
