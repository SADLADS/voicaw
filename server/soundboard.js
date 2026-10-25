const db = require('./db');
const config = require('./config');
const { PERMISSIONS, has } = require('./permissions');
const { ActionError } = require('./actionError');
const { getMember, getMemberIds, getChannelAccess } = require('./guilds');
const { sendToUserSockets } = require('./sockets');
const { getUploadUrl, getObject, putObject, deleteObject } = require('./s3');
const { logAudit } = require('./auditLog');
const { createLimiter } = require('./rateLimit');

// Soundboards (like Discord's; docs/voice-and-calls.md, Soundboard): each guild's short sounds,
// played to everyone in one of its voice channels. Shared by the app's routes
// (routes/soundboard.js) and the bot API (they throw ActionError).
//
// A sound is a plain file (not encrypted, like custom emoji) at sounds/<id> in the public
// "sounds" bucket, made in two steps like an emoji: createSound makes an unavailable row and
// signs an upload of the file to sounds/src/<id>; finishSound checks it's an MP3, Ogg or WAV,
// stores it as sounds/<id> and makes it available. Managing sounds takes Manage Emoji (Discord's
// Manage Expressions, which covers both).
//
// Playing one isn't mixed into anyone's microphone: the server tells everyone in the channel
// (`voice_channel_effect`), and each app plays the file itself, at its own soundboard volume
// (or not at all), as Discord's do. That takes being in the channel's voice with Speak and Use
// Soundboard, not deafened. A member's join sound (one of the guild's sounds) is played the
// same way when they join one of its voice channels (voice.js participantJoined).

const BUCKET = 'sounds';
const MAX_SOUNDS_PER_GUILD = 48;
// Discord's limit. Its 5.2 seconds can't be checked here without decoding the file: the apps
// cut sounds there when uploading and stop any longer one there when playing.
const MAX_SOUND_BYTES = 512 * 1024;
const MAX_NAME = 32;
const MIN_NAME = 2;
const MAX_EMOJI_LENGTH = 64;
const TYPES = new Set(['audio/mpeg', 'audio/ogg', 'audio/wav']);
// An upload that was never finished stops counting after this long.
const PENDING_TTL_SECONDS = 60 * 60;
// A join sound isn't played again for someone coming back to the same channel this soon (a
// dropped connection rejoining).
const JOIN_SOUND_GAP_MS = 30 * 1000;

const SOUND_COLUMNS = 's.id, s.guild_id, s.name, s.emoji, s.volume, s.creator_id, s.created_at';

const soundUrl = (id) => `${config.s3Endpoint}/${BUCKET}/${id}`;

// Three sounds in five seconds each, so nobody can drown a channel.
const plays = createLimiter({ windowMs: 5 * 1000, max: 3 });
// `${userId}:${channelId}` -> when their join sound last played there.
const joinSoundsPlayed = new Map();

// What the file is, from its first bytes (not what the uploader said): an MP3 (an ID3 tag or a
// frame's sync bits), Ogg or WAV, else null.
function sniffAudio(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const ascii = (start, end) => buffer.subarray(start, end).toString('latin1');
  if (ascii(0, 3) === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  return null;
}

function cleanName(value) {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (name.length < MIN_NAME || name.length > MAX_NAME) {
    throw new ActionError(400, `Sound names are ${MIN_NAME}–${MAX_NAME} characters`);
  }
  return name;
}

// Unicode, or a custom one as '<:name:id>'; null for none.
function cleanEmoji(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_EMOJI_LENGTH || /\s/.test(value)) throw new ActionError(400, 'Invalid emoji');
  return value;
}

function cleanVolume(value) {
  if (value == null) return 1;
  const volume = Number(value);
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new ActionError(400, 'Volume must be between 0 and 1');
  return volume;
}

function requireManage(member) {
  if (!has(member.permissions, PERMISSIONS.MANAGE_EMOJIS)) throw new ActionError(403, "You don't have permission to do that");
}

async function memberOf(guildId, userId) {
  const member = await getMember(guildId, userId);
  if (!member) throw new ActionError(404, 'Guild not found');
  return member;
}

// The guild's available sounds, oldest first.
function guildSounds(guildId) {
  return db.all(`SELECT ${SOUND_COLUMNS} FROM guild_sounds s WHERE s.guild_id = ? AND s.available = 1 ORDER BY s.id`, [guildId]);
}

async function findSound(guildId, soundId) {
  if (!Number.isInteger(soundId)) return null;
  return db.get(`SELECT ${SOUND_COLUMNS}, s.available FROM guild_sounds s WHERE s.id = ? AND s.guild_id = ?`, [soundId, guildId]);
}

const publicSound = ({ available, ...sound }) => sound;

// Every member gets the guild's sounds again (and their join sound, which a delete may have cleared).
async function announceSounds(guildId) {
  const sounds = await guildSounds(guildId);
  const joins = new Map((await db.all('SELECT user_id, join_sound_id FROM guild_members WHERE guild_id = ?', [guildId]))
    .map((r) => [r.user_id, r.join_sound_id]));
  for (const userId of await getMemberIds(guildId)) {
    sendToUserSockets(userId, { type: 'guild_soundboard_update', guildId, sounds, joinSoundId: joins.get(userId) ?? null });
  }
}

const audit = (guildId, actorId, action, soundId, details) => logAudit({
  guildId, actorId, action, targetType: 'sound', targetId: soundId, details,
});

// A member's view: { sounds, join_sound_id }.
async function listSounds(guildId, userId) {
  await memberOf(guildId, userId);
  const row = await db.get('SELECT join_sound_id FROM guild_members WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  return { sounds: await guildSounds(guildId), join_sound_id: row?.join_sound_id ?? null };
}

// Starts adding a sound: { name, emoji, volume, type, size } -> { sound, uploadUrl }. Then PUT
// the file to uploadUrl (its type and size are signed into it) and finishSound.
async function createSound(guildId, userId, { name: rawName, emoji: rawEmoji, volume: rawVolume, type, size: rawSize }) {
  const member = await memberOf(guildId, userId);
  requireManage(member);
  const name = cleanName(rawName);
  const emoji = cleanEmoji(rawEmoji);
  const volume = cleanVolume(rawVolume);
  if (!TYPES.has(type)) throw new ActionError(400, 'Sounds must be MP3, Ogg or WAV files');
  const size = Number(rawSize);
  if (!Number.isInteger(size) || size <= 0) throw new ActionError(400, 'Missing or invalid size');
  if (size > MAX_SOUND_BYTES) throw new ActionError(413, `Sounds must be under ${MAX_SOUND_BYTES / 1024} KB`);

  // Uploads that were never finished are forgotten (with any file left behind).
  const stale = await db.all(
    `SELECT id FROM guild_sounds WHERE guild_id = ? AND available = 0 AND created_at < strftime('%s','now') - ?`,
    [guildId, PENDING_TTL_SECONDS]
  );
  for (const { id } of stale) {
    await db.run('DELETE FROM guild_sounds WHERE id = ?', [id]);
    await deleteObject(BUCKET, `src/${id}`);
  }
  const { count } = await db.get('SELECT COUNT(*) AS count FROM guild_sounds WHERE guild_id = ?', [guildId]);
  if (count >= MAX_SOUNDS_PER_GUILD) throw new ActionError(400, `A guild can have at most ${MAX_SOUNDS_PER_GUILD} sounds`);

  const { lastID } = await db.run(
    'INSERT INTO guild_sounds (guild_id, name, emoji, volume, creator_id) VALUES (?, ?, ?, ?, ?)',
    [guildId, name, emoji, volume, userId]
  );
  let uploadUrl;
  try {
    uploadUrl = await getUploadUrl(`src/${lastID}`, BUCKET, type, size);
  } catch (err) {
    console.error(err);
    await db.run('DELETE FROM guild_sounds WHERE id = ?', [lastID]);
    throw new ActionError(500, 'Failed to generate upload URL');
  }
  const sound = await db.get(`SELECT ${SOUND_COLUMNS} FROM guild_sounds s WHERE s.id = ?`, [lastID]);
  return { sound, uploadUrl };
}

// The file is uploaded: if it's a sound, it becomes sounds/<id> and the sound is available to
// everyone; if not, the sound is dropped (400).
async function finishSound(guildId, userId, soundId) {
  requireManage(await memberOf(guildId, userId));
  const sound = await findSound(guildId, soundId);
  if (!sound) throw new ActionError(404, 'Sound not found');
  if (sound.available) return publicSound(sound);

  const source = `src/${sound.id}`;
  let file;
  try {
    file = await getObject(BUCKET, source);
  } catch (err) {
    console.error('Sound file missing:', err.code || err.name);
    throw new ActionError(400, "The sound wasn't uploaded. Try again.");
  }
  const contentType = file.length <= MAX_SOUND_BYTES ? sniffAudio(file) : null;
  if (!contentType) {
    await db.run('DELETE FROM guild_sounds WHERE id = ?', [sound.id]);
    await deleteObject(BUCKET, source);
    throw new ActionError(400, file.length > MAX_SOUND_BYTES ? 'That file is too big' : "That isn't an MP3, Ogg or WAV file");
  }

  await putObject(BUCKET, String(sound.id), file, contentType);
  await deleteObject(BUCKET, source);
  await db.transaction(async () => {
    await db.run('UPDATE guild_sounds SET available = 1, content_type = ? WHERE id = ?', [contentType, sound.id]);
    await audit(guildId, userId, 'sound_create', sound.id, { name: sound.name });
  });
  await announceSounds(guildId);
  return publicSound(sound);
}

// A sound made in one step from a data URI of its file (the bot API's create, Discord's way).
async function createSoundFromData(guildId, userId, { name: rawName, emoji: rawEmoji, volume: rawVolume, data }) {
  requireManage(await memberOf(guildId, userId));
  const name = cleanName(rawName);
  const emoji = cleanEmoji(rawEmoji);
  const volume = cleanVolume(rawVolume);
  const match = typeof data === 'string' && data.match(/^data:audio\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) throw new ActionError(400, 'Invalid sound data');
  const file = Buffer.from(match[1], 'base64');
  if (file.length > MAX_SOUND_BYTES) throw new ActionError(413, `Sounds must be under ${MAX_SOUND_BYTES / 1024} KB`);
  const contentType = sniffAudio(file);
  if (!contentType) throw new ActionError(400, "That isn't an MP3, Ogg or WAV file");
  const { count } = await db.get('SELECT COUNT(*) AS count FROM guild_sounds WHERE guild_id = ?', [guildId]);
  if (count >= MAX_SOUNDS_PER_GUILD) throw new ActionError(400, `A guild can have at most ${MAX_SOUNDS_PER_GUILD} sounds`);

  const { lastID: soundId } = await db.run(
    'INSERT INTO guild_sounds (guild_id, name, emoji, volume, content_type, creator_id) VALUES (?, ?, ?, ?, ?, ?)',
    [guildId, name, emoji, volume, contentType, userId]
  );
  try {
    await putObject(BUCKET, String(soundId), file, contentType);
  } catch (err) {
    await db.run('DELETE FROM guild_sounds WHERE id = ?', [soundId]);
    throw err;
  }
  await db.transaction(async () => {
    await db.run('UPDATE guild_sounds SET available = 1 WHERE id = ?', [soundId]);
    await audit(guildId, userId, 'sound_create', soundId, { name });
  });
  await announceSounds(guildId);
  return publicSound(await findSound(guildId, soundId));
}

// Changes any of { name, emoji, volume } (the file stays).
async function updateSound(guildId, userId, soundId, changes) {
  requireManage(await memberOf(guildId, userId));
  const sound = await findSound(guildId, soundId);
  if (!sound?.available) throw new ActionError(404, 'Sound not found');
  const next = {
    name: changes.name === undefined ? sound.name : cleanName(changes.name),
    emoji: changes.emoji === undefined ? sound.emoji : cleanEmoji(changes.emoji),
    volume: changes.volume === undefined ? sound.volume : cleanVolume(changes.volume),
  };
  const changed = Object.fromEntries(Object.keys(next).filter((key) => next[key] !== sound[key]).map((key) => [key, [sound[key], next[key]]]));
  if (Object.keys(changed).length) {
    await db.transaction(async () => {
      await db.run('UPDATE guild_sounds SET name = ?, emoji = ?, volume = ? WHERE id = ?', [next.name, next.emoji, next.volume, sound.id]);
      await audit(guildId, userId, 'sound_update', sound.id, { name: next.name, changes: changed });
    });
    await announceSounds(guildId);
  }
  return publicSound({ ...sound, ...next });
}

// Deletes the sound and its file; members who had it as their join sound have none.
async function deleteSound(guildId, userId, soundId) {
  requireManage(await memberOf(guildId, userId));
  const sound = await findSound(guildId, soundId);
  if (!sound) throw new ActionError(404, 'Sound not found');
  await db.transaction(async () => {
    await db.run('DELETE FROM guild_sounds WHERE id = ?', [sound.id]);
    await db.run('UPDATE guild_members SET join_sound_id = NULL WHERE guild_id = ? AND join_sound_id = ?', [guildId, sound.id]);
    if (sound.available) await audit(guildId, userId, 'sound_delete', sound.id, { name: sound.name });
  });
  await deleteObject(BUCKET, sound.available ? String(sound.id) : `src/${sound.id}`);
  await announceSounds(guildId);
}

// The caller's join sound in this guild: one of its sounds, or null for none. Their other
// devices follow (`guild_join_sound`).
async function setJoinSound(guildId, userId, soundId) {
  await memberOf(guildId, userId);
  if (soundId != null) {
    const sound = await findSound(guildId, soundId);
    if (!sound?.available) throw new ActionError(404, 'Sound not found');
  }
  await db.run('UPDATE guild_members SET join_sound_id = ? WHERE guild_id = ? AND user_id = ?', [soundId ?? null, guildId, userId]);
  sendToUserSockets(userId, { type: 'guild_join_sound', guildId, soundId: soundId ?? null });
  return soundId ?? null;
}

// Everyone in the channel's voice who can hear it gets the sound to play (`join`: it's
// `userId`'s join sound). Bots in there get Discord's VOICE_CHANNEL_EFFECT_SEND (gateway.js).
function broadcast({ guildId, channelId, userId, sound, join }) {
  const event = {
    type: 'voice_channel_effect',
    guildId,
    channelId,
    userId,
    join,
    sound: { id: sound.id, guild_id: sound.guild_id, name: sound.name, emoji: sound.emoji, volume: sound.volume },
  };
  for (const state of require('./voice').states.values()) {
    if (state.channelId === channelId && state.canListen !== false) sendToUserSockets(state.userId, event);
  }
}

const canPlay = (permissions) => has(permissions, PERMISSIONS.SPEAK | PERMISSIONS.USE_SOUNDBOARD);

// `userId` plays one of the guild's sounds in the voice channel they're in (`channelId`; on
// any device). -> the sound.
async function playSound(userId, channelId, soundId) {
  const state = require('./voice').states.get(userId);
  if (!state || state.channelId !== channelId) throw new ActionError(400, "You're not in that voice channel");
  if (state.selfDeaf) throw new ActionError(400, "You can't play sounds while deafened");
  const access = await getChannelAccess(channelId, userId);
  if (!access || !canPlay(access.permissions)) throw new ActionError(403, "You don't have permission to do that");
  const sound = await findSound(access.channel.guild_id, soundId);
  if (!sound?.available) throw new ActionError(404, 'Sound not found');
  if (config.rateLimitsEnabled && !plays.hit(String(userId)).allowed) {
    throw new ActionError(429, 'Wait a moment before playing another sound');
  }
  broadcast({ guildId: sound.guild_id, channelId, userId, sound: publicSound(sound), join: false });
  return publicSound(sound);
}

// `state` (voice.js) just joined its channel: their join sound plays there, if they have one
// and may use the soundboard there.
async function playJoinSound(state) {
  const key = `${state.userId}:${state.channelId}`;
  const now = Date.now();
  if (now - (joinSoundsPlayed.get(key) ?? -Infinity) < JOIN_SOUND_GAP_MS) return;
  const row = await db.get('SELECT join_sound_id FROM guild_members WHERE guild_id = ? AND user_id = ?', [state.guildId, state.userId]);
  if (row?.join_sound_id == null) return;
  const sound = await findSound(state.guildId, row.join_sound_id);
  if (!sound?.available) return;
  const access = await getChannelAccess(state.channelId, state.userId);
  if (!access || !canPlay(access.permissions)) return;
  joinSoundsPlayed.set(key, now);
  if (joinSoundsPlayed.size > 10000) {
    for (const [k, at] of joinSoundsPlayed) if (now - at >= JOIN_SOUND_GAP_MS) joinSoundsPlayed.delete(k);
  }
  broadcast({ guildId: state.guildId, channelId: state.channelId, userId: state.userId, sound: publicSound(sound), join: true });
}

// The guild is being deleted: its sounds' files go (its rows go with the guild's tables).
async function deleteGuildSoundFiles(guildId) {
  const sounds = await db.all('SELECT id, available FROM guild_sounds WHERE guild_id = ?', [guildId]);
  for (const { id, available } of sounds) await deleteObject(BUCKET, available ? String(id) : `src/${id}`);
}

module.exports = {
  BUCKET,
  MAX_SOUNDS_PER_GUILD,
  MAX_SOUND_BYTES,
  soundUrl,
  sniffAudio,
  guildSounds,
  findSound,
  listSounds,
  createSound,
  finishSound,
  createSoundFromData,
  updateSound,
  deleteSound,
  setJoinSound,
  playSound,
  playJoinSound,
  deleteGuildSoundFiles,
};
