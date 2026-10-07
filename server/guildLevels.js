const db = require('./db');
const { PERMISSIONS, has } = require('./permissions');
const { ActionError } = require('./actionError');
const { logAudit } = require('./auditLog');

// Levels, like Guilded's XP: members earn XP in a guild for what they do there, and every
// `xpPerLevel` XP is a level (1: levels only, and the app never mentions XP). Each guild chooses
// what earns XP and how much (Manage Guild), what XP and levels are called, and can turn it all
// off; Manage Levels sets anyone's XP or level (the app's member card, and bots). Bots and
// webhooks never earn XP (a bot can be given some). Shared by routes/guildLevels.js and the bot
// API; the actions throw ActionError.
//
// Settings are `guilds.levels` (JSON; null = DEFAULT_SETTINGS). XP is guild_member_xp, kept when
// someone leaves (it's theirs again if they come back), deleted with the guild or the account.
// A change of level (and any change made by hand) is sent to the guild as
// guild_member_xp { guildId, userId, xp, level, previousLevel }.

// What earns XP, in the order the settings list them, with the defaults: on for what everyone
// does in a chat, off for the rest.
const SOURCES = {
  message: { enabled: true, xp: 10 }, // sending a message (at most once per `messageCooldown`)
  replyReceived: { enabled: true, xp: 5 }, // someone else replies to your message
  reactionReceived: { enabled: true, xp: 5 }, // someone else reacts to your message (once each per message)
  mentionReceived: { enabled: false, xp: 5 }, // someone else mentions you by name (<@id>)
  reactionGiven: { enabled: false, xp: 1 }, // reacting to someone else's message (once per message)
  threadCreated: { enabled: false, xp: 10 }, // starting a thread
  documentCreated: { enabled: false, xp: 20 }, // writing a document (document channels)
  taskCompleted: { enabled: false, xp: 10 }, // completing a task (list channels; once per task)
  voiceMinute: { enabled: false, xp: 2 }, // each minute in a voice channel with someone else, not deafened
};

const DEFAULT_SETTINGS = {
  enabled: true,
  xpPerLevel: 100,
  // Empty: the app's own words ("XP", "Level", "lvl", translated).
  xpName: '',
  levelName: '',
  levelShort: '',
  showInMemberList: true, // the level next to each picture in the member list
  messageCooldown: 60, // seconds
  sources: SOURCES,
};

const MAX_XP = 1e12;
const MAX_XP_PER_LEVEL = 1e6;
const MAX_SOURCE_XP = 1e6;
const MAX_COOLDOWN = 3600;
const NAME_LIMITS = { xpName: 32, levelName: 32, levelShort: 12 };
const AWARD_KEEP_SECONDS = 90 * 24 * 60 * 60;

const now = () => Math.floor(Date.now() / 1000);
const isWhole = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

// The settings stored as `json`, with the defaults for anything missing.
function parseSettings(json) {
  let stored = {};
  try {
    stored = json ? JSON.parse(json) : {};
  } catch {
    stored = {};
  }
  const sources = {};
  for (const [key, fallback] of Object.entries(SOURCES)) sources[key] = { ...fallback, ...stored.sources?.[key] };
  return { ...DEFAULT_SETTINGS, ...stored, sources };
}

async function getSettings(guildId) {
  const row = await db.get('SELECT levels FROM guilds WHERE id = ?', [guildId]);
  return parseSettings(row?.levels);
}

const levelOf = (xp, settings) => Math.floor(xp / settings.xpPerLevel);

const invalid = (message) => new ActionError(400, message);

// `current` with `patch` applied ({ enabled?, xpPerLevel?, xpName?, levelName?, levelShort?,
// showInMemberList?, messageCooldown?, sources?: { [source]: { enabled?, xp? } } }). Throws on
// anything that doesn't fit.
function applyPatch(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('Invalid level settings');
  const next = { ...current, sources: { ...current.sources } };
  for (const key of ['enabled', 'showInMemberList']) {
    if (patch[key] === undefined) continue;
    if (typeof patch[key] !== 'boolean') throw invalid(`${key} must be true or false`);
    next[key] = patch[key];
  }
  if (patch.xpPerLevel !== undefined) {
    if (!isWhole(patch.xpPerLevel, 1, MAX_XP_PER_LEVEL)) throw invalid(`XP per level is 1–${MAX_XP_PER_LEVEL}`);
    next.xpPerLevel = patch.xpPerLevel;
  }
  if (patch.messageCooldown !== undefined) {
    if (!isWhole(patch.messageCooldown, 0, MAX_COOLDOWN)) throw invalid(`The message cooldown is 0–${MAX_COOLDOWN} seconds`);
    next.messageCooldown = patch.messageCooldown;
  }
  for (const [key, max] of Object.entries(NAME_LIMITS)) {
    if (patch[key] === undefined) continue;
    if (patch[key] !== null && typeof patch[key] !== 'string') throw invalid(`${key} must be text`);
    // eslint-disable-next-line no-control-regex
    const name = (patch[key] ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
    if (name.length > max) throw invalid(`${key} is at most ${max} characters`);
    next[key] = name;
  }
  if (patch.sources !== undefined) {
    if (!patch.sources || typeof patch.sources !== 'object' || Array.isArray(patch.sources)) throw invalid('Invalid XP sources');
    for (const [key, change] of Object.entries(patch.sources)) {
      if (!Object.hasOwn(SOURCES, key)) throw invalid(`Unknown XP source: ${key}`);
      if (!change || typeof change !== 'object') throw invalid(`Invalid XP source: ${key}`);
      const source = { ...next.sources[key] };
      if (change.enabled !== undefined) {
        if (typeof change.enabled !== 'boolean') throw invalid(`${key}.enabled must be true or false`);
        source.enabled = change.enabled;
      }
      if (change.xp !== undefined) {
        if (!isWhole(change.xp, 0, MAX_SOURCE_XP)) throw invalid(`${key}.xp is 0–${MAX_SOURCE_XP}`);
        source.xp = change.xp;
      }
      next.sources[key] = source;
    }
  }
  return next;
}

// What changed between two settings, as the audit log keeps it: { 'sources.message.xp': [before, after] }.
function settingsChanges(before, after) {
  const changes = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key === 'sources') continue;
    if (before[key] !== after[key]) changes[key] = [before[key], after[key]];
  }
  for (const key of Object.keys(SOURCES)) {
    for (const field of ['enabled', 'xp']) {
      if (before.sources[key][field] !== after.sources[key][field]) {
        changes[`sources.${key}.${field}`] = [before.sources[key][field], after.sources[key][field]];
      }
    }
  }
  return changes;
}

// Changes the guild's settings (Manage Guild). `member` is the one changing them (guilds.js
// getMember). Resolves to the new settings; the caller announces the guild's new layout.
async function updateSettings(member, patch) {
  if (!has(member.permissions, PERMISSIONS.MANAGE_GUILD)) throw new ActionError(403, "You don't have permission to do that");
  const guildId = member.guild.id;
  return db.transaction(async () => {
    const before = await getSettings(guildId);
    const after = applyPatch(before, patch);
    const changes = settingsChanges(before, after);
    if (Object.keys(changes).length === 0) return before;
    await db.run('UPDATE guilds SET levels = ? WHERE id = ?', [JSON.stringify(after), guildId]);
    await logAudit({ guildId, action: 'levels_update', actorId: member.userId, details: { changes } });
    return after;
  });
}

// ---- Members' XP ----

// { user_id, xp, level, rank } for `userId` in the guild (rank among its members, 1 the most
// XP; ties share one; null with no XP).
async function memberLevel(guildId, userId, settings = null) {
  settings ??= await getSettings(guildId);
  const row = await db.get('SELECT xp FROM guild_member_xp WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  const xp = row?.xp ?? 0;
  const ahead = xp > 0 && await db.get(
    `SELECT COUNT(*) AS count FROM guild_member_xp x JOIN guild_members gm ON gm.guild_id = x.guild_id AND gm.user_id = x.user_id
     WHERE x.guild_id = ? AND x.xp > ?`,
    [guildId, xp]
  );
  return { user_id: userId, xp, level: levelOf(xp, settings), rank: xp > 0 ? ahead.count + 1 : null };
}

// The guild's members with XP, most first: [{ user_id, xp, level, rank, username, display_name,
// avatar }] (names and pictures so the app can draw people it hasn't met yet).
async function leaderboard(guildId, { limit = 100, offset = 0 } = {}) {
  const settings = await getSettings(guildId);
  const rows = await db.all(
    `SELECT x.user_id, x.xp, u.username, u.display_name, u.avatar,
       (SELECT COUNT(*) FROM guild_member_xp o JOIN guild_members om ON om.guild_id = o.guild_id AND om.user_id = o.user_id
        WHERE o.guild_id = x.guild_id AND o.xp > x.xp) + 1 AS rank
     FROM guild_member_xp x JOIN guild_members gm ON gm.guild_id = x.guild_id AND gm.user_id = x.user_id
     JOIN users u ON u.id = x.user_id
     WHERE x.guild_id = ? AND x.xp > 0 ORDER BY x.xp DESC, x.user_id LIMIT ? OFFSET ?`,
    [guildId, limit, offset]
  );
  return rows.map((row) => ({ ...row, level: levelOf(row.xp, settings) }));
}

// Each member's XP, by user id (the member list).
async function xpByMember(guildId) {
  const rows = await db.all('SELECT user_id, xp FROM guild_member_xp WHERE guild_id = ?', [guildId]);
  return new Map(rows.map((r) => [r.user_id, r.xp]));
}

// Tells the guild (the app and bots' gateway) that `userId` has `after` XP, if their level
// changed or `always`.
async function announce(guildId, userId, before, after, settings, always = false) {
  const previousLevel = levelOf(before, settings);
  const level = levelOf(after, settings);
  if (!always && level === previousLevel) return;
  const { sendToGuild } = require('./guilds');
  await sendToGuild(guildId, { type: 'guild_member_xp', guildId, userId, xp: after, level, previousLevel });
}

// The XP after `change`, one of { xp } or { level } (set), { addXp } or { addLevels } (add; less
// than 0 takes away). Setting a level puts them at its start. Never below 0 or above MAX_XP.
function changedXp(xp, change, settings) {
  const given = ['xp', 'level', 'addXp', 'addLevels'].filter((key) => change?.[key] !== undefined && change[key] !== null);
  if (given.length !== 1) throw invalid('Give one of xp, level, addXp or addLevels');
  const [key] = given;
  const value = change[key];
  if (!Number.isSafeInteger(value)) throw invalid(`${key} must be a whole number`);
  const perLevel = settings.xpPerLevel;
  const next = {
    xp: () => value,
    level: () => value * perLevel,
    addXp: () => xp + value,
    addLevels: () => xp + value * perLevel,
  }[key]();
  if ((key === 'xp' || key === 'level') && value < 0) throw invalid(`${key} can't be below 0`);
  return Math.min(Math.max(next, 0), MAX_XP);
}

// Sets or adds to `userId`'s XP or level (Manage Levels; see changedXp). Resolves to their
// memberLevel.
async function changeMemberXp(member, userId, change) {
  if (!has(member.permissions, PERMISSIONS.MANAGE_LEVELS)) throw new ActionError(403, "You don't have permission to do that");
  const guildId = member.guild.id;
  const target = Number.isInteger(userId) && await db.get('SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  if (!target) throw new ActionError(404, 'Unknown Member', 10007);
  const settings = await getSettings(guildId);
  const { before, after } = await db.transaction(async () => {
    const row = await db.get('SELECT xp FROM guild_member_xp WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    const xp = row?.xp ?? 0;
    const next = changedXp(xp, change, settings);
    await db.run(
      `INSERT INTO guild_member_xp (guild_id, user_id, xp) VALUES (?, ?, ?)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET xp = excluded.xp`,
      [guildId, userId, next]
    );
    if (next !== xp) {
      await logAudit({
        guildId, action: 'member_xp_update', actorId: member.userId, targetType: 'user', targetId: userId,
        details: { before: xp, after: next },
      });
    }
    return { before: xp, after: next };
  });
  if (before !== after) await announce(guildId, userId, before, after, settings, true);
  return memberLevel(guildId, userId, settings);
}

// Gives `userId` the XP `source` earns in the guild, if the guild has levels and that source on,
// they're a member and not a bot. `key` (unique in the guild) makes it happen once: the same key
// again earns nothing. `times` multiplies it. Never throws (earning XP mustn't break what earned
// it): failures are logged.
async function award(guildId, userId, source, { key = null, times = 1 } = {}) {
  try {
    const settings = await getSettings(guildId);
    const amount = settings.sources[source]?.enabled ? settings.sources[source].xp * times : 0;
    if (!settings.enabled || amount <= 0) return;
    const who = await db.get(
      'SELECT u.bot FROM guild_members gm JOIN users u ON u.id = gm.user_id WHERE gm.guild_id = ? AND gm.user_id = ?',
      [guildId, userId]
    );
    if (!who || who.bot) return;
    const result = await db.transaction(async () => {
      const time = now();
      if (key) {
        const { changes } = await db.run(
          'INSERT OR IGNORE INTO guild_xp_awards (guild_id, award_key, created_at) VALUES (?, ?, ?)',
          [guildId, key, time]
        );
        if (!changes) return null;
      }
      await db.run('INSERT OR IGNORE INTO guild_member_xp (guild_id, user_id, xp) VALUES (?, ?, 0)', [guildId, userId]);
      const row = await db.get('SELECT xp, message_xp_at FROM guild_member_xp WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
      if (source === 'message' && row.message_xp_at != null && time - row.message_xp_at < settings.messageCooldown) return null;
      const xp = Math.min(row.xp + amount, MAX_XP);
      await db.run(
        `UPDATE guild_member_xp SET xp = ?${source === 'message' ? ', message_xp_at = ?' : ''} WHERE guild_id = ? AND user_id = ?`,
        source === 'message' ? [xp, time, guildId, userId] : [xp, guildId, userId]
      );
      return { before: row.xp, after: xp };
    });
    if (result) await announce(guildId, userId, result.before, result.after, settings);
  } catch (err) {
    console.error('Awarding XP failed:', err.message);
  }
}

// What a new guild message earns: its sender's message XP, a reply's author replyReceived and
// whoever it names mentionReceived (never for the sender's own). `message` is the app's row
// (sender_id, parent_sender_id, system); `mentionedIds` the user ids it names.
async function awardMessage(guildId, message, mentionedIds = []) {
  if (message.system || !message.sender_id) return;
  await award(guildId, message.sender_id, 'message');
  const parentSender = message.parent_sender_id;
  if (parentSender && parentSender !== message.sender_id && !(await isBot(message.sender_id))) {
    await award(guildId, parentSender, 'replyReceived');
  }
  const named = [...new Set(mentionedIds)].filter((id) => id !== message.sender_id && id !== parentSender);
  if (named.length && !(await isBot(message.sender_id))) {
    for (const id of named.slice(0, 50)) await award(guildId, id, 'mentionReceived');
  }
}

// A reaction from `userId` on `message` (id, sender_id): reactionReceived for its author and
// reactionGiven for them, each once per person and message. Bots' reactions earn nothing.
async function awardReaction(guildId, message, userId) {
  if (!message.sender_id || message.sender_id === userId || await isBot(userId)) return;
  await award(guildId, message.sender_id, 'reactionReceived', { key: `reacted:${message.id}:${userId}` });
  await award(guildId, userId, 'reactionGiven', { key: `gave:${message.id}:${userId}` });
}

async function isBot(userId) {
  const row = await db.get('SELECT bot FROM users WHERE id = ?', [userId]);
  return Boolean(row?.bot);
}

// ---- Voice, and tidying up ----

// Every minute: voiceMinute for everyone in a voice channel with at least one other person
// (bots don't count), unless they've deafened themselves.
async function awardVoiceMinute() {
  const states = require('./voice').allStates();
  const people = new Map();
  for (const state of states) {
    if (await isBot(state.userId)) continue;
    people.set(state.channelId, [...(people.get(state.channelId) ?? []), state]);
  }
  for (const list of people.values()) {
    if (list.length < 2) continue;
    for (const state of list) if (!state.selfDeaf) await award(state.guildId, state.userId, 'voiceMinute');
  }
}

async function pruneAwards() {
  await db.run('DELETE FROM guild_xp_awards WHERE created_at < ?', [now() - AWARD_KEEP_SECONDS]);
}

function startLevelTimers() {
  setInterval(() => awardVoiceMinute().catch((err) => console.error('Voice XP failed:', err.message)), 60 * 1000).unref();
  setInterval(() => pruneAwards().catch((err) => console.error('Pruning XP awards failed:', err.message)), 60 * 60 * 1000).unref();
}

// Inside the transactions that delete a guild or an account.
async function deleteGuildLevels(guildId) {
  await db.run('DELETE FROM guild_member_xp WHERE guild_id = ?', [guildId]);
  await db.run('DELETE FROM guild_xp_awards WHERE guild_id = ?', [guildId]);
}
async function deleteUserLevels(userId) {
  await db.run('DELETE FROM guild_member_xp WHERE user_id = ?', [userId]);
}

module.exports = {
  SOURCES,
  DEFAULT_SETTINGS,
  MAX_XP,
  parseSettings,
  getSettings,
  levelOf,
  updateSettings,
  memberLevel,
  leaderboard,
  xpByMember,
  changeMemberXp,
  award,
  awardMessage,
  awardReaction,
  awardVoiceMinute,
  pruneAwards,
  startLevelTimers,
  deleteGuildLevels,
  deleteUserLevels,
};
