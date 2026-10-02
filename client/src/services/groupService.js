import api from '../utils/api';

// The group DM API (server/routes/groupDms.js). Everything sent is signed or encrypted on the
// device (groupKeys.js, groupCrypto.js).

export async function fetchGroups() {
  return (await api.get('/group-dms')).data;
}

// { ...summary, log, users (public keys), epochs (mine, encrypted), latest_epoch, call }
export async function fetchGroup(groupId) {
  return (await api.get(`/group-dms/${groupId}`)).data;
}

export async function createGroupRequest(body) {
  return (await api.post('/group-dms', body)).data;
}

export async function renameGroup(groupId, name) {
  return (await api.patch(`/group-dms/${groupId}`, { name })).data;
}

export async function postLogEntry(groupId, entry, epoch) {
  return (await api.post(`/group-dms/${groupId}/log`, { entry, epoch })).data;
}

export async function postEpoch(groupId, epoch) {
  return (await api.post(`/group-dms/${groupId}/epochs`, epoch)).data;
}

export async function fetchGroupMessages(groupId, params = {}) {
  return (await api.get(`/group-dms/${groupId}/messages`, { params })).data;
}

export async function sendGroupMessage(groupId, epoch, content, replyTo = null) {
  return (await api.post(`/group-dms/${groupId}/messages`, { epoch, content, replyTo })).data;
}

export async function editGroupMessage(messageId, content) {
  await api.put(`/group-dm-messages/${messageId}`, { content });
}

export async function deleteGroupMessage(messageId) {
  await api.delete(`/group-dm-messages/${messageId}`);
}

export async function addGroupReaction(messageId, content) {
  return (await api.post(`/group-dm-messages/${messageId}/reactions`, { content })).data;
}

export async function removeGroupReaction(reactionId) {
  await api.delete(`/group-dm-reactions/${reactionId}`);
}

export async function markGroupRead(groupId, messageId) {
  await api.post(`/group-dms/${groupId}/read`, { messageId });
}

// Marks a group read up to its newest message (Mark As Read in the DM list).
export async function markGroupReadToLatest(groupId) {
  await api.post(`/group-dms/${groupId}/read`, { latest: true });
}

export async function fetchGroupPins(groupId) {
  return (await api.get(`/group-dms/${groupId}/pins`)).data;
}

export async function setGroupMessagePinned(messageId, pinned) {
  return (await api[pinned ? 'put' : 'delete'](`/group-dm-messages/${messageId}/pin`)).data;
}
