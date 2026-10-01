import { fetchVoiceToken, leaveVoiceChannel, saveVoiceState } from '../services/voiceService';
import { createVoiceChain } from './voiceChain';

// This device's voice connection (one at a time, like Discord): a voice channel or a DM
// call, the microphone, mute and deafen, and who's talking. The audio goes through a LiveKit
// server (livekit-client, loaded on first join); the API hands out the token for each join and
// keeps track of who's in which channel (server/voice.js), which everyone sees in the sidebar.
// DM calls (voice/callClient.js does the ringing) are end-to-end encrypted with LiveKit's E2EE,
// using the call's key.
//
// Components read it through hooks/useVoice.js (getVoiceSnapshot / onVoiceChange).
// Mute and deafen are remembered on this device, like Discord. Muted, the microphone is
// released (the browser's recording indicator goes off); deafened, you also can't be heard.
//
// Screen sharing (voice channels, with Video): your screen (and its sound, where the browser
// shares it) goes out as LiveKit screen-share tracks. Others only receive a stream while they
// watch it (subscriptions are ours to decide, not automatic), so a stream nobody watches
// costs nobody's download.

const PREFS_KEY = 'voicePrefs';

// What the browser does to the microphone before our own chain (voiceChain.js):
// voiceIsolation is Chrome's stronger noise suppression, where it has it.
const CAPTURE = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceIsolation: true };

function loadPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') ?? {};
    return { selfMute: prefs.selfMute === true, selfDeaf: prefs.selfDeaf === true };
  } catch {
    return { selfMute: false, selfDeaf: false };
  }
}

// status: 'idle' | 'connecting' | 'connected' | 'reconnecting'. `speaking` holds the user ids
// (strings) talking right now. `error` is why joining failed or the connection ended;
// `micError` why the microphone can't be used (you stay in, listening). `audioBlocked`: the
// browser wants a click before it plays sound.
// In a voice channel: `guildId`, `channelId`; in a call: `callId`. `muted` holds the others
// whose microphone is off (in a call, where the API doesn't track it).
// `identity`: our own user id (a string) in the room.
// Screen sharing: `canStream` (Video), `streaming` (yours is live), `streams` (the user ids,
// strings, sharing in this room, you included), `watching` (whose stream this device shows,
// or null), `watchingReady` (its video has arrived), `streamError`.
const NOT_IN_VOICE = {
  status: 'idle',
  guildId: null,
  channelId: null,
  callId: null,
  speaking: [],
  muted: [],
  identity: null,
  streaming: false,
  streams: [],
  watching: null,
  watchingReady: false,
  streamError: null,
};
let snapshot = {
  ...NOT_IN_VOICE,
  ...loadPrefs(),
  canSpeak: true,
  canStream: false,
  error: null,
  micError: null,
  audioBlocked: false,
};
const listeners = new Set();

function update(changes) {
  snapshot = { ...snapshot, ...changes };
  for (const listener of listeners) listener();
}

export const getVoiceSnapshot = () => snapshot;

export function onVoiceChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let livekit = null; // the livekit-client module
let room = null;
let e2eeWorker = null;
// Bumped by every join and leave, so a join that's overtaken stops where it is.
let attempt = 0;
let audioContainer = null;

// Remote audio plays through <audio> elements kept here, out of sight.
function audioElements() {
  if (!audioContainer) {
    audioContainer = document.createElement('div');
    audioContainer.hidden = true;
    audioContainer.dataset.voiceAudio = '';
    document.body.appendChild(audioContainer);
  }
  return audioContainer;
}

// What this device has asked LiveKit for, per track publication (see syncSubscriptions).
let subscriptions = new WeakMap();

const isScreenSource = (source) =>
  source === livekit.Track.Source.ScreenShare || source === livekit.Track.Source.ScreenShareAudio;

// Microphones always; a screen share and its sound only while we watch that person.
function syncSubscriptions() {
  if (!room) return;
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      const wanted = !isScreenSource(publication.source) || snapshot.watching === participant.identity;
      if (subscriptions.get(publication) === wanted) continue;
      subscriptions.set(publication, wanted);
      publication.setSubscribed(wanted);
    }
  }
}

// The video track of `identity`'s screen share, once there (yours is local).
function screenTrack(identity) {
  if (!room || identity == null) return null;
  const participant = identity === room.localParticipant.identity
    ? room.localParticipant
    : room.remoteParticipants.get(identity);
  return participant?.getTrackPublication(livekit.Track.Source.ScreenShare)?.track ?? null;
}

// Who's sharing, and whether the one we watch has arrived; stops watching a stream that ended.
function updateStreams() {
  if (!room) return;
  const { Track } = livekit;
  const participants = [room.localParticipant, ...room.remoteParticipants.values()];
  const streams = participants
    .filter((p) => p.getTrackPublication(Track.Source.ScreenShare))
    .map((p) => p.identity);
  const watching = streams.includes(snapshot.watching) ? snapshot.watching : null;
  update({
    streams,
    streaming: room.localParticipant.isScreenShareEnabled,
    watching,
    watchingReady: Boolean(screenTrack(watching)),
  });
  syncSubscriptions();
}

function errorMessage(err, fallback) {
  return err?.response?.data?.error ?? fallback;
}

function micErrorMessage(err) {
  if (err?.name === 'NotAllowedError') return 'Microphone access is blocked. Allow it in your browser to talk.';
  if (err?.name === 'NotFoundError') return 'No microphone found.';
  return 'Could not use the microphone.';
}

function disconnectMessage(reason) {
  const { DisconnectReason } = livekit;
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED: return null;
    case DisconnectReason.DUPLICATE_IDENTITY: return 'You joined this channel from another device.';
    case DisconnectReason.PARTICIPANT_REMOVED: return 'You were disconnected from voice.';
    case DisconnectReason.ROOM_DELETED: return 'The voice channel was closed.';
    default: return 'Lost the connection to voice.';
  }
}

async function teardown() {
  const old = room;
  room = null;
  if (old) {
    old.removeAllListeners();
    await old.disconnect().catch(() => {});
  }
  e2eeWorker?.terminate();
  e2eeWorker = null;
  subscriptions = new WeakMap();
  if (audioContainer) audioContainer.replaceChildren();
}

// Turns the microphone on or off to match mute, deafen and Speak.
async function applyMicrophone() {
  const current = room;
  if (!current || snapshot.status === 'idle' || snapshot.status === 'connecting') return;
  const wanted = snapshot.canSpeak && !snapshot.selfMute && !snapshot.selfDeaf;
  const participant = current.localParticipant;
  try {
    if (wanted) {
      const publication = await participant.setMicrophoneEnabled(true, CAPTURE);
      // Our chain goes on once per track (LiveKit keeps it through mute and mic changes). It
      // can't be passed with the capture options: LiveKit applies those before the track has
      // the AudioContext a processor needs.
      const track = publication?.audioTrack;
      if (track && !track.getProcessor()) await track.setProcessor(createVoiceChain());
      if (room === current) update({ micError: null });
    } else if (participant.isMicrophoneEnabled) {
      await participant.setMicrophoneEnabled(false);
    }
  } catch (err) {
    if (room !== current) return;
    // No microphone, or not allowed: stay in the channel, muted.
    console.warn('Microphone unavailable', err);
    setPrefs({ selfMute: true }, { micError: micErrorMessage(err) });
  }
}

function applyDeafen() {
  if (!audioContainer) return;
  for (const element of audioContainer.querySelectorAll('audio')) element.muted = snapshot.selfDeaf;
}

function watch(newRoom, current) {
  const { RoomEvent, Track } = livekit;
  const stale = () => current !== attempt;
  const updateMuted = () => {
    if (stale()) return;
    const muted = [...newRoom.remoteParticipants.values()].filter((p) => !p.isMicrophoneEnabled).map((p) => p.identity);
    update({ muted });
  };
  const updateTracks = () => {
    if (stale()) return;
    updateMuted();
    updateStreams();
  };
  newRoom
    .on(RoomEvent.ParticipantConnected, updateTracks)
    .on(RoomEvent.ParticipantDisconnected, updateTracks)
    .on(RoomEvent.TrackPublished, updateTracks)
    .on(RoomEvent.TrackUnpublished, updateTracks)
    .on(RoomEvent.LocalTrackPublished, updateTracks)
    // Also when the browser's own "Stop sharing" ended it.
    .on(RoomEvent.LocalTrackUnpublished, updateTracks)
    .on(RoomEvent.TrackMuted, updateMuted)
    .on(RoomEvent.TrackUnmuted, updateMuted)
    .on(RoomEvent.TrackSubscribed, (track) => {
      updateTracks();
      // Video (a screen share) is drawn by whoever shows it (attachStream).
      if (track.kind !== Track.Kind.Audio) return;
      const element = track.attach();
      element.muted = snapshot.selfDeaf;
      audioElements().appendChild(element);
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) for (const element of track.detach()) element.remove();
      updateTracks();
    })
    .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      if (!stale()) update({ speaking: speakers.map((p) => p.identity) });
    })
    .on(RoomEvent.Reconnecting, () => {
      if (!stale()) update({ status: 'reconnecting' });
    })
    .on(RoomEvent.Reconnected, () => {
      if (stale()) return;
      update({ status: 'connected' });
      updateTracks();
    })
    .on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (!stale()) update({ audioBlocked: !newRoom.canPlaybackAudio });
    })
    .on(RoomEvent.ParticipantPermissionsChanged, (_previous, participant) => {
      if (stale() || participant !== newRoom.localParticipant) return;
      update(publishRights(participant));
      applyMicrophone();
      // Video taken away: LiveKit has stopped the stream; let go of the capture too.
      if (!snapshot.canStream && participant.isScreenShareEnabled) stopScreenShare();
    })
    .on(RoomEvent.Disconnected, (reason) => {
      if (stale()) return;
      attempt++;
      teardown();
      // A call's end is callClient.js's to explain (the server closes its room on hang-up).
      update({ ...NOT_IN_VOICE, error: snapshot.callId ? null : disconnectMessage(reason) });
    });
}

// What our token lets us publish (LiveKit's participant permissions).
function publishRights(participant) {
  const permissions = participant.permissions;
  if (!permissions) return { canSpeak: true, canStream: false };
  const sources = permissions.canPublishSources ?? [];
  const allows = (source) => permissions.canPublish && (sources.length === 0 || sources.includes(source));
  // TrackSource numbers, as LiveKit's protocol has them: 2 microphone, 3 screen share.
  return { canSpeak: allows(2), canStream: allows(3) };
}

// LiveKit's end-to-end encryption with `key` (32 bytes): every audio frame is encrypted in a
// worker before it leaves, so LiveKit only forwards ciphertext.
async function e2eeOptions(key) {
  if (!livekit.isE2EESupported()) throw new Error("This browser can't make encrypted calls.");
  const keyProvider = new livekit.ExternalE2EEKeyProvider();
  await keyProvider.setKey(key.slice().buffer);
  e2eeWorker = new Worker(new URL('livekit-client/e2ee-worker', import.meta.url), { type: 'module' });
  return { keyProvider, worker: e2eeWorker };
}

// Connects to a room: `target` is what the snapshot says we're in, `getToken()` resolves to
// { url, token }, `e2eeKey` (calls) turns on end-to-end encryption.
async function connect(target, getToken, e2eeKey) {
  const current = ++attempt;
  await teardown();
  update({ ...NOT_IN_VOICE, ...target, status: 'connecting', error: null, micError: null, audioBlocked: false });
  try {
    livekit ??= await import('livekit-client');
    const { url, token } = await getToken();
    if (current !== attempt) return;
    const e2ee = e2eeKey ? await e2eeOptions(e2eeKey) : undefined;
    const newRoom = new livekit.Room({
      stopMicTrackOnMute: true,
      audioCaptureDefaults: CAPTURE,
      publishDefaults: { dtx: true, red: true },
      e2ee,
    });
    room = newRoom;
    watch(newRoom, current);
    if (e2ee) await newRoom.setE2EEEnabled(true);
    // Subscriptions are ours (syncSubscriptions): screen shares only while watched.
    await newRoom.connect(url, token, { autoSubscribe: false });
    if (current !== attempt) return;
    await newRoom.startAudio().catch(() => {});
    update({
      status: 'connected',
      identity: newRoom.localParticipant.identity,
      ...publishRights(newRoom.localParticipant),
      audioBlocked: !newRoom.canPlaybackAudio,
    });
    updateStreams();
    await applyMicrophone();
  } catch (err) {
    if (current !== attempt) return;
    console.warn('Could not connect to voice', err);
    attempt++;
    await teardown();
    update({ ...NOT_IN_VOICE, error: errorMessage(err, err?.message?.startsWith('This browser') ? err.message : 'Could not connect to voice.') });
  }
}

// Joins a voice channel (leaving any other, or a call). Must be called from a click or tap:
// browsers only start playing sound after one.
export async function joinVoice(guildId, channelId) {
  guildId = Number(guildId);
  channelId = Number(channelId);
  if (snapshot.channelId === channelId && snapshot.status !== 'idle') return;
  await connect({ guildId, channelId }, () => fetchVoiceToken(guildId, channelId, prefs()));
}

// Joins a DM call's room (callClient.js has the token and the call's key).
export async function joinCall({ callId, url, token, key }) {
  await connect({ callId }, async () => ({ url, token }), key);
}

// Leaves the voice channel or call (hanging up a call is callClient.js's hangUp).
export async function leaveVoice() {
  const inChannel = snapshot.status !== 'idle' && snapshot.channelId != null;
  attempt++;
  await teardown();
  update({ ...NOT_IN_VOICE, error: null, micError: null, audioBlocked: false });
  // In case LiveKit couldn't be told (lost connection): the API takes us out too.
  if (inChannel) await leaveVoiceChannel().catch(() => {});
}

// Shows `error` in the voice bar (e.g. why a call couldn't start).
export function setVoiceError(error) {
  update({ error });
}

const prefs = () => ({ selfMute: snapshot.selfMute, selfDeaf: snapshot.selfDeaf });

function setPrefs(changes, extra = {}) {
  update({ ...changes, ...extra });
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs()));
  } catch {
    // Not remembered, then.
  }
  applyDeafen();
  applyMicrophone();
  if (snapshot.status !== 'idle' && snapshot.channelId != null) {
    saveVoiceState(prefs()).catch((err) => console.warn('Could not save mute/deafen', err));
  }
}

// Unmuting while deafened undeafens too (like Discord).
export function setSelfMute(selfMute) {
  setPrefs(selfMute || !snapshot.selfDeaf ? { selfMute } : { selfMute, selfDeaf: false }, { micError: null });
}

export function setSelfDeaf(selfDeaf) {
  setPrefs({ selfDeaf });
}

// After the browser refused to play sound without a click: call from one.
export function resumeAudio() {
  room?.startAudio().then(() => update({ audioBlocked: false })).catch(() => {});
}

export function clearVoiceError() {
  update({ error: null });
}

// Shares your screen (a voice channel, with Video). Must be called from a click: the browser
// asks which screen, window or tab, and whether to share its sound. Your own stream is shown
// at once, like Discord's preview.
export async function startScreenShare() {
  const current = room;
  if (!current || snapshot.status !== 'connected' || !snapshot.canStream) return;
  update({ streamError: null });
  try {
    await current.localParticipant.setScreenShareEnabled(true, {
      audio: true,
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    });
    if (room !== current) return;
    update({ watching: current.localParticipant.identity });
    updateStreams();
  } catch (err) {
    if (room !== current) return;
    // Cancelling the browser's picker is a NotAllowedError too: nothing to say then.
    const cancelled = err?.name === 'NotAllowedError' || err?.name === 'AbortError';
    if (!cancelled) console.warn('Could not share the screen', err);
    update({ streamError: cancelled ? null : screenErrorMessage(err) });
    updateStreams();
  }
}

function screenErrorMessage(err) {
  if (err?.name === 'NotSupportedError' || !canShareScreen()) return "This browser can't share the screen.";
  return 'Could not share your screen.';
}

export async function stopScreenShare() {
  const current = room;
  if (!current) return;
  await current.localParticipant.setScreenShareEnabled(false).catch(() => {});
  if (room === current) updateStreams();
}

// Can this browser share a screen at all? (Phones' browsers can't; they can still watch.)
export function canShareScreen() {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

// Shows `identity`'s stream on this device (null: stop watching). Only watched streams are
// downloaded.
export function watchStream(identity) {
  const watching = identity == null ? null : String(identity);
  if (watching === snapshot.watching) return;
  update({ watching, watchingReady: Boolean(screenTrack(watching)) });
  syncSubscriptions();
}

// Plays the watched stream in `element` (a <video>); returns a function that stops it.
export function attachStream(identity, element) {
  const track = screenTrack(String(identity));
  if (!track || !element) return () => {};
  track.attach(element);
  return () => track.detach(element);
}

export function clearStreamError() {
  update({ streamError: null });
}
