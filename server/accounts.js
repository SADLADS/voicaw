const db = require('./db');
const groups = require('./groupDms');
const { deleteGuild, removeMember } = require('./guilds');
const { clients, sendToUserSockets, sendToAllSockets } = require('./sockets');
const { PROFILE_COLUMNS } = require('./profiles');
const { removeAvatar } = require('./avatars');

// Deleting an account (Settings → Delete account), like Discord: the person is gone, but what
// they wrote stays, under "Deleted User". Their `users` row stays as a tombstone (so messages,
// reactions and group logs still point at someone): name, password, key backups, recovery
// code, profile and picture go, and `deleted_at` is set, which makes every token of theirs
// invalid (auth.js) and their old username free. The public keys stay: their contacts still
// need them to open the DMs they had (the server never had anything else of theirs to hide).
//
// Before it can go:
// - guilds they own must be handed over or deleted (`deleteOwnedGuilds` deletes them);
// - they leave every group DM: only they can sign that (the membership log), so the client
//   sends a signed `leave` entry per group (`groupLeaves: { groupId: entry }`), and they're
//   all checked before anything changes.

const DELETED_NAME = 'Deleted User';

class DeletionError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// The guilds `userId` owns: [{ id, name }].
const ownedGuilds = (userId) => db.all('SELECT id, name FROM guilds WHERE owner = ? ORDER BY id', [userId]);

// Checks that `userId` can be deleted as asked, changing nothing. Resolves to the plan for
// deleteAccount; throws a DeletionError (409 `owns_guilds` with the guilds, or 409
// `groups_changed` when the leave entries don't match the groups as they are now).
async function checkDeletion(userId, { deleteOwnedGuilds = false, groupLeaves = {} } = {}) {
  const guilds = await ownedGuilds(userId);
  if (guilds.length && deleteOwnedGuilds !== true) {
    throw new DeletionError(409, 'Transfer ownership of your guilds or delete them first', { code: 'owns_guilds', guilds });
  }
  if (!groupLeaves || typeof groupLeaves !== 'object') throw new DeletionError(400, 'Invalid group leaves');

  const rows = await db.all('SELECT group_id FROM group_dm_members WHERE user_id = ?', [userId]);
  const leaves = [];
  for (const { group_id: groupId } of rows) {
    const state = await groups.groupState(groupId);
    let r;
    try {
      r = await groups.checkEntry(state, groupLeaves[groupId], userId);
    } catch (err) {
      if (!(err instanceof groups.GroupError)) throw err;
      r = null;
    }
    if (r?.type !== 'leave') {
      throw new DeletionError(409, 'Your group DMs changed meanwhile; try again', { code: 'groups_changed' });
    }
    leaves.push({ state, entry: groupLeaves[groupId], r, before: new Set(state.members) });
  }
  return { guilds, leaves };
}

// Deletes `userId`'s account as checked by checkDeletion (`plan`).
async function deleteAccount(userId, plan) {
  // Calls and voice first: they're in memory and in LiveKit, not in the database.
  const calls = require('./calls');
  await calls.endCallOf(userId);
  await require('./voice').disconnect(userId);
  for (const guild of plan.guilds) await deleteGuild(guild.id);
  // Their bots go too: out of every guild, their tokens dead (bots.js; the bot users stay as
  // deleted accounts, so their messages keep an author).
  const bots = require('./bots');
  for (const application of await db.all('SELECT * FROM bot_applications WHERE owner_id = ?', [userId])) {
    await bots.deleteApplication(application);
  }

  const user = await db.get('SELECT username FROM users WHERE id = ?', [userId]);
  await db.transaction(async () => {
    for (const { state, entry, r } of plan.leaves) {
      groups.applyToState(state, entry, r);
      await groups.storeEntry(state.group.id, entry, r);
      if (state.members.size === 0) await groups.deleteGroup(state.group.id);
    }
    // Notes are a DM to yourself: nobody else can read them.
    await db.run(
      "DELETE FROM poll_timers WHERE kind = 'dm' AND message_id IN (SELECT id FROM direct_messages WHERE sender_id = ? AND recipient_id = ?)",
      [userId, userId]
    );
    await db.run(
      'DELETE FROM dm_reactions WHERE message_id IN (SELECT id FROM direct_messages WHERE sender_id = ? AND recipient_id = ?)',
      [userId, userId]
    );
    await db.run('DELETE FROM direct_messages WHERE sender_id = ? AND recipient_id = ?', [userId, userId]);
    for (const sql of [
      'DELETE FROM dm_unread WHERE user_id = ?',
      'DELETE FROM push_subscriptions WHERE user_id = ?',
      'DELETE FROM sessions WHERE user_id = ?',
      'DELETE FROM gif_favorites WHERE user_id = ?',
      'DELETE FROM conversation_settings WHERE user_id = ?',
      'DELETE FROM guild_mentions WHERE user_id = ?',
      'DELETE FROM guild_member_xp WHERE user_id = ?', // their XP in every guild (guildLevels.js)
    ]) {
      await db.run(sql, [userId]);
    }
    // Their blocks, both ways (reports about or by them stay: they're moderation records, kept
    // until a year after they're resolved, reports.js).
    await db.run('DELETE FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?', [userId, userId]);
    await db.run('DELETE FROM webhook_blocks WHERE user_id = ?', [userId]);
    // Their friends and friend requests, both ways (friends.js).
    await db.run('DELETE FROM friends WHERE user_id = ? OR friend_id = ?', [userId, userId]);
    await db.run('DELETE FROM friend_requests WHERE from_id = ? OR to_id = ?', [userId, userId]);
    await db.run('DELETE FROM login_states WHERE username = ?', [user?.username]);
    // Sites they logged in to with Voicaw lose access (oauth.js).
    await require('./oauth').forgetUser(userId);
    // Their conversations with bots (not encrypted, so not kept for anyone: botDms.js).
    await require('./botDms').forgetUser(userId);
    // Not a name anyone can sign up with (sign-ups are lower case), and the old one is free again.
    await db.run(
      `UPDATE users SET username = ?, display_name = ?, password = '', key_backup = '', opaque_id = NULL,
         recovery_verifier = NULL, recovery_backup = NULL, recovery_created = NULL,
         two_factor_secret = NULL, two_factor_backup_codes = NULL, two_factor_last_step = NULL,
         custom_status = NULL, custom_status_emoji = NULL, bio = NULL, description = NULL, preferences = NULL, dictionary = NULL, dictionary_version = 0, emoji_usage = NULL, emoji_usage_version = 0, is_admin = 0, deleted_at = ?
       WHERE id = ?`,
      [`Deleted-User-${userId}`, DELETED_NAME, Math.floor(Date.now() / 1000), userId]
    );
  });
  await removeAvatar(userId);
  // Their notes' and emptied groups' files.
  require('./uploads').releaseUploads();

  // Everyone left in their groups sees them go.
  for (const { state, entry, r, before } of plan.leaves) {
    if (state.members.size === 0) continue;
    await calls.leaveGroupCall(state.group.id, userId);
    await groups.announceEntry(state, before, { seq: r.seq, record: entry.record, signature: entry.signature });
  }
  const memberships = await db.all('SELECT guild_id FROM guild_members WHERE user_id = ?', [userId]);
  for (const { guild_id: guildId } of memberships) await removeMember(guildId, userId);

  const profile = await db.get(`SELECT id, username, deleted_at, ${PROFILE_COLUMNS} FROM users WHERE id = ?`, [userId]);
  sendToAllSockets({ type: 'user_profile', user: profile });
  // Their other devices log out.
  sendToUserSockets(userId, { type: 'account_deleted' });
  for (const socket of clients.get(String(userId)) ?? []) socket.close(1008, 'Account deleted');
}

module.exports = { DELETED_NAME, DeletionError, ownedGuilds, checkDeletion, deleteAccount };
