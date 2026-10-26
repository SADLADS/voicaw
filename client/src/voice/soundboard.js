import { useEffect, useSyncExternalStore } from 'react';
import api from '../utils/api';
import { onConnectionState, onGuildEvent } from '../utils/ws-client';
import { playClip } from '../sounds/sounds';
import { getAudioSettings } from './audioSettings';
import { getVoiceSnapshot } from './voiceClient';
import { t } from '../i18n';

// Guild soundboards (server/soundboard.js; docs/voice-and-calls.md, Soundboard). Each guild's
// sounds ({ id, guild_id, name, emoji, volume, creator_id, created_at }), from GET
// (`useSoundboard`, whenever the picker or settings want them) and `guild_soundboard_update`;
// and your join sound, one for every guild (`useJoinSound`, your profile), followed with
// `guild_join_sound`.
//
// Playing: the server tells everyone in the channel (`guild_soundboard_play`), and this device
// plays the file itself if it's the one in that channel, not deafened, and the kind (a sound
// someone played, or someone's join sound) is on in Settings → Voice & video, at that kind's
// volume × the sound's own × the output volume. Sounds are cut at MAX_SECONDS, whatever the
// file, and a person's sound stops when they play another (other people's play on). The emoji of
// each sound played shows on its player's tile for a moment (`useSoundEffects`), heard or not.

export const MAX_SECONDS = 5.2;
const EFFECT_MS = 3000;

let base = '';
// The object store's address (from /api/config), where sounds are at sounds/<id>.
export function setSoundboardBase(s3Endpoint) {
  base = s3Endpoint ? `${s3Endpoint}/sounds/` : '';
}
export const soundUrl = (soundId) => `${base}${soundId}`;

const boards = new Map(); // guildId -> { sounds }
let joinSound; // { joinSoundId, guilds: [{ id, name, sounds }] }, undefined until loaded
let joinSoundWanted = 0; // how many are showing it (reloaded when sounds or guilds change)
const playing = new Map(); // userId -> { stop } of the sound they last played
const effects = new Map(); // `${channelId}:${userId}` -> { emoji, name, key }
let effectCount = 0;
const wanted = new Map(); // guildId -> how many are showing it (reloaded after a reconnect)
const listeners = new Set();
let unsubscribe = null;

let version = 0; // moved on by every change (useSoundEffects' snapshots)
function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Whether a sound played in `channelId` (a join sound when `join`) should be heard here, and
// how loud: 0 for not at all.
export function effectVolume({ join, sound }, voice = getVoiceSnapshot(), settings = getAudioSettings()) {
  if (voice.status === 'idle' || voice.callId != null || voice.selfDeaf) return 0;
  const on = join ? settings.joinSoundsOn : settings.soundboardOn;
  if (!on) return 0;
  const kind = join ? settings.joinSoundVolume : settings.soundboardVolume;
  return kind * (sound.volume ?? 1) * settings.outputVolume;
}

function showEffect(event) {
  const key = `${event.channelId}:${event.userId}`;
  const effect = { emoji: event.sound.emoji ?? null, name: event.sound.name, key: ++effectCount };
  effects.set(key, effect);
  notify();
  setTimeout(() => {
    if (effects.get(key) === effect) {
      effects.delete(key);
      notify();
    }
  }, EFFECT_MS);
}

// Plays a sound `userId` played, stopping theirs before it (still loading or playing).
async function playFor(userId, url, options) {
  playing.get(userId)?.stop?.();
  const entry = { stop: null };
  playing.set(userId, entry);
  const stop = await playClip(url, options);
  if (playing.get(userId) === entry) entry.stop = stop;
  else stop?.(); // a newer one came while this loaded
}

function handlePlay(event) {
  const voice = getVoiceSnapshot();
  if (voice.callId != null || voice.status === 'idle' || voice.channelId !== Number(event.channelId)) return;
  showEffect(event);
  const volume = effectVolume(event, voice);
  if (volume > 0) playFor(Number(event.userId), soundUrl(event.sound.id), { volume, maxSeconds: MAX_SECONDS });
  else playing.get(Number(event.userId))?.stop?.();
}

function handleEvent(event) {
  const guildId = Number(event.guildId);
  switch (event.type) {
    case 'guild_soundboard_play':
      handlePlay(event);
      return;
    case 'guild_soundboard_update':
      boards.set(guildId, { sounds: event.sounds });
      notify();
      reloadJoinSound();
      return;
    case 'guild_join_sound':
      if (joinSound) {
        joinSound = { ...joinSound, joinSoundId: event.soundId ?? null };
        notify();
      }
      return;
    case 'guild_add':
      reloadJoinSound();
      return;
    case 'guild_remove':
      if (boards.delete(guildId)) notify();
      reloadJoinSound();
      return;
    default:
  }
}

// Starts following the events (Layout, once logged in); `null` stops and forgets everything.
export function initSoundboard(user) {
  unsubscribe?.();
  unsubscribe = null;
  boards.clear();
  effects.clear();
  joinSound = undefined;
  for (const { stop } of playing.values()) stop?.();
  playing.clear();
  if (!user) return;
  const offEvents = onGuildEvent(handleEvent);
  const offConnection = onConnectionState((state) => {
    if (state !== 'online') return;
    for (const guildId of wanted.keys()) loadSoundboard(guildId).catch(() => {});
    reloadJoinSound();
  });
  unsubscribe = () => {
    offEvents();
    offConnection();
  };
}

export async function loadSoundboard(guildId) {
  const { data } = await api.get(`/guilds/${guildId}/soundboard`);
  boards.set(Number(guildId), { sounds: data.sounds });
  notify();
}

// The guild's { sounds }, undefined until loaded (kept loaded while mounted).
export function useSoundboard(guildId) {
  const board = useSyncExternalStore(subscribe, () => (guildId == null ? undefined : boards.get(Number(guildId))));
  useEffect(() => {
    if (guildId == null) return undefined;
    const key = Number(guildId);
    wanted.set(key, (wanted.get(key) ?? 0) + 1);
    loadSoundboard(key).catch((err) => console.warn('Could not load the soundboard', err));
    return () => {
      const left = (wanted.get(key) ?? 1) - 1;
      if (left > 0) wanted.set(key, left);
      else wanted.delete(key);
    };
  }, [guildId]);
  return board;
}

// The emoji to show over people's tiles in `channelId`: { [userId]: { emoji, name, key } }.
let effectsSnapshot = {};
let effectsSnapshotFor = null;
let effectsVersion = -1;
function effectsIn(channelId) {
  if (effectsSnapshotFor !== channelId || effectsVersion !== version) {
    const prefix = `${channelId}:`;
    effectsSnapshot = Object.fromEntries([...effects].filter(([key]) => key.startsWith(prefix)).map(([key, effect]) => [key.slice(prefix.length), effect]));
    effectsSnapshotFor = channelId;
    effectsVersion = version;
  }
  return effectsSnapshot;
}
export const useSoundEffects = (channelId) => useSyncExternalStore(subscribe, () => effectsIn(channelId));

// Plays a sound to everyone in your voice channel (you hear it from the server's event, like
// everyone else). Throws the server's reason.
export async function playSoundboardSound(guildId, channelId, soundId) {
  await api.post(`/guilds/${guildId}/channels/${channelId}/soundboard/${soundId}`);
}

// Only here, at the soundboard volume (the picker's and settings' preview).
export function previewSound(sound) {
  const settings = getAudioSettings();
  return playClip(soundUrl(sound.id), { volume: settings.soundboardVolume * (sound.volume ?? 1) * settings.outputVolume, maxSeconds: MAX_SECONDS });
}

async function loadJoinSound() {
  const { data } = await api.get('/soundboard/join-sound');
  joinSound = { joinSoundId: data.join_sound_id ?? null, guilds: data.guilds };
  notify();
}

function reloadJoinSound() {
  if (joinSoundWanted > 0) loadJoinSound().catch(() => {});
}

// Your join sound and what it can be: { joinSoundId, guilds: [{ id, name, sounds }] } (every
// guild you're in that has sounds), undefined until loaded (kept loaded while mounted).
export function useJoinSound() {
  const value = useSyncExternalStore(subscribe, () => joinSound);
  useEffect(() => {
    joinSoundWanted += 1;
    loadJoinSound().catch((err) => console.warn('Could not load the join sound', err));
    return () => { joinSoundWanted -= 1; };
  }, []);
  return value;
}

// Your join sound, the same in every guild (null for none).
export async function setJoinSound(soundId) {
  const { data } = await api.put('/soundboard/join-sound', { soundId: soundId ?? null });
  if (joinSound) {
    joinSound = { ...joinSound, joinSoundId: data.join_sound_id };
    notify();
  }
}

// ---- Managing (Manage Emoji) ----

// Creates the sound, uploads `file` (a Blob of an MP3, Ogg or WAV) for it, then makes it available.
export async function addSound(guildId, { name, emoji = null, volume = 1 }, file) {
  const { data } = await api.post(`/guilds/${guildId}/soundboard`, { name, emoji, volume, type: file.type, size: file.size });
  const res = await fetch(data.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
  if (!res.ok) throw new Error(t('guildAdmin.upload.failed'));
  return (await api.post(`/guilds/${guildId}/soundboard/${data.sound.id}/ready`)).data;
}

// Any of { name, emoji, volume }.
export async function updateSound(guildId, soundId, changes) {
  return (await api.patch(`/guilds/${guildId}/soundboard/${soundId}`, changes)).data;
}

export async function deleteSound(guildId, soundId) {
  await api.delete(`/guilds/${guildId}/soundboard/${soundId}`);
}
