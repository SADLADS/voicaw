// Who's sharing their screen in a guild voice channel you can see ("Streaming in #lounge" on
// their card and in lists, as Discord's Go Live), by user id: { guildId, channelId, channelName }.
// Only guild voice: calls are private. Kept by hooks/useGuildList.js from the guild list
// (`streams`), guild layouts (who's in each voice channel) and `guild_voice_state` events, which
// the server only sends about channels you can see.

const byUser = new Map();
let version = 0;
const listeners = new Set();

function changed() {
  version += 1;
  listeners.forEach((cb) => cb());
}

function dropGuild(guildId) {
  for (const [userId, stream] of byUser) if (stream.guildId === String(guildId)) byUser.delete(userId);
}

// Everyone streaming in `guildId`, from the guild list ([{ user_id, channel_id, channel_name }]).
export function setGuildStreams(guildId, streams) {
  dropGuild(guildId);
  for (const s of streams ?? []) {
    byUser.set(String(s.user_id), { guildId: String(guildId), channelId: String(s.channel_id), channelName: s.channel_name ?? null });
  }
  changed();
}

// From a guild's layout (what you can see of it, with who's in each voice channel).
export function setStreamsFromLayout(guild) {
  const streams = [];
  for (const channel of guild.channels ?? []) {
    for (const s of channel.voice ?? []) {
      if (s.self_stream) streams.push({ user_id: s.user_id, channel_id: channel.id, channel_name: channel.name });
    }
  }
  setGuildStreams(guild.id, streams);
}

// A `guild_voice_state` event: joined, changed (sharing or not) or left (state null).
export function applyStreamVoiceState({ guildId, channelId, channelName, userId, state }) {
  const id = String(userId);
  const before = byUser.get(id);
  if (state?.self_stream) {
    byUser.set(id, { guildId: String(guildId), channelId: String(channelId), channelName: channelName ?? before?.channelName ?? null });
  } else if (before && before.guildId === String(guildId)) {
    byUser.delete(id);
  } else {
    return;
  }
  changed();
}

export function removeGuildStreams(guildId) {
  dropGuild(guildId);
  changed();
}

// On logout.
export function resetVoiceStreams() {
  byUser.clear();
  changed();
}

export function subscribeVoiceStreams(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function getVoiceStreamsVersion() {
  return version;
}

export function streamOf(userId) {
  return byUser.get(String(userId)) ?? null;
}
