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

export async function addGuildReaction(messageId, emoji) {
  return (await api.post(`/guild-messages/${messageId}/reactions`, { emoji })).data;
}

export async function removeGuildReaction(reactionId) {
  await api.delete(`/guild-reactions/${reactionId}`);
}

export async function markChannelRead(channelId, messageId) {
  await api.post(`/channels/${channelId}/read`, { messageId });
}

// [{ channel_id, guild_id, count }] for channels with unread messages.
export async function fetchGuildUnread() {
  return (await api.get('/guild-unread')).data;
}
