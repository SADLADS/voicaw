import { fetchVoiceToken, leaveVoiceChannel, saveVoiceState, saveWatching } from '../services/voiceService';
import { onGuildEvent } from '../utils/ws-client';
import { createVoiceChain } from './voiceChain';
import { VOICE_SAMPLE_RATE, voiceProcessingStage } from './noise/noiseStages';
import {
  captureOptions, getAudioSettings, inputGainStage, onAudioSettingsChange, outputSinkId, processingChanged,
} from './audioSettings';
import {
  canBoostVolume, getStreamVolume, getUserVolume, onStreamVolumesChange, onUserVolumesChange, playbackVolume,
} from './userVolumes';
import { CAMERA_PUBLISH, cameraOptions, onVideoSettingsChange } from './videoSettings';
import { clampStream, getStreamSettings, screenShareOptions } from './streamSettings';
import { gameCaptureFailureKey, scaledEncodings, startGameFrames, targetHeight } from './gameCapture';
import { getStreamViewQuality, onStreamViewQualityChange } from './streamViewSettings';
import { createSpeakingMeters, whoIsSpeaking } from './speaking';
import { onPushToTalkChange, pushToTalkStage, startPushToTalkKeys } from './pushToTalk';
import { playSound } from '../sounds/sounds';
import { isMobileDevice } from '../utils/presence';
import {
  joinRefused, REJOIN_FOR_MS, rejoinDelay, shouldRejoin, STALE_AFTER_HIDDEN_MS, TAKE_OVER_AFTER_MS,
} from './rejoin';
import { t } from '../i18n';
import { desktop } from '../utils/desktop';
import { captureStreamSound } from './deviceStreamSound';
import { keepScreenOn } from '../utils/keepScreenOn';

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
// With push to talk (pushToTalk.js) the microphone stays on and its chain sends silence
// until the key is held; mute and deafen still turn it off.
// Sounds, like Discord's: joining (yours and others'), leaving, being disconnected, mute and
// deafen (sounds/). The microphone, speakers and their volumes are the device's voice
// settings (audioSettings.js, Settings → Voice & video), applied as they change, and each
// person's own volume and their stream's (userVolumes.js) too.
//
// Others' voices play through Web Audio (LiveKit's webAudioMix, in our own AudioContext,
// `playback`), each through its own gain, so one person can be turned up past 100%. Not where
// the browser can choose the speakers for a media element but not for an AudioContext
// (Firefox): there they play from the <audio> elements, up to 100%.
//
// Who's talking (`speaking`, the green rings) is measured on this device from the voices
// themselves (speaking.js): ours as sent, everyone else's as received, so the ring keeps up
// with the voice. LiveKit's active speakers (worked out by its server, most of a second late)
// only fill in for voices that can't be measured.
//
// Screen sharing (voice channels, with Video): your screen (and its sound, where the browser
// shares it) goes out as LiveKit screen-share tracks. Others only receive a stream while they
// watch it (subscriptions are ours to decide, not automatic), so a stream nobody watches
// costs nobody's download. Whose stream each device watches goes to the server
// (saveWatching), which sets it as the participant's `watching` attribute, so everyone in the
// room sees who watches a stream (`watchers`): LiveKit never tells anyone who subscribed.
//
// Cameras (voice channels with Video, and every call; end-to-end encrypted in calls like the
// audio): yours goes out as LiveKit's camera track, in three sizes (simulcast). Someone's
// camera is only downloaded while a tile on screen shows it (showCamera), at the size of the
// biggest one (LiveKit's adaptiveStream would do this, but it also pauses every video while
// the page is hidden, which would freeze a stream watched in its pop-out window). One camera
// can be focused (focusCamera), shown big like a watched stream; that's this device's alone,
// nobody is told.
//
// A voice channel connection that's lost (not left, removed or replaced) is joined again
// (rejoin.js): the voice bar says "Reconnecting…" meanwhile. Phones wait until the app is
// visible again (iOS stops a page's microphone and connection in the background).
//
// The microphone goes out at the voice channel's bitrate (its settings; 64 kbps in calls),
// changed live when the channel's is. A channel moved to another voice region (another LiveKit
// server) is joined again there, as after a lost connection (server/voice.js).

const PREFS_KEY = 'voicePrefs';
export const DEFAULT_BITRATE = 64000;
const CONNECT_TIMEOUT_MS = 20 * 1000;

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
// browser wants a click before it plays sound. `micTesting`: the mic test is running, which
// mutes and deafens you (setMicTesting).
// In a voice channel: `guildId`, `channelId`; in a call: `callId`. `participants`: the user
// ids (strings) in the room, you first, then in the order they joined. `muted` holds the others
// whose microphone is off (in a call, where the API doesn't track it).
// `identity`: our own user id (a string) in the room.
// Screen sharing: `canStream` (Video), `streaming` (yours is live), `streams` (the user ids,
// strings, sharing in this room, you included), `watching` (whose stream this device shows,
// or null), `watchingReady` (its video has arrived), `watchers` (identity of someone sharing
// -> the others watching their stream, never you, in the order they joined: { id, username },
// the username from their token), `streamError`, `streamLimit` (the
// server's cap on screen share quality, { resolution, frameRate }; null: none, see streamSettings.js).
// Cameras: `canCamera` (Video in a channel; always in a call), `cameraOn` (yours), `cameras`
// (the user ids, strings, whose camera is on in this room, you included; not yours while it's
// paused, see pauseCameraWhileHidden), `cameraError`,
// `cameraFacing` (null: the camera chosen in Settings; 'user' or 'environment' once a phone's
// camera was switched, see switchCamera), `focusedCamera` (the user id, a string, of the camera
// shown big on this device, or null; it stays while that camera is paused, see stage.js).
const NOT_IN_VOICE = {
  status: 'idle',
  guildId: null,
  channelId: null,
  callId: null,
  speaking: [],
  participants: [],
  muted: [],
  identity: null,
  streaming: false,
  streams: [],
  watching: null,
  watchingReady: false,
  watchers: {},
  streamError: null,
  streamLimit: null,
  cameraOn: false,
  cameras: [],
  cameraError: null,
  cameraFacing: null,
  focusedCamera: null,
};
let snapshot = {
  ...NOT_IN_VOICE,
  ...loadPrefs(),
  canSpeak: true,
  micTesting: false,
  canStream: false,
  canCamera: false,
  error: null,
  micError: null,
  audioBlocked: false,
};
const listeners = new Set();

function update(changes) {
  snapshot = { ...snapshot, ...changes };
  for (const listener of listeners) listener();
  reportWatching();
}

export const getVoiceSnapshot = () => snapshot;

export function onVoiceChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let livekit = null; // the livekit-client module
let room = null;
// Rooms that finished joining: a Disconnected before that is a failed join, which connect()
// handles (LiveKit emits one for it too).
const joinedRooms = new WeakSet();
let e2eeWorker = null;
// Bumped by every join and leave, so a join that's overtaken stops where it is.
let attempt = 0;
let audioContainer = null;
// Each remote audio track's <audio> element. (By the time a track is unsubscribed LiveKit may
// have detached it already, so `detach()` can't be relied on to find it.)
let audioElementsByTrack = new Map();
// The AudioContext others' voices play through (webAudioMix), or null (media elements).
let playback = null;
// Who's talking: the meters (speaking.js), the AudioContext they measure in where voices don't
// play through `playback`, and LiveKit's active speakers (user ids).
let meters = null;
let meterContext = null;
let liveKitSpeakers = [];

function newPlaybackContext() {
  if (!canBoostVolume()) return null;
  try {
    const context = new AudioContext({ latencyHint: 'interactive' });
    // LiveKit sets the speakers on it without waiting or catching, and may do so after we've
    // closed it (a rejoin): that would be an uncaught error.
    if (context.setSinkId) {
      const setSinkId = context.setSinkId.bind(context);
      context.setSinkId = (id) => (context.state === 'closed'
        ? Promise.resolve()
        : setSinkId(id).catch((err) => console.warn('Could not choose speakers', err)));
    }
    const sink = outputSinkId();
    if (sink && context.setSinkId) context.setSinkId(sink);
    return context;
  } catch {
    return null;
  }
}

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

// Microphones always; a screen share and its sound only while we watch that person; a camera
// only while it's shown on screen, somewhere that isn't hidden (a pop-out window still shows
// while the page is hidden).
function wants(participant, publication) {
  if (isScreenSource(publication.source)) return snapshot.watching === participant.identity;
  if (publication.source === livekit.Track.Source.Camera) {
    return [...(cameraViews.get(participant.identity) ?? [])].some(onVisiblePage);
  }
  return true;
}

function syncSubscriptions() {
  if (!room) return;
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      const wanted = wants(participant, publication);
      if (subscriptions.get(publication) === wanted) continue;
      subscriptions.set(publication, wanted);
      publication.setSubscribed(wanted);
      if (wanted && publication.source === livekit.Track.Source.Camera) sizeCamera(participant.identity);
    }
  }
  applyStreamQuality();
}

// Asks LiveKit for the copy of the watched stream this device's Stream quality picks
// (streamViewSettings.js): at most the full size ('auto', LiveKit's server still moving to the
// half-size copy while the connection can't keep up) or always the half-size one ('low').
function applyStreamQuality() {
  if (!room || snapshot.watching == null) return;
  const publication = room.remoteParticipants.get(snapshot.watching)?.getTrackPublication(livekit.Track.Source.ScreenShare);
  // LiveKit only takes it for a publication we've asked for.
  if (!publication?.setVideoQuality || !subscriptions.get(publication)) return;
  const { VideoQuality } = livekit;
  publication.setVideoQuality(getStreamViewQuality() === 'low' ? VideoQuality.LOW : VideoQuality.HIGH);
}

// Cameras on screen: identity -> the <video> elements showing it (showCamera).
const cameraViews = new Map();
let cameraResizes = null;

const onVisiblePage = (element) => !(element.ownerDocument ?? (typeof document !== 'undefined' ? document : null))?.hidden;

const isLocal = (identity) => room != null && identity === room.localParticipant.identity;

function cameraPublication(identity) {
  if (!room || identity == null) return null;
  const participant = isLocal(identity) ? room.localParticipant : room.remoteParticipants.get(identity);
  return participant?.getTrackPublication(livekit.Track.Source.Camera) ?? null;
}

// Data saver (streamViewSettings.js) never asks for more of a camera than its middle layer.
const DATA_SAVER_CAMERA = { width: 640, height: 360 };

// Asks LiveKit for the size of the biggest tile showing `identity`'s camera (it picks the
// simulcast layer from it).
function sizeCamera(identity) {
  const elements = cameraViews.get(identity);
  const publication = cameraPublication(identity);
  if (!elements || !publication || isLocal(identity) || !publication.setVideoDimensions) return;
  const density = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
  let width = 0;
  let height = 0;
  for (const element of elements) {
    width = Math.max(width, Math.round(element.clientWidth * density));
    height = Math.max(height, Math.round(element.clientHeight * density));
  }
  if (width <= 0 || height <= 0) return;
  publication.setVideoDimensions(getStreamViewQuality() === 'low'
    ? { width: Math.min(width, DATA_SAVER_CAMERA.width), height: Math.min(height, DATA_SAVER_CAMERA.height) }
    : { width, height });
}

// Plays the camera's track (when there is one) in every element showing it.
function attachCamera(identity) {
  const track = cameraPublication(identity)?.track;
  if (!track) return;
  for (const element of cameraViews.get(identity) ?? []) {
    if (!track.attachedElements.includes(element)) track.attach(element);
  }
}

// A camera that stops being shown is let go a moment later: it may only be moving (a tile to the
// stage, the page to the corner), where it should carry on without a blink.
const CAMERA_MOVE_MS = 300;
let syncTimer = null;

function syncSubscriptionsSoon() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncSubscriptions, CAMERA_MOVE_MS);
}

// Shows `identity`'s camera (yours too) in `element`, a <video>: it's downloaded while at least
// one element shows it. Returns a function that stops showing it there.
export function showCamera(identity, element) {
  if (identity == null || !element) return () => {};
  const key = String(identity);
  if (!cameraViews.has(key)) cameraViews.set(key, new Set());
  cameraViews.get(key).add(element);
  if (typeof ResizeObserver !== 'undefined') {
    cameraResizes ??= new ResizeObserver(() => {
      for (const id of cameraViews.keys()) sizeCamera(id);
    });
    cameraResizes.observe(element);
  }
  // A pop-out window has its own visibility (the page's is listened to below).
  const otherPage = typeof document !== 'undefined' && element.ownerDocument && element.ownerDocument !== document ? element.ownerDocument : null;
  otherPage?.addEventListener('visibilitychange', syncSubscriptions);
  if (room) {
    attachCamera(key);
    syncSubscriptions();
    sizeCamera(key);
  }
  return () => {
    otherPage?.removeEventListener('visibilitychange', syncSubscriptions);
    cameraResizes?.unobserve(element);
    if (room) cameraPublication(key)?.track?.detach(element);
    const elements = cameraViews.get(key);
    elements?.delete(element);
    if (elements?.size === 0) cameraViews.delete(key);
    syncSubscriptionsSoon();
  };
}

// Whose cameras are on, and every shown camera playing.
function updateCameras() {
  if (!room) return;
  const participants = [room.localParticipant, ...room.remoteParticipants.values()];
  const cameras = participants
    .filter((p) => {
      const publication = p.getTrackPublication(livekit.Track.Source.Camera);
      return publication && !publication.isMuted;
    })
    .map((p) => p.identity);
  // Yours is on while it's published, paused (muted while the page is hidden) or not.
  const cameraOn = Boolean(room.localParticipant.getTrackPublication(livekit.Track.Source.Camera)?.track);
  // A focused camera that's gone (turned off, or they left) ends the focus; one that's only
  // paused doesn't: it comes back.
  const focusedCamera = cameraPublication(snapshot.focusedCamera) ? snapshot.focusedCamera : null;
  update({ cameras, cameraOn, focusedCamera });
  for (const identity of cameraViews.keys()) attachCamera(identity);
  syncScreenOn();
}

// While your camera is on and the page is shown, the screen is kept on (keepScreenOn), so a
// phone doesn't time out and go to sleep in the middle of a video, as video calls do.
let releaseScreen = null;

function syncScreenOn() {
  const keep = room != null && snapshot.cameraOn && !(typeof document !== 'undefined' && document.hidden);
  if (keep && !releaseScreen) {
    releaseScreen = keepScreenOn();
  } else if (!keep && releaseScreen) {
    releaseScreen();
    releaseScreen = null;
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

// Who watches each live stream in `streams`, from the others' `watching` attributes (set by
// the server, see reportWatching). The same object when nothing changed.
function watchersIn(streams) {
  const watchers = {};
  for (const participant of room.remoteParticipants.values()) {
    const watching = participant.attributes?.watching;
    if (!watching || watching === participant.identity || !streams.includes(watching)) continue;
    (watchers[watching] ??= []).push({ id: participant.identity, username: participant.name ?? '' });
  }
  return JSON.stringify(watchers) === JSON.stringify(snapshot.watchers) ? snapshot.watchers : watchers;
}

function updateWatchers() {
  if (!room) return;
  const watchers = watchersIn(snapshot.streams);
  if (watchers !== snapshot.watchers) update({ watchers });
}

// What we last told the server we watch, for which LiveKit session (a rejoin is a new one,
// without the attribute).
let reported = { sid: null, watching: null };

// Tells the server whose stream this device watches (not our own preview), once per change.
function reportWatching() {
  if (!room || snapshot.status !== 'connected') return;
  const { sid, identity } = room.localParticipant;
  const watching = snapshot.watching != null && snapshot.watching !== identity ? snapshot.watching : null;
  if (reported.sid === sid && reported.watching === watching) return;
  const fresh = reported.sid !== sid;
  reported = { sid, watching };
  // A new session starts watching nobody.
  if (fresh && watching === null) return;
  saveWatching(watching === null ? null : Number(watching)).catch((err) => console.warn('Could not say who you watch', err));
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
    watchers: watchersIn(streams),
  });
  updateCameras();
  syncSubscriptions();
}

function errorMessage(err, fallback) {
  return err?.response?.data?.error ?? fallback;
}

function micErrorMessage(err) {
  if (err?.name === 'NotAllowedError') return t('voice.errors.micBlocked');
  if (err?.name === 'NotFoundError') return t('voice.errors.noMic');
  return t('voice.errors.micFailed');
}

function disconnectMessage(reason) {
  const { DisconnectReason } = livekit;
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED: return null;
    case DisconnectReason.DUPLICATE_IDENTITY: return t('voice.errors.otherDevice');
    case DisconnectReason.PARTICIPANT_REMOVED: return t('voice.errors.removed');
    case DisconnectReason.ROOM_DELETED: return t('voice.errors.closed');
    default: return t('voice.errors.lost');
  }
}

async function teardown() {
  clearTakeOver();
  const old = room;
  room = null;
  endDeviceSound();
  endGameCapture();
  const oldPlayback = playback;
  playback = null;
  if (old) {
    old.removeAllListeners();
    await old.disconnect().catch(() => {});
  }
  e2eeWorker?.terminate();
  e2eeWorker = null;
  meters?.destroy();
  meters = null;
  liveKitSpeakers = [];
  meterContext?.close().catch(() => {});
  meterContext = null;
  subscriptions = new WeakMap();
  volumeGains = new WeakMap();
  audioElementsByTrack = new Map();
  if (audioContainer) audioContainer.replaceChildren();
  oldPlayback?.close().catch(() => {});
  syncScreenOn();
}

// Everything that changes the microphone runs one at a time, each reading the state when its
// turn comes. Run side by side, a mute while an unmute was still capturing and publishing the
// mic found nothing to turn off (LiveKit's isMicrophoneEnabled is false until it's
// published), and the unmute then went live: muted, and still heard.
let microphoneQueue = Promise.resolve();

function queueMicrophone(task) {
  const run = microphoneQueue.then(task, task);
  microphoneQueue = run.catch(() => {});
  return run;
}

// Turns the microphone on or off to match mute, deafen and Speak.
function applyMicrophone() {
  return queueMicrophone(syncMicrophone);
}

async function syncMicrophone() {
  const current = room;
  if (!current || snapshot.status === 'idle' || snapshot.status === 'connecting') return;
  const wanted = snapshot.canSpeak && !snapshot.selfMute && !snapshot.selfDeaf;
  const participant = current.localParticipant;
  try {
    if (wanted) {
      const enabled = await participant.setMicrophoneEnabled(true, captureOptions());
      // Our chain goes on once per track (LiveKit keeps it through mute and mic changes). It
      // can't be passed with the capture options: LiveKit applies those before the track has
      // the AudioContext a processor needs.
      const track = enabled?.audioTrack;
      if (track && !track.getProcessor()) {
        await track.setProcessor(createVoiceChain([inputGainStage, voiceProcessingStage, pushToTalkStage], { sampleRate: VOICE_SAMPLE_RATE }));
      }
      if (track?.mediaStreamTrack && !track.isMuted) track.mediaStreamTrack.enabled = true;
      if (room === current) update({ micError: null });
    } else {
      // Always asked, even with nothing published: LiveKit waits for a publish (or its
      // republish after a reconnect) that's under way, then mutes it.
      await participant.setMicrophoneEnabled(false);
    }
  } catch (err) {
    if (room !== current) return;
    // No microphone, or not allowed: stay in the channel, muted.
    console.warn('Microphone unavailable', err);
    if (beforeMicTest) beforeMicTest.selfMute = true;
    setPrefs({ selfMute: true }, { micError: micErrorMessage(err) });
  } finally {
    // Whatever happened, what's sent matches what's wanted now: LiveKit's mute stops the mic
    // itself, but what goes out is our chain's output, so that's switched off too (an unmute
    // builds a new one).
    const sent = participant.getTrackPublication(livekit.Track.Source.Microphone)?.track?.mediaStreamTrack;
    const allowed = snapshot.canSpeak && !snapshot.selfMute && !snapshot.selfDeaf;
    if (sent && !allowed) sent.enabled = false;
  }
}

// Push to talk: its key works anywhere in the page, and a sound says when it starts and stops
// sending (only when that's heard: in voice, allowed to speak and not muted).
startPushToTalkKeys();
onPushToTalkChange((next, previous) => {
  if (!next.on || next.pressed === previous.pressed) return;
  if (snapshot.status !== 'connected' || !snapshot.canSpeak || snapshot.selfMute || snapshot.selfDeaf) return;
  playSound(next.pressed ? 'pushToTalkOn' : 'pushToTalkOff');
});

// Voice settings changed (Settings → Voice & video): a new microphone or processing means
// capturing it again (or, while muted, dropping the track so unmuting captures it afresh).
onAudioSettingsChange(async (next, previous) => {
  const current = room;
  if (!current) return;
  applyVolumes();
  if (next.outputDeviceId !== previous.outputDeviceId) {
    await current.switchActiveDevice('audiooutput', outputSinkId(next) || 'default')
      .catch((err) => console.warn('Could not switch speakers', err));
  }
  if (next.inputDeviceId === previous.inputDeviceId && !processingChanged(next, previous)) return;
  current.options.audioCaptureDefaults = { ...current.options.audioCaptureDefaults, ...captureOptions(next) };
  // In turn with mute and unmute (applyMicrophone), then put right for whatever they are now.
  await queueMicrophone(async () => {
    if (room !== current) return;
    const participant = current.localParticipant;
    const publication = participant.getTrackPublication(livekit.Track.Source.Microphone);
    const track = publication?.audioTrack;
    if (!track) return;
    try {
      if (participant.isMicrophoneEnabled) await track.restartTrack(captureOptions(next));
      else await participant.unpublishTrack(track);
    } catch (err) {
      console.warn('Could not switch microphone', err);
      if (room === current) update({ micError: micErrorMessage(err) });
    }
  });
  applyMicrophone();
});

// Deafen, the output volume and each person's volume (their stream's volume for a screen
// share's sound), on every voice we receive. (Through
// media elements LiveKit unmutes them when the audio is started again, so this runs after
// that too.)
function volumeOf(identity, source) {
  return playbackVolume({
    selfDeaf: snapshot.selfDeaf,
    outputVolume: getAudioSettings().outputVolume,
    userVolume: source === livekit.Track.Source.ScreenShareAudio ? getStreamVolume(identity) : getUserVolume(identity),
    canBoost: Boolean(playback),
  });
}

// Through Web Audio, each voice's volume (deafen's 0 included) is a gain of our own that LiveKit
// puts in front of its own one (a "plugin"), not LiveKit's: LiveKit only re-applies a volume
// that isn't 0 when it rebuilds a track's graph, and fades towards it without ever reaching 0,
// so a deafened listener could hear people again.
let volumeGains = new WeakMap();

function addVolumeGain(track) {
  if (!playback) return;
  const gain = playback.createGain();
  volumeGains.set(track, gain);
  track.setWebAudioPlugins([gain]);
}

function applyTrackVolume(track, identity, source) {
  const volume = volumeOf(identity, source);
  const gain = volumeGains.get(track);
  if (gain) {
    gain.gain.cancelScheduledValues(0);
    gain.gain.value = volume;
    return;
  }
  track.setVolume(volume);
  // Media elements only (Web Audio keeps them muted itself).
  if (!playback) {
    for (const element of track.attachedElements) element.muted = snapshot.selfDeaf;
  }
}

function applyVolumes() {
  if (!room || !livekit) return;
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.audioTrackPublications.values()) {
      if (publication.track) applyTrackVolume(publication.track, participant.identity, publication.source);
    }
  }
}

onUserVolumesChange(applyVolumes);
onStreamVolumesChange(applyVolumes);

function startMeters(current) {
  if (!playback && typeof AudioContext !== 'undefined') meterContext = new AudioContext({ latencyHint: 'interactive' });
  meters = createSpeakingMeters({ context: () => playback ?? meterContext, onChange: () => updateSpeaking(current) });
}

// Our own voice as it's sent (LiveKit's track is the processed one, after the gate); with the
// microphone off, we aren't talking (without waiting for LiveKit to say so).
function meterMicrophone(newRoom) {
  const participant = newRoom.localParticipant;
  meters?.add('local', participant.identity, () => (participant.isMicrophoneEnabled
    ? participant.getTrackPublication(livekit.Track.Source.Microphone)?.track?.mediaStreamTrack ?? null
    : null), { silentWithoutTrack: true });
}

function updateSpeaking(current) {
  if (current !== attempt) return;
  const speaking = whoIsSpeaking(meters, liveKitSpeakers);
  if (speaking.join() !== snapshot.speaking.join()) update({ speaking });
}

// Who's in the room (`participants`): you, then the others in the order they joined.
const roomParticipants = (r) => [r.localParticipant.identity, ...[...r.remoteParticipants.values()].map((p) => p.identity)];

function watch(newRoom, current) {
  const { RoomEvent, Track } = livekit;
  const stale = () => current !== attempt;
  const updateMuted = () => {
    if (stale()) return;
    const remote = [...newRoom.remoteParticipants.values()];
    const muted = remote.filter((p) => !p.isMicrophoneEnabled).map((p) => p.identity);
    const participants = roomParticipants(newRoom);
    update({ muted, ...(participants.join() !== snapshot.participants.join() ? { participants } : {}) });
  };
  const updateTracks = () => {
    if (stale()) return;
    updateMuted();
    updateStreams();
  };
  newRoom
    .on(RoomEvent.ParticipantConnected, () => {
      if (!stale()) playSound('userJoin');
      updateTracks();
    })
    .on(RoomEvent.ParticipantDisconnected, () => {
      if (!stale()) playSound('userLeave');
      updateTracks();
    })
    .on(RoomEvent.TrackPublished, updateTracks)
    .on(RoomEvent.TrackUnpublished, updateTracks)
    .on(RoomEvent.LocalTrackPublished, (publication) => {
      updateTracks();
      // (Re)published (LiveKit republishes after a reconnect): still as mute and deafen say.
      if (!stale() && publication.source === Track.Source.Microphone) applyMicrophone();
    })
    // Also when the browser's own "Stop sharing" ended it.
    .on(RoomEvent.LocalTrackUnpublished, (publication) => {
      if (publication.source === Track.Source.ScreenShare || publication.source === Track.Source.ScreenShareAudio) endDeviceSound(publication.track);
      if (publication.source === Track.Source.ScreenShare) endGameCapture();
      updateTracks();
    })
    .on(RoomEvent.TrackMuted, updateTracks)
    .on(RoomEvent.TrackUnmuted, updateTracks)
    .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      updateTracks();
      // Video (a screen share or a camera) is drawn by whoever shows it (attachStream, showCamera).
      if (track.kind !== Track.Kind.Audio) return;
      addVolumeGain(track);
      const element = track.attach();
      audioElementsByTrack.set(track, element);
      audioElements().appendChild(element);
      applyTrackVolume(track, participant.identity, publication.source);
      if (publication.source === Track.Source.Microphone) meters?.add(track, participant.identity, () => track.mediaStreamTrack);
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) {
        meters?.remove(track);
        for (const element of track.detach()) element.remove();
        audioElementsByTrack.get(track)?.remove();
        audioElementsByTrack.delete(track);
      }
      updateTracks();
    })
    // Someone started or stopped watching a stream (their `watching`).
    .on(RoomEvent.ParticipantAttributesChanged, () => {
      if (!stale()) updateWatchers();
    })
    .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      if (stale()) return;
      liveKitSpeakers = speakers.map((p) => p.identity);
      updateSpeaking(current);
    })
    // SignalReconnecting: only the signalling connection is being resumed (the audio may
    // still flow), as after a phone's app comes back from the background.
    .on(RoomEvent.Reconnecting, () => reconnecting(current))
    .on(RoomEvent.SignalReconnecting, () => reconnecting(current))
    .on(RoomEvent.Reconnected, () => {
      if (stale()) return;
      clearTakeOver();
      update({ status: 'connected' });
      updateTracks();
      applyMicrophone();
    })
    .on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (stale()) return;
      update({ audioBlocked: !newRoom.canPlaybackAudio });
      applyVolumes();
    })
    .on(RoomEvent.ParticipantPermissionsChanged, (_previous, participant) => {
      if (stale() || participant !== newRoom.localParticipant) return;
      update(publishRights(participant));
      applyMicrophone();
      // Video taken away: LiveKit has stopped the stream; let go of the capture too.
      if (!snapshot.canStream && participant.isScreenShareEnabled) stopScreenShare();
      if (!snapshot.canCamera && snapshot.cameraOn) stopCamera();
    })
    .on(RoomEvent.Disconnected, (reason) => {
      if (stale() || !joinedRooms.has(newRoom)) return;
      attempt++;
      teardown();
      if (snapshot.channelId != null && shouldRejoin(reason)) {
        startRejoin(snapshot.guildId, snapshot.channelId);
        return;
      }
      playSound('disconnect');
      // A call's end is callClient.js's to explain (the server closes its room on hang-up).
      update({ ...NOT_IN_VOICE, error: snapshot.callId ? null : disconnectMessage(reason) });
    });
}

// What our token lets us publish (LiveKit's participant permissions).
function publishRights(participant) {
  const permissions = participant.permissions;
  if (!permissions) return { canSpeak: true, canStream: false, canCamera: false };
  const sources = permissions.canPublishSources ?? [];
  const allows = (source) => permissions.canPublish && (sources.length === 0 || sources.includes(source));
  // TrackSource numbers, as LiveKit's protocol has them: 1 camera, 2 microphone, 3 screen share.
  return { canSpeak: allows(2), canStream: allows(3), canCamera: allows(1) };
}

// LiveKit's end-to-end encryption with `key` (32 bytes): every audio and video frame is encrypted in a
// worker before it leaves, so LiveKit only forwards ciphertext.
async function e2eeOptions(key) {
  if (!livekit.isE2EESupported()) throw new Error(t('voice.errors.noEncryptedCalls'));
  const keyProvider = new livekit.ExternalE2EEKeyProvider();
  await keyProvider.setKey(key.slice().buffer);
  e2eeWorker = new Worker(new URL('livekit-client/e2ee-worker', import.meta.url), { type: 'module' });
  return { keyProvider, worker: e2eeWorker };
}

// Connects to a room: `target` is what the snapshot says we're in, `getToken()` resolves to
// { url, token }, `e2eeKey` (calls) turns on end-to-end encryption. `rejoining`: a rejoin
// attempt, which reports a failure (`{ error }`) instead of showing it; true once connected.
async function connect(target, getToken, e2eeKey, { rejoining = false } = {}) {
  if (!rejoining) {
    cancelRejoin();
    cameraWanted = false;
    cameraFacing = null;
  }
  const current = ++attempt;
  await teardown();
  update({
    ...NOT_IN_VOICE, ...target, status: rejoining ? 'reconnecting' : 'connecting', error: null, micError: null, audioBlocked: false,
  });
  try {
    livekit ??= await import('livekit-client');
    const { url, token, bitrate = DEFAULT_BITRATE, streamLimit = null } = await getToken();
    if (current !== attempt) return;
    const e2ee = e2eeKey ? await e2eeOptions(e2eeKey) : undefined;
    playback = newPlaybackContext();
    startMeters(current);
    const newRoom = new livekit.Room({
      webAudioMix: playback ? { audioContext: playback } : false,
      audioCaptureDefaults: captureOptions(),
      videoCaptureDefaults: cameraOptions(),
      audioOutput: { deviceId: outputSinkId() || 'default' },
      // stopMicTrackOnMute is a publish option (as a Room option LiveKit ignores it).
      publishDefaults: { dtx: true, red: true, stopMicTrackOnMute: true, audioPreset: { maxBitrate: bitrate } },
      e2ee,
    });
    room = newRoom;
    watch(newRoom, current);
    if (e2ee) await newRoom.setE2EEEnabled(true);
    // Subscriptions are ours (syncSubscriptions): screen shares only while watched.
    // (Bounded: when WebSockets are blocked but LiveKit answers HTTP, its connect keeps
    // switching between its two signalling paths and never settles.)
    let timer;
    await Promise.race([
      newRoom.connect(url, token, { autoSubscribe: false }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out connecting to voice')), CONNECT_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    if (current !== attempt) return;
    joinedRooms.add(newRoom);
    await newRoom.startAudio().catch(() => {});
    meterContext?.resume().catch(() => {});
    meterMicrophone(newRoom);
    applyVolumes();
    update({
      status: 'connected',
      streamLimit,
      identity: newRoom.localParticipant.identity,
      participants: roomParticipants(newRoom),
      ...publishRights(newRoom.localParticipant),
      audioBlocked: !newRoom.canPlaybackAudio,
    });
    playSound('userJoin');
    updateStreams();
    await applyMicrophone();
    // A lost channel connection rejoined: the camera comes back on if it was.
    if (rejoining && cameraWanted) await startCamera();
    return true;
  } catch (err) {
    if (current !== attempt) return;
    console.warn('Could not connect to voice', err);
    attempt++;
    await teardown();
    if (rejoining) return { error: err };
    update({ ...NOT_IN_VOICE, error: errorMessage(err, err?.message === t('voice.errors.noEncryptedCalls') ? err.message : t('voice.errors.connect')) });
    return false;
  }
}

// Joins a voice channel (leaving any other, or a call). Must be called from a click or tap:
// browsers only start playing sound after one.
export async function joinVoice(guildId, channelId) {
  guildId = Number(guildId);
  channelId = Number(channelId);
  if (snapshot.channelId === channelId && snapshot.status !== 'idle' && !rejoin) return;
  listenForChannelChanges();
  await connect({ guildId, channelId }, () => fetchVoiceToken(guildId, channelId, prefs()));
}

// Joins a DM call's room (callClient.js has the token, the server's screen share limit and the
// call's key).
export async function joinCall({ callId, url, token, streamLimit = null, key }) {
  return connect({ callId }, async () => ({ url, token, streamLimit }), key);
}

// The voice channel's bitrate changed: the microphone goes out at it from now on (its sender's
// limit; LiveKit's server allows Opus up to 510 kbps), and when published again.
async function setBitrate(bitrate) {
  const current = room;
  if (!current || !Number.isInteger(bitrate)) return;
  current.options.publishDefaults = { ...current.options.publishDefaults, audioPreset: { maxBitrate: bitrate } };
  const sender = current.localParticipant.getTrackPublication(livekit.Track.Source.Microphone)?.track?.sender;
  if (!sender) return;
  try {
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) return;
    parameters.encodings[0].maxBitrate = bitrate;
    await sender.setParameters(parameters);
  } catch (err) {
    console.warn('Could not change the microphone bitrate', err);
  }
}

// The server says our voice channel's settings changed (`guild_voice_channel`): its bitrate, or
// it moved to another region, whose server we join instead (with a new token).
function channelChanged(event) {
  if (event.channelId !== snapshot.channelId || snapshot.status === 'idle') return;
  if (event.moved) {
    if (snapshot.status === 'connected') takeOver();
    return;
  }
  setBitrate(event.bitrate);
}

// Listened for from the first join on.
let listeningForChannels = false;
function listenForChannelChanges() {
  if (listeningForChannels) return;
  listeningForChannels = true;
  onGuildEvent((event) => {
    if (event.type === 'guild_voice_channel') channelChanged(event);
  });
}

// Leaves the voice channel or call (hanging up a call is callClient.js's hangUp).
export async function leaveVoice() {
  const inChannel = snapshot.status !== 'idle' && snapshot.channelId != null;
  const wasConnected = snapshot.status === 'connected' || snapshot.status === 'reconnecting';
  cancelRejoin();
  cameraWanted = false;
  cameraFacing = null;
  attempt++;
  await teardown();
  if (wasConnected) playSound('disconnect');
  update({ ...NOT_IN_VOICE, error: null, micError: null, audioBlocked: false });
  // In case LiveKit couldn't be told (lost connection): the API takes us out too.
  if (inChannel) await leaveVoiceChannel().catch(() => {});
}

// Rejoining a lost voice channel connection (see rejoin.js). `rejoin` is the channel being
// rejoined: { guildId, channelId, since, tries, timer }.
let rejoin = null;
let hiddenSince = null;
// LiveKit retrying a voice channel connection: after TAKE_OVER_AFTER_MS we rejoin instead.
let takeOverTimer = null;

function clearTakeOver() {
  clearTimeout(takeOverTimer);
  takeOverTimer = null;
}

function reconnecting(current) {
  if (current !== attempt) return;
  update({ status: 'reconnecting' });
  if (snapshot.channelId == null || takeOverTimer) return;
  takeOverTimer = setTimeout(() => {
    takeOverTimer = null;
    if (current !== attempt || snapshot.status !== 'reconnecting') return;
    takeOver();
  }, TAKE_OVER_AFTER_MS);
}

// Drops LiveKit's own attempt and rejoins the channel with a new token.
function takeOver() {
  const { guildId, channelId } = snapshot;
  attempt++;
  teardown();
  startRejoin(guildId, channelId);
}

const waitForVisible = () => isMobileDevice() && document.visibilityState === 'hidden';

function cancelRejoin() {
  if (rejoin?.timer) clearTimeout(rejoin.timer);
  rejoin = null;
}

function startRejoin(guildId, channelId) {
  cancelRejoin();
  rejoin = { guildId, channelId, since: Date.now(), tries: 0, timer: null };
  update({ ...NOT_IN_VOICE, guildId, channelId, status: 'reconnecting', error: null, audioBlocked: false });
  scheduleRejoin();
}

function scheduleRejoin() {
  if (!rejoin) return;
  if (rejoin.timer) clearTimeout(rejoin.timer);
  rejoin.timer = null;
  if (Date.now() - rejoin.since > REJOIN_FOR_MS) {
    giveUpRejoin(t('voice.errors.lost'));
    return;
  }
  if (waitForVisible()) return; // visibilitychange tries again
  rejoin.timer = setTimeout(tryRejoin, rejoinDelay(rejoin.tries));
}

async function tryRejoin() {
  const current = rejoin;
  if (!current) return;
  current.timer = null;
  if (waitForVisible()) return;
  current.tries++;
  const { guildId, channelId } = current;
  const result = await connect({ guildId, channelId }, () => fetchVoiceToken(guildId, channelId, prefs()), undefined, { rejoining: true });
  if (rejoin !== current) return; // left, or joined something else
  if (result === true) {
    rejoin = null;
    return;
  }
  if (result?.error && joinRefused(result.error)) {
    giveUpRejoin(errorMessage(result.error, t('voice.errors.lost')));
    return;
  }
  update({ ...NOT_IN_VOICE, guildId, channelId, status: 'reconnecting' });
  scheduleRejoin();
}

function giveUpRejoin(error) {
  cancelRejoin();
  playSound('disconnect');
  update({ ...NOT_IN_VOICE, error });
}

// Back in view (or back online): rejoin now. A phone whose connection was frozen in the
// background is most likely out already, so it doesn't wait for LiveKit's own retries.
function retryNow() {
  if (rejoin) {
    rejoin.tries = 0;
    scheduleRejoin();
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenSince = Date.now();
      return;
    }
    const hiddenFor = hiddenSince == null ? 0 : Date.now() - hiddenSince;
    hiddenSince = null;
    if (rejoin) {
      retryNow();
    } else if (room && snapshot.status === 'reconnecting' && snapshot.channelId != null
      && isMobileDevice() && hiddenFor > STALE_AFTER_HIDDEN_MS) {
      takeOver();
    }
  });
  window.addEventListener('online', retryNow);
}

// Shows `error` in the voice bar (e.g. why a call couldn't start).
export function setVoiceError(error) {
  update({ error });
}

const prefs = () => ({ selfMute: snapshot.selfMute, selfDeaf: snapshot.selfDeaf });

// While the microphone test runs (Settings → Voice & video) you're muted and deafened, so a
// call doesn't hear the test or play over it: what mute and deafen were before, put back when
// it ends. The device keeps remembering those (a page closed mid-test isn't left muted).
let beforeMicTest = null;

function setPrefs(changes, extra = {}) {
  update({ ...changes, ...extra });
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(beforeMicTest ?? prefs()));
  } catch {
    // Not remembered, then.
  }
  applyVolumes();
  applyMicrophone();
  if (snapshot.status !== 'idle' && snapshot.channelId != null) {
    saveVoiceState(prefs()).catch((err) => console.warn('Could not save mute/deafen', err));
  }
}

export function setMicTesting(on) {
  if (on === (beforeMicTest !== null)) return;
  if (on) {
    beforeMicTest = prefs();
    setPrefs({ selfMute: true, selfDeaf: true }, { micTesting: true });
  } else {
    const before = beforeMicTest;
    beforeMicTest = null;
    setPrefs(before, { micTesting: false });
  }
}

// Unmuting while deafened undeafens too (like Discord). Neither changes during a mic test.
export function setSelfMute(selfMute) {
  if (beforeMicTest) return;
  playSound(selfMute ? 'mute' : 'unmute');
  setPrefs(selfMute || !snapshot.selfDeaf ? { selfMute } : { selfMute, selfDeaf: false }, { micError: null });
}

export function setSelfDeaf(selfDeaf) {
  if (beforeMicTest) return;
  playSound(selfDeaf ? 'deafen' : 'undeafen');
  setPrefs({ selfDeaf });
}

// After the browser refused to play sound without a click: call from one.
export function resumeAudio() {
  room?.startAudio().then(() => {
    meterContext?.resume().catch(() => {});
    applyVolumes();
    update({ audioBlocked: false });
  }).catch(() => {});
}

export function clearVoiceError() {
  update({ error: null });
}

// A screen's sound never includes Voicaw's own (the call's voices, our sounds), like Discord:
// restrictOwnAudio (Chromium 140+, Windows and macOS; the desktop app too) leaves it out of
// system sound. Chrome does that by leaving out all of Chrome, so other tabs' sound goes too
// (sharing that tab still carries its sound). Browsers without it ignore it.
const SCREEN_AUDIO = { restrictOwnAudio: true };

// Shares your screen (a voice channel, with Video). Must be called from a click: the browser
// asks which screen, window or tab, and whether to share its sound (in the desktop app, our
// picker has asked already: `audio` is its answer, `deviceSound` that it comes from the app's
// microphone, on Linux). Your own stream is shown at once, like Discord's preview. At this
// device's quality (streamSettings.js), within the server's cap. `game` (the desktop app on
// Windows, a game picked in the Games tab: { hwnd }, its window having been chosen already):
// the window's capture goes out first, then the game's own frames take its place (shareGame).
export async function startScreenShare({ audio = true, deviceSound = false, game = null } = {}) {
  const current = room;
  if (!current || snapshot.status !== 'connected' || !snapshot.canStream) return;
  update({ streamError: null });
  const quality = screenShareOptions(getStreamSettings(), snapshot.streamLimit);
  try {
    await current.localParticipant.setScreenShareEnabled(true, {
      ...quality.capture,
      audio: audio && !deviceSound && SCREEN_AUDIO,
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    }, quality.publish);
    if (room !== current) return;
    update({ watching: current.localParticipant.identity });
    updateStreams();
    if (game?.hwnd) shareGame(current, game.hwnd);
    if (audio && deviceSound) await shareDeviceSound(current, quality.publish);
  } catch (err) {
    if (room !== current) return;
    // Cancelling the browser's picker is a NotAllowedError too: nothing to say then.
    const cancelled = err?.name === 'NotAllowedError' || err?.name === 'AbortError';
    if (!cancelled) console.warn('Could not share the screen', err);
    update({ streamError: cancelled ? null : screenErrorMessage(err) });
    updateStreams();
  }
}

// The share's sound on Linux (deviceStreamSound.js): the app's microphone of every other
// program's sound, published beside the screen as its sound. Ends with the share (LiveKit
// unpublishes both), when you leave, or if it fails (the screen stays shared, silent).
let deviceSoundTrack = null; // the MediaStreamTrack while shared

async function shareDeviceSound(current, publish) {
  let track = null;
  try {
    const found = await desktop?.startStreamSound?.();
    if (!found) throw new Error('No stream sound on this system');
    track = await captureStreamSound({ label: found.label });
    if (room !== current || !current.localParticipant.isScreenShareEnabled) throw new Error('The share ended');
    deviceSoundTrack = track;
    await current.localParticipant.publishTrack(track, { ...publish, source: livekit.Track.Source.ScreenShareAudio });
  } catch (err) {
    const ended = room !== current || !current.localParticipant.isScreenShareEnabled;
    if (deviceSoundTrack === track) deviceSoundTrack = null;
    track?.stop();
    desktop?.stopStreamSound?.();
    if (ended) return;
    console.warn('Could not share the sound', err);
    update({ streamError: t('voice.errors.streamSoundFailed') });
  }
}

// `unpublished` (LiveKit's LocalAudioTrack, when that's what went): only ours ends it.
function endDeviceSound(unpublished) {
  if (!deviceSoundTrack) return;
  if (unpublished && unpublished.kind === 'audio' && unpublished.mediaStreamTrack !== deviceSoundTrack) return;
  deviceSoundTrack.stop();
  deviceSoundTrack = null;
  desktop?.stopStreamSound?.();
}

// Game capture (voice/gameCapture.js; Game capture in docs/desktop-and-site.md): a game in
// exclusive full screen never reaches the desktop, so its window's capture shows a frozen
// picture. The desktop app on Windows hooks the game instead and hands over its frames, which
// replace the window's capture in the same screen share (replaceTrack: viewers keep watching,
// the sound stays the window's). If the game can't be hooked, the window's capture carries on
// and the sharer is told why. `gameShare` is { capture, track } while the game's frames go out.
let gameShare = null;
let gameShareStarting = null; // the room a game capture is starting in

async function shareGame(current, hwnd) {
  const { resolution, frameRate } = clampStream(getStreamSettings(), snapshot.streamLimit);
  const height = targetHeight(resolution);
  gameShareStarting = current;
  let capture;
  const sharing = () => room === current && gameShareStarting === current && current.localParticipant.isScreenShareEnabled;
  try {
    capture = await startGameFrames(desktop?.gameCapture, {
      hwnd,
      fps: frameRate,
      onEnd: (end) => gameShareEnded(current, end),
      onResize: ({ height: native }) => scaleGameShare(native, height),
    });
  } catch (err) {
    const stillSharing = sharing();
    if (gameShareStarting === current) gameShareStarting = null;
    if (!stillSharing || err?.code === 'unavailable' || err?.code === 'stopped') return;
    console.warn('Game capture failed; sharing the window instead', err?.code, err?.message);
    update({ streamError: t(`voice.errors.${gameCaptureFailureKey(err?.code)}`) });
    return;
  }
  const local = current.localParticipant.getTrackPublication(livekit.Track.Source.ScreenShare)?.track;
  if (!sharing() || !local) {
    capture.stop();
    return;
  }
  gameShareStarting = null;
  const windowTrack = local.mediaStreamTrack;
  capture.track.contentHint = windowTrack?.contentHint || 'motion';
  try {
    // Ours, not LiveKit's (true): it won't stop it or try to capture it again itself.
    await local.replaceTrack(capture.track, true);
  } catch (err) {
    capture.stop();
    console.warn('Could not swap in the game capture', err);
    if (room === current) update({ streamError: t('voice.errors.gameCaptureFailed') });
    return;
  }
  windowTrack?.stop();
  gameShare = { capture, track: local };
  await scaleGameShare(capture.height, height);
}

// LiveKit set the encodings for the frames' own size: keep the chosen resolution instead.
async function scaleGameShare(nativeHeight, height) {
  const sender = gameShare?.track.sender;
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings?.length) return;
  const base = gameShare.baseEncodings ?? params.encodings.map((e) => ({ scaleResolutionDownBy: e.scaleResolutionDownBy }));
  gameShare.baseEncodings = base;
  const scaled = scaledEncodings(base, nativeHeight, height);
  params.encodings = params.encodings.map((encoding, i) => ({ ...encoding, scaleResolutionDownBy: scaled[i]?.scaleResolutionDownBy ?? encoding.scaleResolutionDownBy }));
  await sender.setParameters(params).catch((err) => console.warn('Could not scale the game capture', err));
}

// The game closed (the share ends with it), or its capture failed mid-stream.
function gameShareEnded(current, end) {
  if (room !== current || !gameShare) return;
  gameShare = null;
  stopScreenShare();
  if (end?.code) update({ streamError: t('voice.errors.gameCaptureLost') });
}

function endGameCapture() {
  gameShareStarting = null;
  const share = gameShare;
  gameShare = null;
  share?.capture.stop();
}

function screenErrorMessage(err) {
  if (err?.name === 'NotSupportedError' || !canShareScreen()) return t('voice.errors.noScreenShare');
  return t('voice.errors.screenShareFailed');
}

export async function stopScreenShare() {
  const current = room;
  if (!current) return;
  endGameCapture();
  await current.localParticipant.setScreenShareEnabled(false).catch(() => {});
  endDeviceSound();
  if (room === current) updateStreams();
}

// Can this browser share a screen at all? (Phones' browsers can't; they can still watch.)
export function canShareScreen() {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

// Shows `identity`'s stream on this device (null: stop watching). Only watched streams are
// downloaded. Watching one brings it to the stage, over a focused camera.
export function watchStream(identity) {
  const watching = identity == null ? null : String(identity);
  const focusedCamera = watching == null ? snapshot.focusedCamera : null;
  if (watching === snapshot.watching && focusedCamera === snapshot.focusedCamera) return;
  update({ watching, focusedCamera, watchingReady: Boolean(screenTrack(watching)) });
  syncSubscriptions();
}

// The name `identity` joined with (from their token), for places drawn without a member list
// (the corner, a pop-out window): their profile may not have reached this device.
export function participantName(identity) {
  if (!room || identity == null) return '';
  const participant = isLocal(identity) ? room.localParticipant : room.remoteParticipants.get(identity);
  return participant?.name ?? '';
}

// Shows `identity`'s camera (yours too) big on this device (null: back to everyone). A stream
// being watched stays watched, with its sound: it just moves off the stage (see stage.js).
export function focusCamera(identity) {
  const focusedCamera = identity == null ? null : String(identity);
  if (focusedCamera === snapshot.focusedCamera) return;
  if (focusedCamera != null && !cameraPublication(focusedCamera)) return;
  update({ focusedCamera });
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

export function setStreamError(message) {
  update({ streamError: message });
}

// Your camera: on while `cameraWanted` (kept through a rejoin of a lost connection, not past
// leaving). Turned off, its track is unpublished (not just muted), so the camera's light goes
// off and the channel's "camera on" mark (the server's, from LiveKit's webhooks) goes with it.
let cameraWanted = false;
let cameraFacing = null; // see switchCamera

export async function startCamera() {
  const current = room;
  if (!current || snapshot.status !== 'connected' || !snapshot.canCamera) return;
  cameraWanted = true;
  update({ cameraError: null, cameraFacing });
  try {
    await current.localParticipant.setCameraEnabled(true, cameraOptions(undefined, cameraFacing), CAMERA_PUBLISH);
    if (room !== current) return;
    updateCameras();
  } catch (err) {
    if (room !== current) return;
    console.warn('Could not turn the camera on', err);
    cameraWanted = false;
    await unpublishCamera(current);
    update({ cameraError: cameraErrorMessage(err) });
    updateCameras();
  }
}

async function unpublishCamera(current) {
  const track = current.localParticipant.getTrackPublication(livekit.Track.Source.Camera)?.track;
  if (track) await current.localParticipant.unpublishTrack(track, true).catch(() => {});
}

export async function stopCamera() {
  cameraWanted = false;
  const current = room;
  if (!current) return;
  await unpublishCamera(current);
  if (room === current) updateCameras();
}

function cameraErrorMessage(err) {
  if (err?.name === 'NotAllowedError') return t('voice.errors.cameraBlocked');
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') return t('voice.errors.noCamera');
  return t('voice.errors.cameraFailed');
}

// A phone's other camera (front ↔ back) while yours is on: the same track, restarted on the
// other one (the old one is let go first, as phones open one camera at a time), so it isn't
// published again. Kept until you leave, through turning the camera off and on and rejoins.
let switchingCamera = false;

export async function switchCamera() {
  const current = room;
  const track = current?.localParticipant.getTrackPublication(livekit.Track.Source.Camera)?.track;
  if (!track || switchingCamera) return;
  const facing = cameraFacing ?? track.mediaStreamTrack?.getSettings?.().facingMode ?? 'user';
  const next = facing === 'environment' ? 'user' : 'environment';
  switchingCamera = true;
  update({ cameraError: null });
  try {
    await track.restartTrack(cameraOptions(undefined, next));
    if (room !== current) return;
    cameraFacing = next;
    update({ cameraFacing });
  } catch (err) {
    console.warn('Could not switch camera', err);
    if (room !== current) return;
    update({ cameraError: cameraErrorMessage(err) });
    // Back to the one we had, so the camera isn't left stopped.
    await track.restartTrack(cameraOptions(undefined, cameraFacing)).catch(() => {});
  } finally {
    switchingCamera = false;
  }
}

// A phone gets no frames from its camera while the page is hidden (the screen off, another app
// in front: Android's WebView and phone browsers stop it), so others would see your last frame
// frozen. There your camera is muted while hidden instead (others see your picture, the
// camera's light goes off, and it stays published, so `self_video` stays) and unmuted when
// you're back (LiveKit restarts it with the same constraints, the side switchCamera chose
// included). Computers keep sending while hidden: their cameras don't stop.
let cameraPause = Promise.resolve();

function pauseCameraWhileHidden() {
  const current = room;
  if (!current || !isMobileDevice()) return;
  cameraPause = cameraPause.then(async () => {
    const track = current.localParticipant.getTrackPublication(livekit.Track.Source.Camera)?.track;
    const pause = document.visibilityState === 'hidden';
    if (room !== current || !track || track.isMuted === pause) return;
    try {
      if (pause) await track.mute();
      else await track.unmute();
    } catch (err) {
      console.warn('Could not resume the camera', err);
      if (room !== current) return;
      await stopCamera();
      update({ cameraError: cameraErrorMessage(err) });
    }
    if (room === current) updateCameras();
  });
}

export function clearCameraError() {
  update({ cameraError: null });
}

// A camera chosen in Settings → Voice & video while yours is on: switch to it.
onVideoSettingsChange(async (next, previous) => {
  const current = room;
  if (!current || next.cameraDeviceId === previous.cameraDeviceId) return;
  cameraFacing = null;
  update({ cameraFacing });
  current.options.videoCaptureDefaults = { ...current.options.videoCaptureDefaults, ...cameraOptions(next) };
  const track = current.localParticipant.getTrackPublication(livekit.Track.Source.Camera)?.track;
  if (!track) return;
  await track.restartTrack(cameraOptions(next)).catch((err) => {
    console.warn('Could not switch camera', err);
    if (room === current) update({ cameraError: cameraErrorMessage(err) });
  });
});

onStreamViewQualityChange(() => {
  applyStreamQuality();
  for (const identity of cameraViews.keys()) sizeCamera(identity);
});

// Back from the background: cameras shown on screen are downloaded again (and not while hidden),
// your camera comes back on a phone and the screen is kept on again.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    syncSubscriptions();
    pauseCameraWhileHidden();
    syncScreenOn();
  });
}
