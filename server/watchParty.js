const { sendToChannel } = require('./guilds');

// Watch Together: a voice channel's YouTube watch party. Everyone in the channel plays the same
// video at the same point; the server keeps the queue and the clock, the clients only follow it
// (client voice/watchParty.js). Kept in memory, like who's in voice: an API restart ends every
// watch party.
//
// A party is { guildId, channelId, current, queue, playing, position, updatedAt }: `current` is
// the item playing (or paused), `queue` the ones after it, in order; `position` (seconds) is
// where `current` was at `updatedAt` (ms), so anyone can work out where it is now. Items are
// { id, videoId, title, author, duration, addedBy, addedAt }; `duration` (seconds) comes from the
// first player that knows it (YouTube's oEmbed doesn't say), and lets the server move on to the
// next video by itself when one ends. A live stream has none, and plays until skipped.
//
// Only people in the channel's voice (voice.js `states`) can change anything; what they may do
// follows Queue Videos, Manage Queue and Control Playback (routes/watchParty.js). Everyone who
// can see the channel gets `guild_watch_party` with the whole party (null: it ended), and the
// guild layout gives a voice channel `watch_party` (what's playing) for the channel list.
// The party ends with its last video, or a minute after the channel empties (a lone watcher
// whose connection drops comes back to it).
//
// Each channel also keeps an activity log, in memory only: who added, removed or moved which
// video, who played, paused, jumped (from where to where) or skipped, and when the server moved
// on by itself. The last MAX_LOG entries, kept past the party's end (so who skipped the last
// video shows) until the channel has been empty a minute, or it or its guild is deleted. The
// whole log comes with GET; `guild_watch_party` carries each new entry (`entry`).

const MAX_QUEUE = 100; // videos waiting, not counting the one playing
const MAX_DURATION = 7 * 24 * 3600; // longer than any video; anything above is a mistake
const END_GRACE_MS = 1000; // after a video's end, before moving on (players report a little late)
const EMPTY_GRACE_MS = 60 * 1000;
const VIDEO_ID = /^[\w-]{11}$/;
const MAX_LOG = 100;

// channelId -> party
const parties = new Map();
// channelId -> timer: ends the party of a channel nobody is in any more.
const emptyTimers = new Map();
// channelId -> { guildId, entries } (oldest first)
const logs = new Map();
let nextItemId = 1;
let nextEntryId = 1;

// Title and channel name from YouTube's oEmbed: null when YouTube couldn't be asked (the
// video is added without them). Throws { status, message } for a video that doesn't exist or
// can't be embedded. `search` finds videos (youtubeSearch.js). Replaceable by tests (they have
// no network).
const youtube = {
  search: (query) => require('./youtubeSearch').search(query),

  async videoInfo(videoId) {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    } catch {
      return null;
    }
    if (response.status === 401 || response.status === 403) {
      throw Object.assign(new Error("This video can't be played outside YouTube"), { status: 400 });
    }
    if (response.status === 400 || response.status === 404) {
      throw Object.assign(new Error('Video not found'), { status: 400 });
    }
    if (!response.ok) return null;
    const info = await response.json().catch(() => null);
    return info && { title: String(info.title ?? '').slice(0, 200) || null, author: String(info.author_name ?? '').slice(0, 100) || null };
  },
};

const publicItem = (item) => item && ({
  id: item.id,
  video_id: item.videoId,
  title: item.title,
  author: item.author,
  duration: item.duration,
  added_by: item.addedBy,
});

function publicParty(party) {
  if (!party) return null;
  return {
    current: publicItem(party.current),
    queue: party.queue.map(publicItem),
    playing: party.playing,
    position: party.position,
    updated_at: party.updatedAt,
  };
}

// What the channel list shows under a voice channel (guild layout).
function summaryOf(channelId) {
  const party = parties.get(channelId);
  return party ? { video_id: party.current.videoId, title: party.current.title, playing: party.playing } : null;
}

// Where the current video is now, in seconds.
function positionOf(party, now = Date.now()) {
  let position = party.position;
  if (party.playing) position += (now - party.updatedAt) / 1000;
  return party.current.duration ? Math.min(position, party.current.duration) : position;
}

const getParty = (channelId) => parties.get(channelId) ?? null;

// `entry`: what was just logged (null: nothing, e.g. a video's length arriving).
async function announce(party, entry = null) {
  const { channelId, guildId } = party;
  await sendToChannel(
    { id: channelId, guild_id: guildId },
    { type: 'guild_watch_party', guildId, channelId, party: publicParty(parties.get(channelId)), entry, serverTime: Date.now() }
  );
}

// Adds to the channel's activity log: `action` is add, remove, move, play, pause, seek, skip or
// ended (the server moving on by itself, no `userId`); `item` the video it was about; seek has
// `from` and `to` (seconds), move `to` (the video's place in the queue, 1 = next).
function log(party, { userId = null, action, item, from, to }) {
  const entry = {
    id: nextEntryId++,
    at: Date.now(),
    user_id: userId,
    action,
    video_id: item?.videoId ?? null,
    title: item?.title ?? null,
    ...(from !== undefined && { from }),
    ...(to !== undefined && { to }),
  };
  const kept = logs.get(party.channelId) ?? { guildId: party.guildId, entries: [] };
  kept.entries.push(entry);
  if (kept.entries.length > MAX_LOG) kept.entries.splice(0, kept.entries.length - MAX_LOG);
  logs.set(party.channelId, kept);
  return entry;
}

const logOf = (channelId) => logs.get(channelId)?.entries ?? [];

// Moves on to the next video by itself when the current one ends (its duration is known).
function schedule(party) {
  clearTimeout(party.timer);
  party.timer = null;
  if (!party.playing || !party.current.duration) return;
  const itemId = party.current.id;
  const ms = (party.current.duration - positionOf(party)) * 1000 + END_GRACE_MS;
  party.timer = setTimeout(() => {
    if (parties.get(party.channelId) !== party || party.current.id !== itemId) return;
    advance(party, log(party, { action: 'ended', item: party.current })).catch(console.error);
  }, Math.max(ms, 0));
  party.timer.unref?.();
}

function startItem(party, item) {
  party.current = item;
  party.playing = true;
  party.position = 0;
  party.updatedAt = Date.now();
}

// The next video in the queue plays; with none left, the party ends. `entry`: what led to it.
async function advance(party, entry) {
  const next = party.queue.shift();
  if (next) {
    startItem(party, next);
    schedule(party);
  } else {
    clearTimeout(party.timer);
    parties.delete(party.channelId);
  }
  await announce(party, entry);
}

function makeItem(videoId, info, userId) {
  return {
    id: nextItemId++,
    videoId,
    title: info?.title ?? null,
    author: info?.author ?? null,
    duration: null,
    addedBy: userId,
    addedAt: Date.now(),
  };
}

const fail = (status, message) => Object.assign(new Error(message), { status });

// Adds a video (by YouTube id) to the channel's queue; with nothing playing it starts at once.
async function addVideo({ guildId, channelId, userId, videoId }) {
  if (typeof videoId !== 'string' || !VIDEO_ID.test(videoId)) throw fail(400, 'Not a YouTube video');
  const existing = parties.get(channelId);
  if (existing && existing.queue.length >= MAX_QUEUE) throw fail(400, `The queue is full (${MAX_QUEUE} videos)`);
  const info = await youtube.videoInfo(videoId);
  // Asking YouTube took a moment: the party may have started or ended meanwhile.
  let party = parties.get(channelId);
  if (party && party.queue.length >= MAX_QUEUE) throw fail(400, `The queue is full (${MAX_QUEUE} videos)`);
  const item = makeItem(videoId, info, userId);
  if (party) {
    party.queue.push(item);
  } else {
    party = { guildId, channelId, queue: [], timer: null };
    startItem(party, item);
    parties.set(channelId, party);
  }
  await announce(party, log(party, { userId, action: 'add', item }));
  return party;
}

function requireParty(channelId) {
  const party = parties.get(channelId);
  if (!party) throw fail(404, 'Nothing is playing');
  return party;
}

function queuedItem(party, itemId) {
  const item = party.queue.find((i) => i.id === itemId);
  if (!item) throw fail(404, 'That video is no longer in the queue');
  return item;
}

// `userId` takes a waiting video out of the queue (not the one playing: that's skipping).
async function removeVideo(party, itemId, userId) {
  const item = queuedItem(party, itemId);
  party.queue = party.queue.filter((i) => i !== item);
  await announce(party, log(party, { userId, action: 'remove', item }));
}

// `userId` moves a waiting video before `beforeId` (null: to the end).
async function moveVideo(party, itemId, beforeId, userId) {
  const item = queuedItem(party, itemId);
  const rest = party.queue.filter((i) => i.id !== itemId);
  const index = beforeId == null ? rest.length : rest.findIndex((i) => i.id === beforeId);
  if (index < 0) throw fail(404, 'That video is no longer in the queue');
  rest.splice(index, 0, item);
  party.queue = rest;
  await announce(party, log(party, { userId, action: 'move', item, to: index + 1 }));
}

// `userId` plays/pauses and/or jumps: `playing` true/false, `position` seconds (absent: where
// it is now). Logged as a jump when it moves, else as play or pause (unless nothing changed).
async function setPlayback(party, { playing, position }, userId) {
  const now = Date.now();
  const before = positionOf(party, now);
  const wasPlaying = party.playing;
  let next = position ?? before;
  if (party.current.duration) next = Math.min(next, party.current.duration);
  party.position = Math.max(0, next);
  party.playing = playing ?? party.playing;
  party.updatedAt = now;
  schedule(party);
  let entry = null;
  if (position !== undefined && Math.abs(party.position - before) >= 1) {
    entry = log(party, { userId, action: 'seek', item: party.current, from: Math.round(before), to: Math.round(party.position) });
  } else if (party.playing !== wasPlaying) {
    entry = log(party, { userId, action: party.playing ? 'play' : 'pause', item: party.current });
  }
  await announce(party, entry);
}

// `userId` skips the video playing, if it's still `itemId` (two people skipping at once skip
// one video).
async function skipVideo(party, itemId, userId) {
  if (party.current.id !== itemId) return;
  clearTimeout(party.timer);
  await advance(party, log(party, { userId, action: 'skip', item: party.current }));
}

// A player says how long a video is: the first answer counts. Live streams report 0 (no end).
async function setDuration(party, itemId, duration) {
  const item = party.current.id === itemId ? party.current : party.queue.find((i) => i.id === itemId);
  if (!item || item.duration != null) return;
  if (!(Number.isFinite(duration) && duration > 0 && duration <= MAX_DURATION)) return;
  item.duration = duration;
  if (item === party.current) {
    schedule(party);
    await announce(party);
  }
}

// Ends the channel's party at once and forgets its log (the channel emptied a while ago).
async function endParty(channelId) {
  clearTimeout(emptyTimers.get(channelId));
  emptyTimers.delete(channelId);
  logs.delete(channelId);
  const party = parties.get(channelId);
  if (!party) return;
  clearTimeout(party.timer);
  parties.delete(channelId);
  await announce(party);
}

// Someone joined or left the channel's voice (voice.js): a party in a channel nobody is in any
// more ends a minute later, unless someone comes back.
function voiceChanged(channelId, occupied) {
  if (occupied) {
    clearTimeout(emptyTimers.get(channelId));
    emptyTimers.delete(channelId);
    return;
  }
  if ((!parties.has(channelId) && !logs.has(channelId)) || emptyTimers.has(channelId)) return;
  const timer = setTimeout(() => {
    emptyTimers.delete(channelId);
    endParty(channelId).catch(console.error);
  }, EMPTY_GRACE_MS);
  timer.unref?.();
  emptyTimers.set(channelId, timer);
}

// The channel is being deleted: its party goes without telling anyone (the channel goes too).
function dropChannel(channelId) {
  clearTimeout(parties.get(channelId)?.timer);
  logs.delete(channelId);
  clearTimeout(emptyTimers.get(channelId));
  emptyTimers.delete(channelId);
  parties.delete(channelId);
}

// The same for every channel of a guild being deleted.
function dropGuild(guildId) {
  for (const party of [...parties.values()]) {
    if (party.guildId === guildId) dropChannel(party.channelId);
  }
  for (const [channelId, kept] of [...logs]) {
    if (kept.guildId === guildId) dropChannel(channelId);
  }
}

module.exports = {
  MAX_QUEUE,
  EMPTY_GRACE_MS,
  youtube,
  parties,
  getParty,
  logOf,
  requireParty,
  queuedItem,
  publicParty,
  summaryOf,
  positionOf,
  addVideo,
  removeVideo,
  moveVideo,
  setPlayback,
  skipVideo,
  setDuration,
  endParty,
  voiceChanged,
  dropChannel,
  dropGuild,
};
