import api from '../utils/api';

// The DM call API (server/routes/calls.js). The call's key only ever goes to the server
// encrypted (voice/callClient.js).

export async function fetchCurrentCall() {
  return (await api.get('/dm-calls/current')).data;
}

// -> { call, url, token }
export async function startCallRequest(calleeId, callId, keyEnvelope) {
  return (await api.post('/dm-calls', { calleeId, callId, keyEnvelope })).data;
}

// -> { call, url, token }
export async function acceptCallRequest(callId) {
  return (await api.post(`/dm-calls/${callId}/accept`)).data;
}

export async function declineCallRequest(callId) {
  await api.post(`/dm-calls/${callId}/decline`);
}

export async function hangUpRequest(callId) {
  await api.delete(`/dm-calls/${callId}`);
}

// -> { call, url, token }; 409 with `call` when the group already has one.
export async function startGroupCallRequest(groupId, callId, epoch, keyEnvelope) {
  return (await api.post(`/group-dms/${groupId}/call`, { callId, epoch, keyEnvelope })).data;
}
