import api from '../utils/api';

// Telling the server when a poll closes, so it posts the "poll ended" row then (server
// pollTimers.js). `kind`: 'dm' (also notes), 'group' or 'guild'. In encrypted chats this is all
// the server learns about a poll: that the message is one, and when it closes.

export async function registerPollTimer(kind, messageId, duration) {
  const res = await api.post(`/polls/${kind}/${messageId}/timer`, { duration });
  return res.data;
}

// Ends it now (after the poll's own text says so): its row is posted at once.
export async function endPollOnServer(kind, messageId) {
  const res = await api.post(`/polls/${kind}/${messageId}/end`);
  return res.data;
}

// Removes an answer someone added to the open poll `messageId` in a guild channel, with its
// votes (server guildMessages.js; its creator, the poll's author or a moderator). Resolves to
// the ids of the reactions it deleted.
export async function removeGuildPollAnswer(messageId, answerId) {
  const res = await api.delete(`/guild-messages/${messageId}/poll-answers/${answerId}`);
  return res.data.removed;
}
