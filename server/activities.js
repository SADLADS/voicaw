const crypto = require('crypto');

// Activities ("Playing Hades", Discord's Rich Presence): what someone's games say they're
// doing, shared by the desktop app (electron/richPresence.js), and bots' own ("Watching 3
// guilds", gateway op 3). Kept in memory only, on the socket that set them, and gone when that
// socket closes; only people's games' names and times are saved, for their profile's Activity
// tab (activityHistory.js, 30 days, which they can turn off). Everyone logged in sees them
// (`user_activities`), as statuses; bots through PRESENCE_UPDATE.
//
// One activity: { name, type, details, state, start, end, partySize, partyMax, imageText, image }.
// `name` may be null (a game the desktop app couldn't name: "a game"); `type` is Discord's
// (0 Playing, 1 Streaming, 2 Listening to, 3 Watching, 4 a bot's custom status, 5 Competing in);
// start/end are unix ms; `image` is a picture's id (see storeImage) or null; `smallIcon`
// 'playing' | 'paused' | null (a music player's state, drawn on the picture's corner) with
// `smallText`, its hover text; `statusShows` 'state' | 'details' | null: what the short line
// under names shows instead of the name ("Listening to Butthole Surfers" rather than "Listening
// to Feishin"; Discord's status_display_type, chosen in the music player).

const MAX_ACTIVITIES = 3;
const MAX_TEXT = 128;
const PERSON_TYPES = new Set([0, 2, 3, 5]);
const BOT_TYPES = new Set([0, 1, 2, 3, 4, 5]);
const SMALL_ICONS = new Set(['playing', 'paused']);
const STATUS_SHOWS = new Set(['state', 'details']);
const STATUS_DISPLAY_TYPES = { state: 1, details: 2 };

// Pictures: a game's cover or icon, made small on the player's computer (at most 128 px), kept
// here by the hash of their bytes and served at /api/activity-images/:id. In memory, the most
// recently used kept; the desktop app sends its pictures again after reconnecting.
const MAX_IMAGE_BYTES = 48 * 1024;
const MAX_IMAGES = 500;
const images = new Map(); // id -> { data: Buffer, type }

const text = (value) => {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean ? [...clean].slice(0, MAX_TEXT).join('') : null;
};

const time = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n < 1e14 ? Math.round(n) : null;
};

const count = (value) => (Number.isInteger(value) && value >= 0 && value < 1e6 ? value : null);

function imageType(data) {
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

// Keeps a picture (base64 JPEG or PNG); returns its id, or null if it isn't one.
function storeImage(base64) {
  if (typeof base64 !== 'string' || base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return null;
  const data = Buffer.from(base64, 'base64');
  const type = imageType(data);
  if (!type) return null;
  const id = crypto.createHash('sha256').update(data).digest('hex').slice(0, 32);
  images.delete(id);
  images.set(id, { data, type });
  while (images.size > MAX_IMAGES) images.delete(images.keys().next().value);
  return id;
}

function getImage(id) {
  const image = images.get(String(id));
  if (!image) return null;
  images.delete(id);
  images.set(id, image); // most recently used
  return image;
}

function imageId(image) {
  if (!image || typeof image !== 'object') return null;
  if (typeof image.data === 'string') return storeImage(image.data);
  return typeof image.id === 'string' && images.has(image.id) ? image.id : null;
}

// What a person's app sent (`activity` websocket message), cleaned.
function cleanActivities(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_ACTIVITIES).filter((a) => a && typeof a === 'object').map((a) => {
    const type = Number(a.type);
    const partySize = count(a.partySize);
    const partyMax = count(a.partyMax);
    return {
      name: text(a.name),
      type: PERSON_TYPES.has(type) ? type : 0,
      details: text(a.details),
      state: text(a.state),
      start: time(a.start),
      end: time(a.end),
      partySize: partySize != null && partyMax != null ? partySize : null,
      partyMax: partySize != null && partyMax != null ? partyMax : null,
      imageText: text(a.imageText),
      image: imageId(a.image),
      smallIcon: SMALL_ICONS.has(a.smallIcon) ? a.smallIcon : null,
      smallText: text(a.smallText),
      statusShows: STATUS_SHOWS.has(a.statusShows) ? a.statusShows : null,
    };
  });
}

// A bot's activities in Discord's shape (gateway op 3: [{ name, type, state, url }]), as ours.
function cleanBotActivities(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_ACTIVITIES).filter((a) => a && typeof a === 'object').map((a) => {
    const type = BOT_TYPES.has(Number(a.type)) ? Number(a.type) : 0;
    return {
      name: type === 4 ? null : text(a.name),
      type,
      details: text(a.details),
      // A custom status is its state (discord.js sends its text as the state, older libraries as the name).
      state: text(a.state) ?? (type === 4 ? text(a.name) : null),
      start: time(a.timestamps?.start),
      end: time(a.timestamps?.end),
      partySize: null,
      partyMax: null,
      imageText: null,
      image: null,
      smallIcon: null,
      smallText: null,
      statusShows: null,
    };
  }).filter((a) => a.name || a.state);
}

// Someone's activities from their sockets: the ones most recently set (a second computer with
// the app open and no game doesn't hide the first's). An invisible bot's don't show.
function activitiesOf(sockets) {
  let latest = null;
  for (const socket of sockets ?? []) {
    if (socket.readyState !== 1 || socket.presence?.invisible || !socket.activities?.length) continue;
    if (!latest || socket.activitiesAt > latest.activitiesAt) latest = socket;
  }
  return latest ? latest.activities : [];
}

// Everyone's current activities, by user id (string), for those who have any.
const current = new Map();

// Records `userId`'s activities; returns whether they changed (so they're broadcast).
function remember(userId, activities) {
  userId = String(userId);
  const before = JSON.stringify(current.get(userId) ?? []);
  if (activities.length) current.set(userId, activities);
  else current.delete(userId);
  return before !== JSON.stringify(activities);
}

const getActivities = (userId) => current.get(String(userId)) ?? [];

// One of ours as Discord's activity object (for bots).
function discordActivity(a) {
  return {
    name: a.type === 4 ? 'Custom Status' : (a.name ?? 'Game'),
    type: a.type,
    created_at: a.start ?? Date.now(),
    ...(a.details ? { details: a.details } : {}),
    ...(a.state ? { state: a.state } : {}),
    ...(a.start || a.end ? { timestamps: { ...(a.start ? { start: a.start } : {}), ...(a.end ? { end: a.end } : {}) } } : {}),
    ...(STATUS_DISPLAY_TYPES[a.statusShows] ? { status_display_type: STATUS_DISPLAY_TYPES[a.statusShows] } : {}),
    ...(a.partyMax != null ? { party: { size: [a.partySize, a.partyMax] } } : {}),
    ...(a.imageText || a.smallText ? { assets: { ...(a.imageText ? { large_text: a.imageText } : {}), ...(a.smallText ? { small_text: a.smallText } : {}) } } : {}),
  };
}

module.exports = {
  cleanActivities, cleanBotActivities, activitiesOf, remember, getActivities, discordActivity, storeImage, getImage,
  snapshot: () => Object.fromEntries(current),
  MAX_IMAGE_BYTES,
};
