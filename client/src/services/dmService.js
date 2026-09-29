import api from '../utils/api';

export async function fetchUsersList() {
  const res = await api.get('/dms-list');
  return res.data;
}

export async function fetchMessagesForUser(userId, params = {}) {
  const res = await api.get(`/dm-messages/${userId}`, { params });
  return res.data;
}


export async function sendMessageToUser(recipientId, content, replyTo = null) {
  const res = await api.post('/dm-send', {
    recipient_id: recipientId,
    content,
    replyTo,
  });
  return res.data;
}

export async function markMessagesRead(userId) {
  await api.post(`/dm-mark-read/${userId}`);
}
// `content` is the encrypted emoji (encryptReaction).
export async function addReaction(messageId, content) {
  const res = await api.post('/dm-reactions', { messageId, content });
  return res.data;
}

export async function removeReaction(reactionId) {
  await api.delete(`/dm-reactions/${reactionId}`);
}

// `content` is the new ciphertext.
export async function editMessage(messageId, content) {
  await api.put(`/update-message/${messageId}`, { content });
}

export async function deleteMessage(messageId) {
  await api.delete(`/messages/${messageId}`);
}
