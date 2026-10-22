import api from '../utils/api';

export async function fetchUsersList() {
  const res = await api.get('/dms-list');
  return res.data;
}

export async function fetchMessagesForUser(userId, params = {}) {
  const res = await api.get(`/dm-messages/${userId}`, { params });
  return res.data;
}

// How many messages each id range ([[from, to]]) of the conversation holds now, and its latest
// edit: [{ rows, edited }] (for the device's search copy, services/searchIndex.js).
export async function fetchMessageRanges(userId, ranges) {
  return (await api.post(`/dm-messages/${userId}/ranges`, { ranges })).data.ranges;
}


// `uploads`: the names of the files it shows (uploadNamesIn), so the server knows when
// they're no longer used. `nonce`: the same on a retry, so it's saved once (useUnsentMessages).
export async function sendMessageToUser(recipientId, content, replyTo = null, uploads = [], nonce = undefined) {
  const res = await api.post('/dm-send', {
    recipient_id: recipientId,
    content,
    replyTo,
    uploads,
    nonce,
  });
  return res.data;
}

// Returns the oldest message that was unread until now (null if none: where the "New" divider goes).
export async function markMessagesRead(userId) {
  return (await api.post(`/dm-mark-read/${userId}`))?.data?.first_unread_id ?? null;
}

// Your pins and mutes for DMs and group DMs: [{ kind: 'dm' | 'group', target, pinned_at,
// muted, mute_until }].
export async function fetchConversationSettings() {
  return (await api.get('/conversation-settings')).data;
}

// Changes one: `{ pinned: true | false }` and/or `{ mute: { duration: s | null } | false }`.
export async function setConversationSetting(kind, target, changes) {
  return (await api.put(`/conversation-settings/${kind}/${target}`, changes)).data;
}
// `content` is the encrypted emoji (encryptReaction).
export async function addReaction(messageId, content) {
  const res = await api.post('/dm-reactions', { messageId, content });
  return res.data;
}

export async function removeReaction(reactionId) {
  await api.delete(`/dm-reactions/${reactionId}`);
}

// `content` is the new ciphertext, `uploads` the files it shows now.
export async function editMessage(messageId, content, uploads = []) {
  await api.put(`/update-message/${messageId}`, { content, uploads });
}

// A message's earlier versions, still encrypted (server/editHistory.js):
// { versions: [{ content, written_at, edited }] (oldest first), edited_at }.
export async function fetchEditHistory(messageId) {
  return (await api.get(`/dm-messages/${messageId}/edits`)).data;
}

// The previews this device made for its own message (services/linkPreviewCrypto.js), or null.
export async function setLinkPreviews(messageId, previews) {
  await api.put(`/dm-messages/${messageId}/link-previews`, { previews });
}

export async function deleteMessage(messageId) {
  await api.delete(`/messages/${messageId}`);
}

// The conversation's pinned messages (encrypted rows), most recently pinned first.
export async function fetchPins(userId) {
  return (await api.get(`/dm-pins/${userId}`)).data;
}

// -> { messageId, pinned_at, pinned_by } (null when unpinned).
export async function setMessagePinned(messageId, pinned) {
  return (await api[pinned ? 'put' : 'delete'](`/dm-messages/${messageId}/pin`)).data;
}
