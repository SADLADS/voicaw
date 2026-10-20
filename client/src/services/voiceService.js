import api from '../utils/api';

// The voice API (server/routes/voice.js). The audio itself goes to LiveKit (voice/voiceClient.js).

// { url, token, bitrate } for joining a voice channel's LiveKit room (on its voice region's server).
export async function fetchVoiceToken(guildId, channelId, { selfMute, selfDeaf }) {
  return (await api.post(`/guilds/${guildId}/channels/${channelId}/voice`, { selfMute, selfDeaf })).data;
}

export async function saveVoiceState({ selfMute, selfDeaf }) {
  await api.put('/voice/state', { selfMute, selfDeaf });
}

// Whose screen share this device watches in its voice channel or call (a user id, or null),
// which everyone in the room sees.
export async function saveWatching(watching) {
  await api.put('/voice/watching', { watching });
}

export async function leaveVoiceChannel() {
  await api.delete('/voice');
}

// The voice regions a voice channel can be put in: [{ id, name, flag, default }].
export async function fetchVoiceRegions() {
  return (await api.get('/voice/regions')).data;
}
