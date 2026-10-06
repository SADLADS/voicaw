import { useEffect, useSyncExternalStore } from 'react';
import api from '../utils/api';
import { onConnectionState, onGuildEvent } from '../utils/ws-client';
import { youtubeVideoId } from '../utils/youtube';

// Watch Together (server/watchParty.js): each voice channel's party as the server last said,
// and the server's clock, which every player follows. A party is { current, queue, playing,
// position, updated_at } (items { id, video_id, title, author, duration, added_by }), or null.
// It comes from GET (`loadWatchParty`, when a channel page or the player wants it), from what
// every change answers, and from `guild_watch_party` events (everyone who can see the
// channel). Read with `useWatchParty(channelId)`.
//
// Each channel's activity log too (`useWatchPartyLog`): entries { id, at, user_id (null: the
// server moved on by itself), action, video_id, title, from?, to? }, oldest first, the whole of
// it from GET and each new one from the events (`entry`). The server keeps the last 100, in
// memory only.
//
// The clock: `serverNow()` is Date.now() moved by the offset to the server's. A GET's answer
// gives the offset to within half its round trip (the quickest round trip so far is kept);
// an event's `serverTime` was taken before it travelled, so it only says the offset is at
// least that (applied if it's more).

const parties = new Map(); // channelId -> party | null (known to have none)
const logs = new Map(); // channelId -> [entry]
const MAX_LOG = 100;
const listeners = new Set();
const wanted = new Map(); // channelId -> { guildId, users }: reloaded after a reconnect
let offset = 0;
let bestRoundTrip = Infinity;
let unsubscribe = null;

function notify() {
  for (const listener of listeners) listener();
}

function setParty(channelId, party) {
  parties.set(Number(channelId), party ?? null);
  notify();
}

export function serverNow() {
  return Date.now() + offset;
}

// An event's server time arrived just now: the server's clock is at least that far ahead.
function sawServerTime(serverTime) {
  if (!Number.isFinite(serverTime)) return;
  const lowerBound = serverTime - Date.now();
  if (lowerBound > offset) offset = lowerBound;
}

// Where `party`'s video is at server time `now`, in seconds.
export function expectedPosition(party, now = serverNow()) {
  if (!party?.current) return 0;
  let position = party.position;
  if (party.playing) position += Math.max(0, now - party.updated_at) / 1000;
  return party.current.duration ? Math.min(position, party.current.duration) : position;
}

function handleEvent(event) {
  if (event.type !== 'guild_watch_party') return;
  sawServerTime(event.serverTime);
  const channelId = Number(event.channelId);
  if (event.entry) {
    const entries = logs.get(channelId) ?? [];
    if (!entries.some((e) => e.id === event.entry.id)) logs.set(channelId, [...entries, event.entry].slice(-MAX_LOG));
  } else if (!event.party) {
    // Ended without an action: the channel emptied, and the server forgot its log.
    logs.delete(channelId);
  }
  setParty(channelId, event.party);
}

function start() {
  if (unsubscribe) return;
  const offEvents = onGuildEvent(handleEvent);
  // Events missed while offline: ask again.
  const offConnection = onConnectionState((state) => {
    if (state !== 'online') return;
    for (const [channelId, { guildId }] of wanted) loadWatchParty(guildId, channelId).catch(() => {});
  });
  unsubscribe = () => {
    offEvents();
    offConnection();
  };
}

// Calls `listener` on any change (and starts following the events).
export function subscribeWatchParties(listener) {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// The channel's party: undefined until known, null when there's none.
export const getWatchParty = (channelId) => parties.get(Number(channelId));

const NO_ENTRIES = [];
// The channel's activity log, oldest first.
export const getWatchPartyLog = (channelId) => logs.get(Number(channelId)) ?? NO_ENTRIES;

const path = (guildId, channelId) => `/guilds/${guildId}/channels/${channelId}/watch-party`;

// What a change (or GET) answered: { party, server_time }, and from GET the whole `log`.
function applyAnswer(channelId, data, sentAt) {
  if (Array.isArray(data?.log)) logs.set(Number(channelId), data.log);
  if (sentAt != null && Number.isFinite(data?.server_time)) {
    const roundTrip = Date.now() - sentAt;
    if (roundTrip <= bestRoundTrip) {
      bestRoundTrip = roundTrip;
      offset = data.server_time + roundTrip / 2 - Date.now();
    }
  }
  setParty(channelId, data?.party);
}

export async function loadWatchParty(guildId, channelId) {
  const sentAt = Date.now();
  const res = await api.get(path(guildId, channelId));
  applyAnswer(channelId, res.data, sentAt);
}

// Keeps the channel's party loaded while mounted (and reloaded after reconnecting).
export function useWatchParty(guildId, channelId) {
  const party = useSyncExternalStore(subscribeWatchParties, () => (channelId == null ? undefined : getWatchParty(channelId)));
  useEffect(() => {
    if (guildId == null || channelId == null) return undefined;
    const key = Number(channelId);
    const entry = wanted.get(key) ?? { guildId, users: 0 };
    entry.users += 1;
    wanted.set(key, entry);
    loadWatchParty(guildId, channelId).catch(() => {});
    return () => {
      entry.users -= 1;
      if (entry.users <= 0) wanted.delete(key);
    };
  }, [guildId, channelId]);
  return party;
}

// The channel's activity log (loaded with its party by useWatchParty).
export function useWatchPartyLog(channelId) {
  return useSyncExternalStore(subscribeWatchParties, () => getWatchPartyLog(channelId));
}

async function change(guildId, channelId, request) {
  const sentAt = Date.now();
  const res = await request(path(guildId, channelId));
  applyAnswer(channelId, res.data, sentAt);
  return res.data?.party ?? null;
}

// A YouTube link (watch, share, shorts, live, embed), as the video id; null for anything else,
// which the panel searches YouTube for (a bare video id included: YouTube finds it).
export function videoIdFromInput(input) {
  const text = (input ?? '').trim();
  if (!text || /\s/.test(text)) return null;
  return youtubeVideoId(/^https?:\/\//i.test(text) ? text : `https://${text}`);
}

// Whether the box holds a link (of any site) rather than words to search for.
export const looksLikeLink = (input) => /^(https?:\/\/|www\.)\S+$|^((m|music)\.)?youtu(\.be|be\.com)\/\S*$/i.test((input ?? '').trim());

// Videos on YouTube matching `query` (the server asks YouTube): [{ video_id, title, author,
// duration, live }].
export async function searchVideos(guildId, channelId, query) {
  const res = await api.get(`${path(guildId, channelId)}/search`, { params: { q: query } });
  return res.data?.results ?? [];
}

export const addVideo = (guildId, channelId, videoId) =>
  change(guildId, channelId, (base) => api.post(`${base}/queue`, { videoId }));

export const removeVideo = (guildId, channelId, itemId) =>
  change(guildId, channelId, (base) => api.delete(`${base}/queue/${itemId}`));

export const moveVideo = (guildId, channelId, itemId, beforeId) =>
  change(guildId, channelId, (base) => api.put(`${base}/queue/${itemId}/move`, { beforeId }));

// { playing?, position?, itemId } (itemId: the video meant, so a late click can't move the next).
export const setPlayback = (guildId, channelId, playback) =>
  change(guildId, channelId, (base) => api.put(`${base}/playback`, playback));

export const skipVideo = (guildId, channelId, itemId) =>
  change(guildId, channelId, (base) => api.post(`${base}/skip`, { itemId }));

// The first player to know a video's length tells the server, which then moves on by itself.
const reportedDurations = new Set();
export function reportDuration(guildId, channelId, itemId, duration) {
  if (reportedDurations.has(itemId) || !(duration > 0)) return;
  reportedDurations.add(itemId);
  api.put(`${path(guildId, channelId)}/duration`, { itemId, duration }).catch(() => reportedDurations.delete(itemId));
}

// The one item `next` moved compared with `previous` (two orders of the same ids, after a
// drag), and the id it now sits before (null: the end); null if none moved.
export function movedItem(previous, next) {
  for (let i = 0; i < next.length; i++) {
    const id = next[i];
    if (previous[i] === id) continue;
    const a = previous.filter((other) => other !== id);
    const b = next.filter((other) => other !== id);
    if (a.length === b.length && a.every((other, j) => other === b[j])) return { id, beforeId: next[i + 1] ?? null };
  }
  return null;
}

// A video position as the player shows it: 0:07, 3:25, 1:02:09.
export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// The place on the channel page the player sits over (WatchPartyPanel sets it). The player
// lives in Layout and is never moved (moving an iframe reloads it): it's drawn over the slot
// while there is one, and small in a corner otherwise.
let slot = null;
const slotListeners = new Set();
export function setPlayerSlot(element) {
  if (slot === element) return;
  slot = element;
  for (const listener of slotListeners) listener();
}
export function usePlayerSlot() {
  return useSyncExternalStore((listener) => {
    slotListeners.add(listener);
    return () => slotListeners.delete(listener);
  }, () => slot);
}

// For tests.
export function resetWatchParties() {
  unsubscribe?.();
  unsubscribe = null;
  parties.clear();
  logs.clear();
  wanted.clear();
  reportedDurations.clear();
  offset = 0;
  bestRoundTrip = Infinity;
}
