import api from '../utils/api';
import { t } from '../i18n';

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

// Uploads `file` as the guild's icon (Manage Guild), then tells the server it's there, to cut
// out `crop` (from ImageCropper; optional: the middle).
export async function uploadGuildIcon(guildId, file, crop) {
  const { data } = await api.get('/upload_guild_icon', { params: { guildId, type: file.type, size: file.size } });
  if (!data?.url) throw new Error(t('guildAdmin.upload.noUrl'));
  const res = await fetch(data.url, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
  if (!res.ok) throw new Error(t('guildAdmin.upload.failed'));
  return updateGuild(guildId, crop ? { iconUploaded: true, iconCrop: crop } : { iconUploaded: true });
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

// The guild's vanity invite, `{ code, uses }` (code null: none).
export async function fetchVanityInvite(guildId) {
  return (await api.get(`/guilds/${guildId}/vanity-url`)).data;
}

// Sets the vanity invite (owner only); null removes it.
export async function setVanityInvite(guildId, code) {
  return (await api.put(`/guilds/${guildId}/vanity-url`, { code })).data;
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

// A copy of a channel (type, topic, category, permissions; none of its content), just below it.
export async function cloneChannel(guildId, channelId, name) {
  return (await api.post(`/guilds/${guildId}/channels/${channelId}/clone`, { name })).data;
}

export async function deleteChannel(guildId, channelId) {
  await api.delete(`/guilds/${guildId}/channels/${channelId}`);
}

// In a document channel, `params.document` is the document whose replies to fetch.
export async function fetchChannelMessages(channelId, params = {}) {
  return (await api.get(`/channels/${channelId}/messages`, { params })).data;
}

// `documentId`: in a document channel, the document this replies to.
export async function sendChannelMessage(channelId, content, replyTo = null, documentId = null, nonce = undefined) {
  return (await api.post(`/channels/${channelId}/messages`, { content, replyTo, ...(documentId ? { documentId } : {}), nonce })).data;
}

export async function editChannelMessage(messageId, content) {
  await api.put(`/guild-messages/${messageId}`, { content });
}

export async function deleteChannelMessage(messageId) {
  await api.delete(`/guild-messages/${messageId}`);
}

// A message's earlier versions (server/editHistory.js):
// { versions: [{ content, written_at, edited }] (oldest first), edited_at }.
export async function fetchMessageEditHistory(messageId) {
  return (await api.get(`/guild-messages/${messageId}/edits`)).data;
}

export async function fetchChannelPins(channelId) {
  return (await api.get(`/channels/${channelId}/pins`)).data;
}

export async function setChannelMessagePinned(messageId, pinned) {
  return (await api[pinned ? 'put' : 'delete'](`/guild-messages/${messageId}/pin`)).data;
}

// Discord's SUPPRESS_EMBEDS: hides (or, with `suppress` false, shows again) a message's
// previews. Resolves to { messageId, flags }.
export async function setChannelMessageEmbedsSuppressed(messageId, suppress) {
  return (await api.put(`/guild-messages/${messageId}/suppress-embeds`, { suppress })).data;
}

export async function addGuildReaction(messageId, emoji) {
  return (await api.post(`/guild-messages/${messageId}/reactions`, { emoji })).data;
}

export async function removeGuildReaction(reactionId) {
  await api.delete(`/guild-reactions/${reactionId}`);
}

// Returns the oldest message that was unread until now (null if none: where the "New" divider goes).
export async function markChannelRead(channelId, messageId) {
  return (await api.post(`/channels/${channelId}/read`, { messageId }))?.data?.first_unread_id ?? null;
}

// Marks a channel read up to its newest message (Mark As Read).
export async function markChannelReadToLatest(channelId) {
  await api.post(`/channels/${channelId}/read`, { latest: true });
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

// Your muted channels: [{ channel_id, guild_id, until }] (until: unix s, or null until unmuted).
export async function fetchChannelMutes() {
  return (await api.get('/channel-mutes')).data;
}

// Mutes a channel for `duration` seconds, or until it's unmuted (null).
export async function muteChannel(channelId, duration = null) {
  return (await api.put(`/channels/${channelId}/mute`, { duration })).data;
}

export async function unmuteChannel(channelId) {
  return (await api.delete(`/channels/${channelId}/mute`)).data;
}

// Your muted guilds: [{ guild_id, until }] (until: unix s, or null until unmuted).
export async function fetchGuildMutes() {
  return (await api.get('/guild-mutes')).data;
}

// Mutes a whole guild for `duration` seconds, or until it's unmuted (null).
export async function muteGuild(guildId, duration = null) {
  return (await api.put(`/guilds/${guildId}/mute`, { duration })).data;
}

export async function unmuteGuild(guildId) {
  return (await api.delete(`/guilds/${guildId}/mute`)).data;
}

// Your own notification levels for channels: [{ channel_id, guild_id, level }].
export async function fetchChannelNotifications() {
  return (await api.get('/channel-notifications')).data;
}

// Your notification level for one channel: 'all', 'mentions', 'none', or null for the guild's.
export async function setChannelNotifications(channelId, level) {
  return (await api.put(`/channels/${channelId}/notifications`, { level })).data;
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
  if (!res.ok) throw new Error(t('guildAdmin.upload.failed'));
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

// ---- List channels (routes/guildTasks.js) ----

export async function fetchTasks(channelId) {
  return (await api.get(`/channels/${channelId}/tasks`)).data;
}

// { title, description?, dueDate?, assigneeIds?, parentId? }
export async function createTask(channelId, task) {
  return (await api.post(`/channels/${channelId}/tasks`, task)).data;
}

// Any of { title, description, dueDate, assigneeIds, completed }.
export async function updateTask(taskId, changes) {
  return (await api.patch(`/tasks/${taskId}`, changes)).data;
}

export async function moveTask(taskId, { parentId, beforeId }) {
  return (await api.put(`/tasks/${taskId}/move`, { parentId, beforeId })).data;
}

export async function deleteTask(taskId) {
  return (await api.delete(`/tasks/${taskId}`)).data;
}

export async function fetchTaskComments(taskId) {
  return (await api.get(`/tasks/${taskId}/comments`)).data;
}

export async function addTaskComment(taskId, content) {
  return (await api.post(`/tasks/${taskId}/comments`, { content })).data;
}

export async function editTaskComment(commentId, content) {
  return (await api.patch(`/task-comments/${commentId}`, { content })).data;
}

export async function deleteTaskComment(commentId) {
  await api.delete(`/task-comments/${commentId}`);
}

// ---- Document channels (routes/guildDocuments.js) ----

// The feed: every document, newest first, without content (`content_start` instead).
export async function fetchDocuments(channelId) {
  return (await api.get(`/channels/${channelId}/documents`)).data;
}

// { title, cover?, content? }
export async function createDocument(channelId, document) {
  return (await api.post(`/channels/${channelId}/documents`, document)).data;
}

export async function fetchDocument(documentId) {
  return (await api.get(`/documents/${documentId}`)).data;
}

// { version (the one the edit started from), title?, cover?, content? }. A 409 means someone
// else saved first; its `document` is theirs.
export async function saveDocument(documentId, changes) {
  return (await api.patch(`/documents/${documentId}`, changes)).data;
}

export async function deleteDocument(documentId) {
  await api.delete(`/documents/${documentId}`);
}

export async function addDocumentReaction(documentId, emoji) {
  return (await api.post(`/documents/${documentId}/reactions`, { emoji })).data;
}

export async function removeDocumentReaction(reactionId) {
  await api.delete(`/document-reactions/${reactionId}`);
}

// ---- Threads (server routes/threads.js) ----

// Starts a thread called `name` in text channel `channelId`, from message `messageId` (or on its
// own with null). -> the thread.
export async function createThread(channelId, name, messageId = null) {
  return (await api.post(`/channels/${channelId}/threads`, { name, ...(messageId != null ? { messageId } : {}) })).data;
}

// The channel's threads, active and archived, most recently active first.
export async function fetchChannelThreads(channelId) {
  return (await api.get(`/channels/${channelId}/threads`)).data;
}

// -> { thread, starter } (starter: the message it started from, or null).
export async function fetchThread(threadId) {
  return (await api.get(`/threads/${threadId}`)).data;
}

// `changes`: { name?, archived? }. -> the thread.
export async function updateThread(threadId, changes) {
  return (await api.patch(`/threads/${threadId}`, changes)).data;
}

export async function deleteThread(threadId) {
  await api.delete(`/threads/${threadId}`);
}

export async function setThreadJoined(threadId, joined) {
  if (joined) await api.put(`/threads/${threadId}/member`);
  else await api.delete(`/threads/${threadId}/member`);
}

// ---- Scheduled events (server/routes/guildEvents.js) ----

// The guild's events you can see, soonest first, each with `interested` (yours).
export async function fetchEvents(guildId) {
  return (await api.get(`/guilds/${guildId}/events`)).data;
}

// One event, with your interest. A repeating one's `occurrence` (an original start) or `on` (a
// link's date, 'YYYY-MM-DD') adds that `occurrence` (still to come, cancelled, taken place, or
// null when it isn't one of its dates). An event "this and following" continued may come back
// as the event that did (another id).
export async function fetchEvent(eventId, { occurrence = null, on = null } = {}) {
  const params = occurrence != null ? { occurrence } : on != null ? { on } : undefined;
  return (await api.get(`/guild-events/${eventId}`, params ? { params } : undefined)).data;
}

// What took place between unix s `from` and `to` (at most 100 days apart): past occurrences,
// like events (`id` is the event's) with `status` 'completed' and `original_start`.
export async function fetchEventHistory(guildId, from, to) {
  return (await api.get(`/guilds/${guildId}/event-history`, { params: { from, to } })).data;
}

// { name, description, entityType: 'voice' | 'external', channelId | location, startTime,
// endTime, image, recurrence, timezone } (times in unix seconds).
export async function createEvent(guildId, fields) {
  return (await api.post(`/guilds/${guildId}/events`, fields)).data;
}

// Every occurrence of a repeating event, or with `from` (an original start) that one and those
// after it: then it resolves to the new event that takes over from there.
export async function updateEvent(eventId, fields, { from = null } = {}) {
  return (await api.patch(`/guild-events/${eventId}`, fields, from != null ? { params: { from } } : undefined)).data;
}

export async function startEvent(eventId) {
  return (await api.post(`/guild-events/${eventId}/start`)).data;
}

export async function endEvent(eventId) {
  return (await api.post(`/guild-events/${eventId}/end`)).data;
}

// Cancels the event (every occurrence of a repeating one), or with `from` (an original start)
// that occurrence and every one after it.
export async function cancelEvent(eventId, { from = null } = {}) {
  await api.delete(`/guild-events/${eventId}`, from != null ? { params: { from } } : undefined);
}

// One occurrence of a repeating event (`occurrence`: its original start; the current one by
// default): cancelled, or changed ({ occurrence, startTime, endTime, name, description,
// location }). Both resolve to the event.
export async function skipOccurrence(eventId, { occurrence = null } = {}) {
  return (await api.post(`/guild-events/${eventId}/skip`, occurrence != null ? { occurrence } : {})).data;
}

export async function moveOccurrence(eventId, changes) {
  return (await api.put(`/guild-events/${eventId}/occurrence`, changes)).data;
}

// Interested or not in every occurrence of the event, or with `occurrence` (an original start)
// only that one. Resolves to { interested (in that one), interested_all, my_occurrences }.
export async function setEventInterest(eventId, interested, { occurrence = null } = {}) {
  const url = `/guild-events/${eventId}/interest${occurrence != null ? `?occurrence=${occurrence}` : ''}`;
  return (await (interested ? api.put(url) : api.delete(url))).data;
}

// Who's interested in the current occurrence (or `occurrence`, an original start): user ids.
export async function fetchEventUsers(eventId, { occurrence = null } = {}) {
  return (await api.get(`/guild-events/${eventId}/users`, occurrence != null ? { params: { occurrence } } : undefined)).data;
}

// ---- Levels (server/guildLevels.js) ----

// The guild's media server for Watch Together (Manage Guild): { kind, name, url, username,
// connected_by, connected_at } or null.
export async function fetchMediaServer(guildId) {
  return (await api.get(`/guilds/${guildId}/media-server`)).data.server;
}

// { kind: 'jellyfin' | 'emby', url, username, password } -> the server, as fetchMediaServer.
export async function connectMediaServer(guildId, { kind, url, username, password }) {
  return (await api.put(`/guilds/${guildId}/media-server`, { kind, url, username, password })).data.server;
}

export async function disconnectMediaServer(guildId) {
  await api.delete(`/guilds/${guildId}/media-server`);
}

export async function updateLevelSettings(guildId, changes) {
  return (await api.patch(`/guilds/${guildId}/levels`, changes)).data;
}

// The leaderboard: [{ user_id, xp, level, rank }], most XP first.
export async function fetchLeaderboard(guildId, { limit = 50, offset = 0 } = {}) {
  return (await api.get(`/guilds/${guildId}/levels/members`, { params: { limit, offset } })).data;
}

// { user_id, xp, level, rank }
export async function fetchMemberLevel(guildId, userId) {
  return (await api.get(`/guilds/${guildId}/levels/members/${userId}`)).data;
}

// `change`: one of { xp }, { level }, { addXp }, { addLevels } (Manage Levels).
export async function changeMemberXp(guildId, userId, change) {
  return (await api.patch(`/guilds/${guildId}/levels/members/${userId}`, change)).data;
}
