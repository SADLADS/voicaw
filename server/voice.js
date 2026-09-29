const { AccessToken, RoomServiceClient, WebhookReceiver, TrackSource } = require('livekit-server-sdk');
const config = require('./config');
const { PERMISSIONS, has } = require('./permissions');
const { getChannelAccess, sendToChannel } = require('./guilds');

// Voice channels. The audio goes through a LiveKit server (see README.md); this API only
// decides who may join (a short-lived LiveKit token per join) and keeps track of who is in
// which channel, so everyone who can see a channel sees who's in it.
//
// Each voice channel is a LiveKit room `channel-<id>`; a participant's identity is their user
// id. LiveKit tells us about joins and leaves through webhooks (handleWebhookEvent), which makes it
// the source of truth: a closed tab or a lost connection is noticed by LiveKit either way. A
// user is in at most one voice channel at a time (joining another leaves the first).
// Self mute and deafen are reported by the client and kept here (and in LiveKit's participant
// attributes, so they survive an API restart).

const TOKEN_TTL = '10m'; // only for joining; LiveKit keeps a connected client's token fresh
const ROOM_PREFIX = 'channel-';

const roomName = (channelId) => `${ROOM_PREFIX}${channelId}`;
function channelIdOfRoom(name) {
  const match = /^channel-(\d+)$/.exec(name ?? '');
  return match ? Number(match[1]) : null;
}

// Replaceable by tests (they have no LiveKit server).
const livekit = {
  roomService: config.livekit
    ? new RoomServiceClient(config.livekit.apiUrl, config.livekit.apiKey, config.livekit.apiSecret)
    : null,
};
const receiver = config.livekit ? new WebhookReceiver(config.livekit.apiKey, config.livekit.apiSecret) : null;

// userId -> { userId, username, guildId, channelId, sid, selfMute, selfDeaf, canSpeak, joinedAt }
const states = new Map();
// userId -> { selfMute, selfDeaf }: what the client last said, applied when it joins.
const preferences = new Map();
// Participant sessions that already left: a late "joined" webhook for them is ignored.
const leftSids = new Set();
function rememberLeft(sid) {
  if (!sid) return;
  leftSids.add(sid);
  setTimeout(() => leftSids.delete(sid), 10 * 60 * 1000).unref();
}

const publicState = (s) => ({ user_id: s.userId, username: s.username, self_mute: s.selfMute, self_deaf: s.selfDeaf });

// Who's in each of the given voice channels (for the guild layout), in joining order.
function membersOf(channelId) {
  return [...states.values()]
    .filter((s) => s.channelId === channelId)
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map(publicState);
}

// Tells everyone who can see the channel that `userId` is now in it with `state`, or left (null).
async function announce(guildId, channelId, userId, state) {
  await sendToChannel(
    { id: channelId, guild_id: guildId },
    { type: 'guild_voice_state', guildId, channelId, userId, state: state && publicState(state) }
  );
}

function logLiveKitError(what, err) {
  // "not found": they had already gone.
  if (err?.status === 404 || /not.?found/i.test(err?.message ?? '')) return;
  console.error(`LiveKit: ${what} failed:`, err?.message ?? err);
}

// Takes the user out of their voice channel (in LiveKit too) and tells the channel.
async function disconnect(userId) {
  const state = states.get(userId);
  if (!state) return;
  states.delete(userId);
  rememberLeft(state.sid);
  livekit.roomService?.removeParticipant(roomName(state.channelId), String(userId))
    .catch((err) => logLiveKitError('removing a participant', err));
  await announce(state.guildId, state.channelId, userId, null);
}

function publishPermission(canSpeak) {
  return {
    canSubscribe: true,
    canPublish: canSpeak,
    canPublishSources: canSpeak ? [TrackSource.MICROPHONE] : [],
    canPublishData: false,
    canUpdateMetadata: false,
  };
}

// { url, token } for joining LiveKit room `room` as `userId`: the microphone only, and only
// with `canSpeak`. Also used for DM calls (calls.js).
async function roomToken({ room, userId, username, canSpeak }) {
  const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: String(userId),
    name: username,
    ttl: TOKEN_TTL,
  });
  token.addGrant({
    roomJoin: true,
    room,
    canUpdateOwnMetadata: false,
    ...publishPermission(canSpeak),
  });
  return { url: config.livekit.url, token: await token.toJwt() };
}

// A token to join `channel` (a voice channel the caller may connect to). Leaves any other
// voice channel, and hangs up any call, first. `selfMute`/`selfDeaf` are how the client joins.
async function joinToken({ channel, userId, username, permissions, selfMute, selfDeaf }) {
  const current = states.get(userId);
  if (current && current.channelId !== channel.id) await disconnect(userId);
  await require('./calls').endCallOf(userId);
  preferences.set(userId, { selfMute: Boolean(selfMute), selfDeaf: Boolean(selfDeaf) });
  return roomToken({ room: roomName(channel.id), userId, username, canSpeak: has(permissions, PERMISSIONS.SPEAK) });
}

function syncAttributes(state) {
  livekit.roomService?.updateParticipant(roomName(state.channelId), String(state.userId), {
    attributes: { selfMute: state.selfMute ? '1' : '', selfDeaf: state.selfDeaf ? '1' : '' },
  }).catch((err) => logLiveKitError('saving mute/deafen', err));
}

// The client's own mute/deafen. Returns the user's state, or null when they're not in voice
// (yet: the preference is kept for when they join).
async function setSelfState(userId, { selfMute, selfDeaf }) {
  const preference = { selfMute: Boolean(selfMute), selfDeaf: Boolean(selfDeaf) };
  preferences.set(userId, preference);
  const state = states.get(userId);
  if (!state) return null;
  if (state.selfMute === preference.selfMute && state.selfDeaf === preference.selfDeaf) return state;
  Object.assign(state, preference);
  syncAttributes(state);
  await announce(state.guildId, state.channelId, userId, state);
  return state;
}

// May `userId` be in this voice channel? Returns the access (with `permissions`) or null.
async function voiceAccess(channelId, userId) {
  const access = await getChannelAccess(channelId, userId);
  if (!access || access.channel.type !== 'voice') return null;
  const needed = PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.CONNECT;
  return has(access.permissions, needed) ? access : null;
}

async function participantJoined(channelId, participant) {
  const userId = Number(participant.identity);
  if (!Number.isInteger(userId) || leftSids.has(participant.sid)) return;
  const access = await voiceAccess(channelId, userId);
  if (!access) {
    // Lost access between getting the token and joining.
    livekit.roomService?.removeParticipant(roomName(channelId), participant.identity)
      .catch((err) => logLiveKitError('removing a participant', err));
    return;
  }
  const previous = states.get(userId);
  if (previous && previous.channelId !== channelId) {
    states.delete(userId);
    await announce(previous.guildId, previous.channelId, userId, null);
  }
  const preference = preferences.get(userId) ?? { selfMute: false, selfDeaf: false };
  const state = {
    userId,
    username: participant.name || String(userId),
    guildId: access.channel.guild_id,
    channelId,
    sid: participant.sid,
    ...preference,
    canSpeak: has(access.permissions, PERMISSIONS.SPEAK),
    joinedAt: previous?.channelId === channelId ? previous.joinedAt : Date.now(),
  };
  states.set(userId, state);
  if (state.selfMute || state.selfDeaf) syncAttributes(state);
  await announce(state.guildId, channelId, userId, state);
}

async function participantLeft(channelId, participant) {
  const userId = Number(participant.identity);
  rememberLeft(participant.sid);
  const state = states.get(userId);
  // Only if it's that session: joining from another device replaces the old one, and its
  // "left" can arrive after the new one's "joined".
  if (!state || state.channelId !== channelId || state.sid !== participant.sid) return;
  states.delete(userId);
  await announce(state.guildId, channelId, userId, null);
}

async function roomFinished(channelId) {
  for (const state of [...states.values()]) {
    if (state.channelId !== channelId) continue;
    states.delete(state.userId);
    await announce(state.guildId, channelId, state.userId, null);
  }
}

// A webhook request from LiveKit: `body` is the raw text, `authorization` its signature.
// Resolves to the event; rejects if it isn't signed with our API key.
function verifyWebhook(body, authorization) {
  return receiver.receive(body, authorization);
}

async function handleWebhookEvent(event) {
  // DM call rooms are calls.js's.
  if (event.room?.name?.startsWith('call-')) {
    await require('./calls').handleWebhookEvent(event);
    return;
  }
  const channelId = channelIdOfRoom(event.room?.name);
  if (channelId == null) return;
  if (event.event === 'participant_joined') await participantJoined(channelId, event.participant);
  else if (event.event === 'participant_left') await participantLeft(channelId, event.participant);
  else if (event.event === 'room_finished') await roomFinished(channelId);
}

// After anything in the guild changed (roles, overrides, channels, members): whoever may no
// longer be in their voice channel is disconnected, and Speak is given or taken away.
async function enforceGuild(guildId) {
  for (const state of [...states.values()]) {
    if (state.guildId !== guildId) continue;
    const access = await voiceAccess(state.channelId, state.userId);
    if (!access) {
      await disconnect(state.userId);
      continue;
    }
    const canSpeak = has(access.permissions, PERMISSIONS.SPEAK);
    if (canSpeak !== state.canSpeak) {
      state.canSpeak = canSpeak;
      livekit.roomService?.updateParticipant(roomName(state.channelId), String(state.userId), {
        permission: publishPermission(canSpeak),
      }).catch((err) => logLiveKitError('changing Speak', err));
    }
  }
}

// When the API starts: who's in which room right now (joins and leaves while it was down
// never reached it).
async function restoreFromLiveKit() {
  if (!livekit.roomService) return;
  try {
    for (const room of await livekit.roomService.listRooms()) {
      const channelId = channelIdOfRoom(room.name);
      if (channelId == null) continue;
      for (const participant of await livekit.roomService.listParticipants(room.name)) {
        const userId = Number(participant.identity);
        const access = await voiceAccess(channelId, userId);
        if (!access) continue;
        states.set(userId, {
          userId,
          username: participant.name || String(userId),
          guildId: access.channel.guild_id,
          channelId,
          sid: participant.sid,
          selfMute: participant.attributes?.selfMute === '1',
          selfDeaf: participant.attributes?.selfDeaf === '1',
          canSpeak: has(access.permissions, PERMISSIONS.SPEAK),
          joinedAt: Number(participant.joinedAt ?? 0) * 1000 || Date.now(),
        });
      }
    }
  } catch (err) {
    console.error('LiveKit: could not list who is in voice:', err?.message ?? err);
  }
}

// Everyone in voice in the guild is disconnected (the guild is being deleted).
async function disconnectGuild(guildId) {
  for (const state of [...states.values()]) {
    if (state.guildId !== guildId) continue;
    states.delete(state.userId);
    livekit.roomService?.removeParticipant(roomName(state.channelId), String(state.userId))
      .catch((err) => logLiveKitError('removing a participant', err));
  }
}

module.exports = {
  livekit,
  states,
  roomName,
  membersOf,
  joinToken,
  roomToken,
  logLiveKitError,
  setSelfState,
  voiceAccess,
  disconnect,
  verifyWebhook,
  handleWebhookEvent,
  enforceGuild,
  disconnectGuild,
  restoreFromLiveKit,
};
