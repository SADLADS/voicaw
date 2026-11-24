const db = require('./db');
const { PERMISSIONS, has, guildPermissions, channelPermissions } = require('./permissions');

// Category permission overrides (docs/guilds.md, Category permissions), Discord's copy-and-sync
// model: a category has overrides of its own (guild_category_overrides), but a channel's
// permissions always come from its own overrides only. The category's are copied into its
// channels: a new channel starts with them, a change to them goes to every channel that was
// synced (its overrides exactly the category's: worked out by comparing, nothing stored), and a
// synced channel moved into another category takes that one's. Database work only: callers run
// these in their transactions.

const COLUMNS = 'target_type, target_id, allow, deny';

async function categoryOverrides(categoryId) {
  return db.all(`SELECT ${COLUMNS} FROM guild_category_overrides WHERE category_id = ? ORDER BY target_type DESC, target_id`, [categoryId]);
}

async function channelOverrides(channelId) {
  return db.all(`SELECT ${COLUMNS} FROM guild_channel_overrides WHERE channel_id = ? ORDER BY target_type DESC, target_id`, [channelId]);
}

// Every category's overrides in the guild, by category id.
async function guildCategoryOverrides(guildId) {
  const rows = await db.all(
    `SELECT o.category_id, o.target_type, o.target_id, o.allow, o.deny FROM guild_category_overrides o
     JOIN guild_categories c ON c.id = o.category_id WHERE c.guild_id = ?`,
    [guildId]
  );
  const byCategory = new Map();
  for (const row of rows) {
    if (!byCategory.has(row.category_id)) byCategory.set(row.category_id, []);
    byCategory.get(row.category_id).push(row);
  }
  return byCategory;
}

const keyOf = (o) => `${o.target_type}:${o.target_id}`;

// Whether two override lists are the same set (empty rows don't count).
function sameOverrides(a = [], b = []) {
  const real = (list) => list.filter((o) => o.allow || o.deny);
  const left = real(a);
  const right = new Map(real(b).map((o) => [keyOf(o), o]));
  return left.length === right.size && left.every((o) => {
    const other = right.get(keyOf(o));
    return other && other.allow === o.allow && other.deny === o.deny;
  });
}

// Whether a channel ({ category_id }, its overrides) is synced with its category's.
function isSynced(channel, overrides, categoryOverridesList) {
  return channel.category_id != null && sameOverrides(overrides, categoryOverridesList);
}

// The targets whose override differs between `before` and `after`, with the bits that change.
function changesBetween(before, after) {
  const targets = new Map();
  for (const o of [...before, ...after]) targets.set(keyOf(o), { target_type: o.target_type, target_id: o.target_id });
  const find = (list, key) => list.find((o) => keyOf(o) === key) ?? { allow: 0, deny: 0 };
  return [...targets.entries()]
    .map(([key, target]) => {
      const was = find(before, key);
      const now = find(after, key);
      return { ...target, bits: (was.allow ^ now.allow) | (was.deny ^ now.deny) };
    })
    .filter((c) => c.bits);
}

// Why `actor` (a member context) may not turn a channel's overrides from `before` into `after`,
// or null if they may: the same rules as changing one override by hand (routes/guildRoles.js
// setOverride): Manage Roles, only roles below theirs and members they outrank (or themselves),
// and only bits they have in the channel as it is.
async function whyNotChange(actor, before, after) {
  const changes = changesBetween(before, after);
  if (!changes.length) return null;
  if (!has(guildPermissions(actor), PERMISSIONS.MANAGE_ROLES)) return "You don't have permission to do that";
  const here = channelPermissions(actor, actor.userId, before);
  if (changes.some((c) => (c.bits & ~here) !== 0)) return "You can't change permissions you don't have here";
  const { getMember } = require('./guilds');
  for (const c of changes) {
    if (c.target_type === 'role') {
      const role = actor.allRoles.find((r) => r.id === c.target_id);
      if (role && role.position >= actor.highest) return 'That role is as high as yours or higher';
    } else if (c.target_id !== actor.userId) {
      const target = await getMember(actor.guild.id, c.target_id);
      if (target && (target.isOwner || actor.highest <= target.highest)) return 'Their role is as high as yours or higher';
    }
  }
  return null;
}

// Makes the channel's overrides exactly `rows`.
async function replaceChannelOverrides(channelId, rows) {
  await db.run('DELETE FROM guild_channel_overrides WHERE channel_id = ?', [channelId]);
  for (const o of rows) {
    if (!o.allow && !o.deny) continue;
    await db.run(
      'INSERT INTO guild_channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES (?, ?, ?, ?, ?)',
      [channelId, o.target_type, o.target_id, o.allow, o.deny]
    );
  }
}

// Sets one target's row in a list of overrides (none: removed); returns the new list.
function withRow(list, targetType, targetId, allow, deny) {
  const rest = list.filter((o) => !(o.target_type === targetType && o.target_id === targetId));
  return allow || deny ? [...rest, { target_type: targetType, target_id: targetId, allow, deny }] : rest;
}

// A channel moving from category `fromId` to `toId` (either null: none), by `actor`. Called in
// the move's transaction, before or after the category_id itself changes. `lock`: undefined
// takes the new category's overrides if the channel was synced with its old one (or had no
// category and no overrides) and the actor may make that change (else it keeps its own);
// true always takes them (throwing an ActionError if the actor may not); false keeps its own.
// Resolves to whether its overrides changed.
async function syncOnMove(actor, channelId, fromId, toId, lock) {
  if (lock === false || toId == null || (fromId === toId && lock !== true)) return false;
  const own = await channelOverrides(channelId);
  if (lock !== true) {
    const wasSynced = fromId == null ? own.length === 0 : sameOverrides(own, await categoryOverrides(fromId));
    if (!wasSynced) return false;
  }
  const target = await categoryOverrides(toId);
  if (sameOverrides(own, target)) return false;
  const why = await whyNotChange(actor, own, target);
  if (why) {
    if (lock === true) {
      const { ActionError } = require('./actionError');
      throw new ActionError(403, why);
    }
    return false;
  }
  await replaceChannelOverrides(channelId, target);
  return true;
}

// Deletes the overrides of the given categories (an SQL list of ids and its params).
async function deleteCategoryOverrides(categoryIdsSql, params) {
  await db.run(`DELETE FROM guild_category_overrides WHERE category_id IN (${categoryIdsSql})`, params);
}

module.exports = {
  categoryOverrides,
  channelOverrides,
  guildCategoryOverrides,
  sameOverrides,
  isSynced,
  whyNotChange,
  replaceChannelOverrides,
  withRow,
  syncOnMove,
  deleteCategoryOverrides,
};
