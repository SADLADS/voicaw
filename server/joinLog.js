const db = require('./db');
const { PERMISSIONS, has } = require('./permissions');
const { ActionError } = require('./actionError');
const { logAudit } = require('./auditLog');

// Join log: a guild can pick one of its text channels where "X joined the guild." rows appear
// (Discord's join messages), and, if it wants, "X left the guild." (kicks and bans too, worded the
// same so the channel doesn't tell what moderators did; that's the audit log's). Off until Manage
// Guild picks a channel (PATCH /guilds/:id { joinLog }). The rows are guild_messages with `system`
// 'member_join' / 'member_leave', the person as sender and no content, sent as any new message
// (unread like one, no pushes), so only those who can see the channel get them. Bots see joins as
// Discord's type 7; deleting the channel turns the join log off (guilds.js deleteChannelContents).

const JOIN = 'member_join';
const LEAVE = 'member_leave';

// The guild's settings, as the layout (guilds.js) gives them to the app.
function settingsOf(row) {
  return { channel_id: row?.join_log_channel_id ?? null, leaves: Boolean(row?.join_log_leaves) };
}

// `actor` (a member context with Manage Guild) sets the join log: `channelId` a text channel of
// the guild or null (off), `leaves` whether leaves are posted too; either may be left out. Logged
// as guild_update with what changed. Throws ActionError.
async function setJoinLog(actor, { channelId, leaves }) {
  if (!has(actor.permissions, PERMISSIONS.MANAGE_GUILD)) throw new ActionError(403, "You don't have permission to do that");
  if (leaves !== undefined && typeof leaves !== 'boolean') throw new ActionError(400, 'Invalid join log');
  const guildId = actor.guild.id;
  const before = await db.get('SELECT join_log_channel_id, join_log_leaves FROM guilds WHERE id = ?', [guildId]);
  let channel = null;
  if (channelId != null) {
    channel = Number.isInteger(channelId) && await db.get(
      "SELECT id, name FROM guild_channels WHERE id = ? AND guild_id = ? AND type = 'text'",
      [channelId, guildId]
    );
    if (!channel) throw new ActionError(400, 'The join log has to be one of the guild\'s text channels');
  }
  const nextChannelId = channelId === undefined ? before.join_log_channel_id : (channel?.id ?? null);
  const nextLeaves = leaves === undefined ? Boolean(before.join_log_leaves) : leaves;

  const changes = {};
  if (nextChannelId !== before.join_log_channel_id) {
    const old = before.join_log_channel_id && await db.get('SELECT name FROM guild_channels WHERE id = ?', [before.join_log_channel_id]);
    changes.join_log = [old?.name ?? null, channel?.name ?? null];
  }
  if (nextLeaves !== Boolean(before.join_log_leaves)) changes.join_log_leaves = [!nextLeaves, nextLeaves];
  if (!Object.keys(changes).length) return false;
  await db.transaction(async () => {
    await db.run('UPDATE guilds SET join_log_channel_id = ?, join_log_leaves = ? WHERE id = ?', [nextChannelId, nextLeaves, guildId]);
    await logAudit({ guildId, actorId: actor.userId, action: 'guild_update', details: { changes } });
  });
  return true;
}

// Posts `userId` joining (JOIN) or leaving (LEAVE) `guildId` in its join log, if it has one (and,
// for leaves, posts them). Call after the membership change is saved. Never throws: the join or
// leave itself has happened.
async function logMembership(guildId, userId, system) {
  try {
    const guild = await db.get('SELECT join_log_channel_id, join_log_leaves FROM guilds WHERE id = ?', [guildId]);
    if (!guild?.join_log_channel_id || (system === LEAVE && !guild.join_log_leaves)) return null;
    const channel = await db.get(
      "SELECT * FROM guild_channels WHERE id = ? AND guild_id = ? AND type = 'text'",
      [guild.join_log_channel_id, guildId]
    );
    if (!channel) return null;
    const id = await db.transaction(async () => {
      const { lastID } = await db.run(
        `INSERT INTO guild_messages (channel_id, sender_id, content, system, timestamp)
         VALUES (?, ?, '', ?, strftime('%s','now'))`,
        [channel.id, userId, system]
      );
      // Your own arrival isn't unread for you.
      if (system === JOIN) {
        await db.run(
          `INSERT INTO guild_channel_reads (user_id, channel_id, last_read_id) VALUES (?, ?, ?)
           ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`,
          [userId, channel.id, lastID]
        );
      }
      return lastID;
    });
    const { MESSAGE_SELECT, withReactions } = require('./routes/guildMessages');
    const { sendToChannel } = require('./guilds');
    const [message] = await withReactions([await db.get(`${MESSAGE_SELECT} WHERE m.id = ?`, [id])]);
    await sendToChannel(channel, { type: 'guild_message_new', guildId, message });
    return id;
  } catch (err) {
    console.error('Join log failed:', err.message);
    return null;
  }
}

module.exports = { JOIN, LEAVE, settingsOf, setJoinLog, logMembership };
