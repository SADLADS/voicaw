import { fetchVoiceToken, leaveVoiceChannel, saveVoiceState } from '../services/voiceService';
import { createVoiceChain } from './voiceChain';

// This device's voice connection (one at a time, like Discord): joining a voice channel,
// the microphone, mute and deafen, and who's talking. The audio goes through a LiveKit server
// (livekit-client, loaded on first join); the API hands out the token for each join and keeps
// track of who's in which channel (server/voice.js), which everyone sees in the sidebar.
//
// Components read it through hooks/useVoice.js (getVoiceSnapshot / onVoiceChange).
// Mute and deafen are remembered on this device, like Discord. Muted, the microphone is
// released (the browser's recording indicator goes off); deafened, you also can't be heard.

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
let snapshot = {
  status: 'idle',
  guildId: null,
  channelId: null,
  ...loadPrefs(),
  canSpeak: true,
  speaking: [],
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
  newRoom
    .on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== Track.Kind.Audio) return;
      const element = track.attach();
      element.muted = snapshot.selfDeaf;
      audioElements().appendChild(element);
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => {
      for (const element of track.detach()) element.remove();
    })
    .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      if (!stale()) update({ speaking: speakers.map((p) => p.identity) });
    })
    .on(RoomEvent.Reconnecting, () => {
      if (!stale()) update({ status: 'reconnecting' });
    })
    .on(RoomEvent.Reconnected, () => {
      if (!stale()) update({ status: 'connected' });
    })
    .on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (!stale()) update({ audioBlocked: !newRoom.canPlaybackAudio });
    })
    .on(RoomEvent.ParticipantPermissionsChanged, (_previous, participant) => {
      if (stale() || participant !== newRoom.localParticipant) return;
      update({ canSpeak: participant.permissions?.canPublish ?? false });
      applyMicrophone();
    })
    .on(RoomEvent.Disconnected, (reason) => {
      if (stale()) return;
      attempt++;
      teardown();
      update({ status: 'idle', guildId: null, channelId: null, speaking: [], error: disconnectMessage(reason) });
    });
}

// Joins a voice channel (leaving any other). Must be called from a click or tap: browsers only
// start playing sound after one.
export async function joinVoice(guildId, channelId) {
  guildId = Number(guildId);
  channelId = Number(channelId);
  if (snapshot.channelId === channelId && snapshot.status !== 'idle') return;
  const current = ++attempt;
  await teardown();
  update({ status: 'connecting', guildId, channelId, speaking: [], error: null, micError: null, audioBlocked: false });
  try {
    livekit ??= await import('livekit-client');
    const { url, token } = await fetchVoiceToken(guildId, channelId, prefs());
    if (current !== attempt) return;
    const newRoom = new livekit.Room({
      stopMicTrackOnMute: true,
      audioCaptureDefaults: CAPTURE,
      publishDefaults: { dtx: true, red: true },
    });
    room = newRoom;
    watch(newRoom, current);
    await newRoom.connect(url, token);
    if (current !== attempt) return;
    await newRoom.startAudio().catch(() => {});
    update({
      status: 'connected',
      canSpeak: newRoom.localParticipant.permissions?.canPublish ?? true,
      audioBlocked: !newRoom.canPlaybackAudio,
    });
    await applyMicrophone();
  } catch (err) {
    if (current !== attempt) return;
    console.warn('Could not join voice', err);
    attempt++;
    await teardown();
    update({ status: 'idle', guildId: null, channelId: null, error: errorMessage(err, 'Could not connect to voice.') });
  }
}

export async function leaveVoice() {
  const wasIn = snapshot.status !== 'idle';
  attempt++;
  await teardown();
  update({ status: 'idle', guildId: null, channelId: null, speaking: [], error: null, micError: null, audioBlocked: false });
  // In case LiveKit couldn't be told (lost connection): the API takes us out too.
  if (wasIn) await leaveVoiceChannel().catch(() => {});
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
  if (snapshot.status !== 'idle') {
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
