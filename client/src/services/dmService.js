import api from '../utils/api';

export async function fetchUsersList() {
    const res = await api.get('/dms-list');
    return res.data;
  }
  
  export async function fetchMessagesForUser(userId) {
    const res = await api.get(`/dm-messages/${userId}`);
    return res.data;
  }
  
  export async function sendMessageToUser(recipientId, content) {
    await api.post('/dm-send', {
      recipient_id: recipientId,
      content,
    });
  }
  
  export async function markMessagesRead(userId) {
    await api.post(`/dm-mark-read/${userId}`);
  }