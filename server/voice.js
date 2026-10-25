const { AccessToken, RoomServiceClient, WebhookReceiver, TrackSource } = require('livekit-server-sdk');
const config = require('./config');
const { PERMISSIONS, has } = require('./permissions');
const voiceRegions = require('./voiceRegions');
const { sendToUserSockets } = require('./sockets');
const { ActionError } = require('./actionError');
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
// attributes, so they survive an API restart). Whether someone is sharing their screen (live)
// or their camera comes from LiveKit's track webhooks, so it's what LiveKit actually carries.

const TOKEN_TTL = '10m'; // only for joining; LiveKit keeps a connected client's token fresh
const ROOM_PREFIX = 'channel-';

const roomName = (channelId) => `${ROOM_PREFIX}${channelId}`;
function channelIdOfRoom(name) {
  const match = /^channel-(\d+)$/.exec(name ?? '');
  return match ? Number(match[1]) : null;
}

// Each region (voiceRegions.js) is its own LiveKit server, with its own client here.
// `roomService` is the built-in one's (.env); `connect` makes the others'. Both replaceable by
// tests (they have no LiveKit server).
const livekit = {
  roomService: config.livekit
    ? new RoomServiceClient(config.livekit.apiUrl, config.livekit.apiKey, config.livekit.apiSecret)
    : null,
  connect: (c) => new RoomServiceClient(c.apiUrl, c.apiKey, c.apiSecret),
};
// regionId -> { connection, client }, for the regions that aren't built in.
const clients = new Map();

// The LiveKit client of region `regionId` (null: none, as in tests). A region just removed
// keeps its client until the people in it have been moved out (forgetRegion).
function serviceFor(regionId) {
  const region = voiceRegions.byId(regionId);
  if (!region) return clients.get(regionId)?.client ?? null;
  if (region.builtin) return livekit.roomService;
  const connection = voiceRegions.connectionOf(region);
  if (!connection) return null;
  const known = clients.get(regionId);
  if (known && known.connection.apiUrl === connection.apiUrl && known.connection.apiKey === connection.apiKey &&
    known.connection.apiSecret === connection.apiSecret) return known.client;
  const client = livekit.connect(connection);
  clients.set(regionId, { connection, client });
  return client;
}
const forgetRegion = (regionId) => clients.delete(regionId);

// userId -> { userId, username, guildId, channelId, sid, selfMute, selfDeaf, streaming, video, canSpeak,
// canStream, canListen, joinedAt }
const states = new Map();
// userId -> { selfMute, selfDeaf }: what the client last said, applied when it joins.
const preferences = new Map();
// userId -> { watching, at }: whose stream the client said it watches before its "joined"
// webhook arrived, applied then (for a minute).
const pendingWatching = new Map();
const PENDING_WATCHING_MS = 60 * 1000;
// Participant sessions that already left: a late "joined" webhook for them is ignored.
const leftSids = new Set();
function rememberLeft(sid) {
  if (!sid) return;
  leftSids.add(sid);
  setTimeout(() => leftSids.delete(sid), 10 * 60 * 1000).unref();
}

// `listening`: whether they may hear the others (Listen); the app marks bots that can.
const publicState = (s) => ({
  user_id: s.userId, username: s.username, self_mute: s.selfMute, self_deaf: s.selfDeaf, self_stream: s.streaming,
  self_video: Boolean(s.video), listening: s.canListen !== false,
});

// Is the participant (LiveKit's ParticipantInfo) publishing a track from `source`?
const publishes = (participant, source) => (participant?.tracks ?? []).some((t) => t.source === source);
const sharesScreen = (participant) => publishes(participant, TrackSource.SCREEN_SHARE);
const showsCamera = (participant) => publishes(participant, TrackSource.CAMERA);

// Everyone in a voice channel right now (their states; levels' voice XP, guildLevels.js).
const allStates = () => [...states.values()];

// Who's in each of the given voice channels (for the guild layout), in joining order.
function membersOf(channelId) {
  return [...states.values()]
    .filter((s) => s.channelId === channelId)
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map(publicState);
}

// Who's in the voice channels of `guildId` that `userId` can see, { voice, streams }: `voice` is
// { [channelId]: [userId] } (the speaker on the guild rail, for guilds whose layout the app
// hasn't loaded), `streams` who's sharing their screen there, [{ user_id, channel_id,
// channel_name }] ("Streaming in …" on their card and in lists).
async function guildVoiceFor(guildId, userId) {
  const occupied = new Map();
  for (const s of states.values()) {
    if (s.guildId !== guildId) continue;
    if (!occupied.has(s.channelId)) occupied.set(s.channelId, []);
    occupied.get(s.channelId).push(s);
  }
  const voice = {};
  const streams = [];
  for (const [channelId, inChannel] of occupied) {
    const access = await getChannelAccess(channelId, userId);
    if (!access || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) continue;
    voice[channelId] = inChannel.map((s) => s.userId);
    const streaming = inChannel.filter((s) => s.streaming);
    if (streaming.length) {
      const name = await channelName(channelId);
      for (const s of streaming) streams.push({ user_id: s.userId, channel_id: channelId, channel_name: name });
    }
  }
  return { voice, streams };
}

async function channelName(channelId) {
  return (await require('./db').get('SELECT name FROM guild_channels WHERE id = ?', [channelId]))?.name ?? null;
}

// Tells everyone who can see the channel that `userId` is now in it with `state`, or left (null).
// A Watch Together party (watchParty.js) ends a while after its channel empties.
async function announce(guildId, channelId, userId, state) {
  await sendToChannel(
    { id: channelId, guild_id: guildId },
    // The channel's name, for "Streaming in …" where its guild isn't open.
    { type: 'guild_voice_state', guildId, channelId, channelName: await channelName(channelId), userId, state: state && publicState(state) }
  );
  require('./watchParty').voiceChanged(channelId, [...states.values()].some((s) => s.channelId === channelId));
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
  serviceFor(state.regionId)?.removeParticipant(roomName(state.channelId), String(userId))
    .catch((err) => logLiveKitError('removing a participant', err));
  await announce(state.guildId, state.channelId, userId, null);
}

// Video (Stream: camera and screen share) for a member's `access` (voiceAccess): bots send
// audio only, never video.
const canStreamWith = (access) => has(access.permissions, PERMISSIONS.STREAM) && !access.member?.isBot;

// The microphone with Speak; the camera, and a screen share (and its sound), with Video
// (Stream). Hearing the others (subscribing to their tracks) with Listen: LiveKit enforces all
// three, and they change live (enforceGuild). `canCamera` alone: the camera without screen
// sharing (DM and group calls).
function publishPermission(canSpeak, canStream = false, canListen = true, canCamera = canStream) {
  const sources = [
    ...(canSpeak ? [TrackSource.MICROPHONE] : []),
    ...(canCamera ? [TrackSource.CAMERA] : []),
    ...(canStream ? [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] : []),
  ];
  return {
    canSubscribe: canListen,
    canPublish: sources.length > 0,
    canPublishSources: sources,
    canPublishData: false,
    canUpdateMetadata: false,
  };
}

// { url, token } for joining LiveKit room `room` as `userId`: the microphone with `canSpeak`,
// the camera and a screen share with `canStream` (only the camera with `canCamera`), hearing
// the others with `canListen`, on region `regionId`'s LiveKit (voiceRegions.js). Also used for
// DM calls (calls.js), where everyone hears.
async function roomToken({ room, regionId, userId, username, canSpeak, canStream = false, canListen = true, canCamera = canStream }) {
  const connection = voiceRegions.connectionOf(voiceRegions.byId(regionId));
  if (!connection) throw new ActionError(503, "Voice isn't set up yet");
  const token = new AccessToken(connection.apiKey, connection.apiSecret, {
    identity: String(userId),
    name: username,
    ttl: TOKEN_TTL,
  });
  token.addGrant({
    roomJoin: true,
    room,
    canUpdateOwnMetadata: false,
    ...publishPermission(canSpeak, canStream, canListen, canCamera),
  });
  return { url: connection.url, token: await token.toJwt() };
}

// Voice channels' bitrates (bits/s): Discord's range, up to its most boosted servers'.
const MIN_BITRATE = 8000;
const MAX_BITRATE = 384000;
const DEFAULT_BITRATE = 64000;
const MAX_USER_LIMIT = 99;

// The most a screen share may send, as the client takes it: { resolution: '720' | '1080' |
// 'source', frameRate: 15 | 30 | 60 } (Settings → Admin).
async function streamLimit() {
  const { getSetting } = require('./appSettings');
  return {
    resolution: await getSetting('streamMaxResolution'),
    frameRate: Number(await getSetting('streamMaxFramerate')),
  };
}

// Whether the channel is full for `userId` (its user limit reached by others). Manage Channels
// joins anyway (as Move Members does in Discord), and so does someone already in it.
function isFull(channel, userId, permissions) {
  if (!channel.user_limit || has(permissions, PERMISSIONS.MANAGE_CHANNELS)) return false;
  const others = [...states.values()].filter((s) => s.channelId === channel.id && s.userId !== userId);
  return others.length >= channel.user_limit;
}

// A token to join `channel` (a voice channel the caller may connect to). Leaves any other
// voice channel, and hangs up any call, first. `selfMute`/`selfDeaf` are how the client joins.
// A bot (`isBot`) sends audio only.
async function joinToken({ channel, userId, username, permissions, selfMute, selfDeaf, isBot = false }) {
  const region = voiceRegions.forChannel(channel);
  if (!region) throw new ActionError(503, "Voice isn't set up yet");
  if (isFull(channel, userId, permissions)) throw new ActionError(403, 'This voice channel is full', 0);
  const current = states.get(userId);
  if (current && current.channelId !== channel.id) await disconnect(userId);
  await require('./calls').endCallOf(userId);
  preferences.set(userId, { selfMute: Boolean(selfMute), selfDeaf: Boolean(selfDeaf) });
  const token = await roomToken({
    room: roomName(channel.id),
    regionId: region.id,
    userId,
    username,
    canSpeak: has(permissions, PERMISSIONS.SPEAK),
    canStream: has(permissions, PERMISSIONS.STREAM) && !isBot,
    canListen: has(permissions, PERMISSIONS.LISTEN),
  });
  // `bitrate`: what the client sends its microphone at; `streamLimit`: the most it may share
  // its screen at (Settings → Admin; kept by the client, not enforced by LiveKit).
  return { ...token, bitrate: channel.bitrate ?? DEFAULT_BITRATE, streamLimit: await streamLimit() };
}

function syncAttributes(state) {
  serviceFor(state.regionId)?.updateParticipant(roomName(state.channelId), String(state.userId), {
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

// Whose stream the client watches (a user id as a string, '' for none), as the participant's
// `watching` attribute, so everyone in the room sees who watches (LiveKit itself never tells
// a sharer who subscribed). LiveKit merges attributes, so mute and deafen stay. Returns false
// when the user isn't in a voice channel (a call, then: calls.js).
function setWatching(userId, watching) {
  const state = states.get(userId);
  if (!state) {
    pendingWatching.set(userId, { watching, at: Date.now() });
    return false;
  }
  pendingWatching.delete(userId);
  syncWatching(state, watching);
  return true;
}

function syncWatching(state, watching) {
  serviceFor(state.regionId)?.updateParticipant(roomName(state.channelId), String(state.userId), {
    attributes: { watching },
  }).catch((err) => logLiveKitError('saving who is watching', err));
}

// May `userId` be in this voice channel? Returns the access (with `permissions`) or null.
async function voiceAccess(channelId, userId) {
  const access = await getChannelAccess(channelId, userId);
  if (!access || access.channel.type !== 'voice') return null;
  const needed = PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.CONNECT;
  return has(access.permissions, needed) ? access : null;
}

// `regionId`: the region whose LiveKit said so.
async function participantJoined(channelId, participant, regionId) {
  const userId = Number(participant.identity);
  if (!Number.isInteger(userId) || leftSids.has(participant.sid)) return;
  const access = await voiceAccess(channelId, userId);
  // Lost access between getting the token and joining, or joined with a token from before the
  // channel moved to another region.
  if (!access || voiceRegions.forChannel(access.channel)?.id !== regionId) {
    rememberLeft(participant.sid);
    serviceFor(regionId)?.removeParticipant(roomName(channelId), participant.identity)
      .catch((err) => logLiveKitError('removing a participant', err));
    return;
  }
  const previous = states.get(userId);
  if (previous && previous.channelId !== channelId) {
    states.delete(userId);
    await announce(previous.guildId, previous.channelId, userId, null);
  } else if (previous && previous.regionId !== regionId) {
    // Moved here from the channel's old region: LiveKit only replaces a session on the same
    // server, so the old one is ended here.
    rememberLeft(previous.sid);
    serviceFor(previous.regionId)?.removeParticipant(roomName(channelId), participant.identity)
      .catch((err) => logLiveKitError('removing a participant', err));
  }
  const preference = preferences.get(userId) ?? { selfMute: false, selfDeaf: false };
  const state = {
    userId,
    username: participant.name || String(userId),
    guildId: access.channel.guild_id,
    channelId,
    regionId,
    sid: participant.sid,
    ...preference,
    streaming: sharesScreen(participant),
    video: showsCamera(participant),
    canSpeak: has(access.permissions, PERMISSIONS.SPEAK),
    canStream: canStreamWith(access),
    canListen: has(access.permissions, PERMISSIONS.LISTEN),
    isBot: Boolean(access.member?.isBot),
    joinedAt: previous?.channelId === channelId ? previous.joinedAt : Date.now(),
  };
  states.set(userId, state);
  if (state.selfMute || state.selfDeaf) syncAttributes(state);
  const pending = pendingWatching.get(userId);
  pendingWatching.delete(userId);
  if (pending?.watching && Date.now() - pending.at < PENDING_WATCHING_MS) syncWatching(state, pending.watching);
  await announce(state.guildId, channelId, userId, state);
  // Just arrived (not a new session in the same channel): their join sound plays.
  if (previous?.channelId !== channelId) {
    await require('./soundboard').playJoinSound(state).catch((err) => console.error('Join sound failed:', err.message));
  }
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

// A track was published or unpublished: only screen shares (going live or not) and cameras
// matter.
const TRACK_STATES = { [TrackSource.SCREEN_SHARE]: 'streaming', [TrackSource.CAMERA]: 'video' };

async function trackChanged(channelId, participant, track, published) {
  const key = TRACK_STATES[track?.source];
  if (!key) return;
  const state = states.get(Number(participant?.identity));
  if (!state || state.channelId !== channelId || state.sid !== participant.sid) return;
  if (Boolean(state[key]) === published) return;
  state[key] = published;
  await announce(state.guildId, channelId, state.userId, state);
}

// (Only on that region's server: after a move, the old room finishing leaves the new one be.)
async function roomFinished(channelId, regionId) {
  for (const state of [...states.values()]) {
    if (state.channelId !== channelId || state.regionId !== regionId) continue;
    states.delete(state.userId);
    await announce(state.guildId, channelId, state.userId, null);
  }
}

// The API key a webhook says it's signed with (its JWT's issuer; checked by verifyWebhook).
function signedBy(authorization) {
  try {
    const payload = String(authorization ?? '').replace(/^Bearer\s+/i, '').split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).iss ?? null;
  } catch {
    return null;
  }
}

// A webhook request from a region's LiveKit: `body` is the raw text, `authorization` its
// signature. Resolves to { event, regionId }; rejects unless it's signed with a region's API key.
async function verifyWebhook(body, authorization) {
  const region = voiceRegions.byApiKey(signedBy(authorization));
  const connection = voiceRegions.connectionOf(region);
  if (!connection) throw new Error('Not signed by a voice region');
  const event = await new WebhookReceiver(connection.apiKey, connection.apiSecret).receive(body, authorization);
  return { event, regionId: region.id };
}

async function handleWebhookEvent(event, regionId) {
  // DM call rooms are calls.js's.
  if (event.room?.name?.startsWith('call-')) {
    await require('./calls').handleWebhookEvent(event, regionId);
    return;
  }
  const channelId = channelIdOfRoom(event.room?.name);
  if (channelId == null) return;
  if (event.event === 'participant_joined') await participantJoined(channelId, event.participant, regionId);
  else if (event.event === 'participant_left') await participantLeft(channelId, event.participant);
  else if (event.event === 'track_published') await trackChanged(channelId, event.participant, event.track, true);
  else if (event.event === 'track_unpublished') await trackChanged(channelId, event.participant, event.track, false);
  else if (event.event === 'room_finished') await roomFinished(channelId, regionId);
}

// After anything in the guild changed (roles, overrides, channels, members): whoever may no
// longer be in their voice channel is disconnected, and Speak, Video and Listen are given or
// taken away (LiveKit stops a camera or screen share, or what they hear, once no longer allowed).
async function enforceGuild(guildId) {
  for (const state of [...states.values()]) {
    if (state.guildId !== guildId) continue;
    const access = await voiceAccess(state.channelId, state.userId);
    if (!access) {
      await disconnect(state.userId);
      continue;
    }
    const canSpeak = has(access.permissions, PERMISSIONS.SPEAK);
    const canStream = canStreamWith(access);
    const canListen = has(access.permissions, PERMISSIONS.LISTEN);
    if (canSpeak !== state.canSpeak || canStream !== state.canStream || canListen !== state.canListen) {
      const listenChanged = canListen !== state.canListen;
      state.canSpeak = canSpeak;
      state.canStream = canStream;
      state.canListen = canListen;
      // Whether someone can hear is shown (bots that listen are marked).
      if (listenChanged) await announce(state.guildId, state.channelId, state.userId, state);
      serviceFor(state.regionId)?.updateParticipant(roomName(state.channelId), String(state.userId), {
        permission: publishPermission(canSpeak, canStream, canListen),
      }).catch((err) => logLiveKitError('changing Speak, Video or Listen', err));
    }
  }
}

// When the API starts: who's in which room right now (joins and leaves while it was down
// never reached it).
async function restoreFromLiveKit() {
  for (const region of voiceRegions.all()) await restoreRegion(region);
}

async function restoreRegion(region) {
  const service = serviceFor(region.id);
  if (!service) return;
  try {
    for (const room of await service.listRooms()) {
      const channelId = channelIdOfRoom(room.name);
      if (channelId == null) continue;
      for (const participant of await service.listParticipants(room.name)) {
        const userId = Number(participant.identity);
        const access = await voiceAccess(channelId, userId);
        if (!access || voiceRegions.forChannel(access.channel)?.id !== region.id) continue;
        states.set(userId, {
          userId,
          username: participant.name || String(userId),
          guildId: access.channel.guild_id,
          channelId,
          regionId: region.id,
          sid: participant.sid,
          selfMute: participant.attributes?.selfMute === '1',
          selfDeaf: participant.attributes?.selfDeaf === '1',
          streaming: sharesScreen(participant),
          video: showsCamera(participant),
          canSpeak: has(access.permissions, PERMISSIONS.SPEAK),
          canStream: canStreamWith(access),
          canListen: has(access.permissions, PERMISSIONS.LISTEN),
          isBot: Boolean(access.member?.isBot),
          joinedAt: Number(participant.joinedAt ?? 0) * 1000 || Date.now(),
        });
      }
    }
  } catch (err) {
    console.error(`LiveKit: could not list who is in voice in region ${region.id}:`, err?.message ?? err);
  }
}

// Voice channel `channel`'s settings changed (routes/guilds.js updateChannel): the people in it
// send at the new bitrate, and if its region changed (`moved`), their apps join it again
// there (the old sessions end when the new ones start, participantJoined). Bots aren't told:
// they're taken out, to join again with a new token.
async function channelSettingsChanged(channel, { moved = false } = {}) {
  for (const state of [...states.values()]) {
    if (state.channelId !== channel.id) continue;
    if (moved && state.isBot) {
      await disconnect(state.userId);
      continue;
    }
    sendToUserSockets(state.userId, {
      type: 'guild_voice_channel', guildId: channel.guild_id, channelId: channel.id, bitrate: channel.bitrate ?? DEFAULT_BITRATE, moved,
    });
  }
}

// The regions changed (Settings → Admin): voice channels whose region is now another (their
// region removed, or the default changed under Automatic, or a region's server changed:
// `changedRegionId`) are moved there.
async function regionsChanged({ changedRegionId = null, removedRegionId = null } = {}) {
  const db = require('./db');
  const channels = new Map();
  for (const state of states.values()) {
    if (channels.has(state.channelId)) continue;
    const channel = await db.get('SELECT id, guild_id, bitrate, rtc_region FROM guild_channels WHERE id = ?', [state.channelId]);
    if (channel) channels.set(channel.id, channel);
  }
  for (const channel of channels.values()) {
    const regionId = voiceRegions.forChannel(channel)?.id;
    const moved = [...states.values()].some((s) => s.channelId === channel.id && (s.regionId !== regionId || s.regionId === changedRegionId));
    if (moved) await channelSettingsChanged(channel, { moved: true });
  }
  if (removedRegionId != null) {
    // Whoever hasn't moved within a minute is taken out of the old server; then it's forgotten.
    setTimeout(async () => {
      for (const state of [...states.values()]) if (state.regionId === removedRegionId) await disconnect(state.userId);
      forgetRegion(removedRegionId);
    }, 60 * 1000).unref();
  }
}

// Everyone in voice in the guild is disconnected (the guild is being deleted), and its Watch
// Together parties end.
async function disconnectGuild(guildId) {
  require('./watchParty').dropGuild(guildId);
  for (const state of [...states.values()]) {
    if (state.guildId !== guildId) continue;
    states.delete(state.userId);
    serviceFor(state.regionId)?.removeParticipant(roomName(state.channelId), String(state.userId))
      .catch((err) => logLiveKitError('removing a participant', err));
  }
}

module.exports = {
  livekit,
  states,
  roomName,
  membersOf,
  allStates,
  guildVoiceFor,
  joinToken,
  roomToken,
  streamLimit,
  logLiveKitError,
  setSelfState,
  setWatching,
  voiceAccess,
  disconnect,
  verifyWebhook,
  handleWebhookEvent,
  enforceGuild,
  disconnectGuild,
  restoreFromLiveKit,
  serviceFor,
  channelSettingsChanged,
  regionsChanged,
  MIN_BITRATE,
  MAX_BITRATE,
  DEFAULT_BITRATE,
  MAX_USER_LIMIT,
};
