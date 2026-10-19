// The desktop app's in-game overlay (electron/overlay.js, page in src/overlay/): what it shows
// of the voice channel or call you're in, sent by the main page (hooks/useGameOverlay.js).

// The overlay's voice state, or null when not in voice: { title, status, selfMute, selfDeaf,
// members: [{ id, name, avatar, speaking, muted, deafened, self }] }. `voice`: the voice
// snapshot (voice/voiceClient.js); `title`: what the voice bar shows (utils/voiceTitle.js);
// `channelMembers`: the guild channel's voice states, which say who's deafened (calls have
// none); `name(id, fallback)` and `avatar(id)` (utils/profiles.js).
// Everyone in the room, you first; while connecting, the channel's list.
export function overlayVoiceState(voice, { title, channelMembers = null, name, avatar }) {
  if (voice.status === 'idle') return null;
  const states = new Map((channelMembers ?? []).map((m) => [String(m.user_id), m]));
  const speaking = new Set(voice.status === 'connected' ? voice.speaking : []);
  const ids = voice.participants?.length ? voice.participants : [...states.keys()];
  const members = ids.map((id) => {
    const self = id === voice.identity;
    const state = states.get(id);
    const deafened = self ? Boolean(voice.selfDeaf) : Boolean(state?.self_deaf);
    return {
      id,
      name: name(id, state?.username ?? ''),
      avatar: avatar(id),
      speaking: speaking.has(id),
      muted: self
        ? Boolean(voice.selfMute || voice.selfDeaf)
        : Boolean(state?.self_mute || deafened || voice.muted.includes(id)),
      deafened,
      self,
    };
  });
  return {
    title,
    status: voice.status,
    selfMute: Boolean(voice.selfMute),
    selfDeaf: Boolean(voice.selfDeaf),
    members,
  };
}
