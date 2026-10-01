import api from '../utils/api';

// The voice API (server/routes/voice.js). The audio itself goes to LiveKit (voice/voiceClient.js).

// { url, token } for joining a voice channel's LiveKit room.
export async function fetchVoiceToken(guildId, channelId, { selfMute, selfDeaf }) {
  return (await api.post(`/guilds/${guildId}/channels/${channelId}/voice`, { selfMute, selfDeaf })).data;
}

export async function saveVoiceState({ selfMute, selfDeaf }) {
  await api.put('/voice/state', { selfMute, selfDeaf });
}

export async function leaveVoiceChannel() {
  await api.delete('/voice');
}
