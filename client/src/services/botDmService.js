import api from '../utils/api';

// Conversations with bots (server/botDms.js, routes/botDms.js). NOT end-to-end encrypted: the
// server stores these messages as plain text, unlike DMs with people.

// [{ id, bot_id, last_timestamp, unread, last_unread_sender_id, last_unread_timestamp }].
export const fetchBotDms = async () => (await api.get('/bot-dms')).data;
// Starts (or finds) the conversation with bot `botId`; resolves to its summary.
export const startBotDm = async (botId) => (await api.post('/bot-dms', { bot_id: botId })).data;
export const fetchBotDmMessages = async (dmId, params = {}) => (await api.get(`/bot-dms/${dmId}/messages`, { params })).data;
export const sendBotDmMessage = async (dmId, content) => (await api.post(`/bot-dms/${dmId}/messages`, { content })).data;
export const editBotDmMessage = async (dmId, messageId, content) => (await api.put(`/bot-dms/${dmId}/messages/${messageId}`, { content })).data;
export const deleteBotDmMessage = (dmId, messageId) => api.delete(`/bot-dms/${dmId}/messages/${messageId}`);
export const markBotDmRead = (dmId, messageId) => api.post(`/bot-dms/${dmId}/read`, { messageId });
// Deletes the whole conversation, for the bot too.
export const deleteBotDm = (dmId) => api.delete(`/bot-dms/${dmId}`);
