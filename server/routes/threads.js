const express = require('express');
const db = require('../db');
const { authenticateJWT } = require('../auth');
const { PERMISSIONS, has } = require('../permissions');
const { getChannelAccess, sendToChannel, deleteChannelContents, cleanName } = require('../guilds');
const { logAudit, diff } = require('../auditLog');
const { releaseUploads } = require('../uploads');
const threads = require('../threads');
const { ActionError, withActionErrors } = require('../actionError');

// Threads in guild text channels (threads.js, docs/guilds.md). Seeing a thread follows its
// channel's View Channel; starting one needs Create Threads there, posting in one Send Messages
// in Threads (guildMessages.js, through getChannelAccess). Its starter renames and archives it;
// Manage Messages in the channel renames, archives and deletes anyone's. The actions take
// `{ channel, permissions, userId }` (the caller's access) so the bot API (routes/botApi.js)
// shares them; they throw ActionError.
const router = express.Router();

const nameError = `Thread names are 1–${threads.MAX_THREAD_NAME} characters`;

// Loads req.channel (a text channel the caller can see) and req.permissions there.
async function requireTextChannel(req, res, next) {
  const access = await getChannelAccess(Number(req.params.channelId), req.user.id);
  if (!access || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) return res.status(404).json({ error: 'Channel not found' });
  if (access.channel.type !== 'text') return res.status(400).json({ error: 'Not a text channel' });
  req.channel = access.channel;
  req.permissions = access.permissions;
  next();
}

// Loads req.thread (with `joined`), req.channel (the thread as a channel) and req.permissions
// (in the thread) if the caller can see it.
async function requireThread(req, res, next) {
  const access = await getChannelAccess(Number(req.params.threadId), req.user.id);
  if (!access || access.channel.type !== 'thread' || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) {
    return res.status(404).json({ error: 'Thread not found' });
  }
  req.thread = await threads.getThread(access.channel.id, req.user.id);
  req.channel = access.channel;
  req.permissions = access.permissions;
  next();
}

const canManage = (permissions) => has(permissions, PERMISSIONS.MANAGE_MESSAGES);

// Starts a thread called `name` from message `messageId` in the text channel (one thread per
// message), or with no `messageId` on its own: then a "started a thread" row (system 'thread')
// goes in the channel as its starter. The starter joins it. Resolves to the thread.
async function startThread({ channel, permissions, userId }, { name: givenName, messageId = null }) {
  if (channel.type !== 'text') throw new ActionError(400, 'Not a text channel', 50024);
  if (!has(permissions, PERMISSIONS.CREATE_THREADS)) throw new ActionError(403, "You don't have permission to do that");
  const name = cleanName(givenName, threads.MAX_THREAD_NAME);
  if (!name) throw new ActionError(400, nameError);
  if (messageId != null) {
    const message = Number.isInteger(messageId) && await db.get(
      'SELECT id, system FROM guild_messages WHERE id = ? AND channel_id = ?',
      [messageId, channel.id]
    );
    if (!message || message.system) throw new ActionError(400, 'Invalid message', 10008);
    if (await db.get("SELECT id FROM guild_channels WHERE type = 'thread' AND starter_message_id = ?", [messageId])) {
      throw new ActionError(409, 'That message already has a thread', 160004);
    }
  }

  const at = Math.floor(Date.now() / 1000);
  const { threadId, rowId } = await db.transaction(async () => {
    const { lastID: id } = await db.run(
      `INSERT INTO guild_channels (guild_id, category_id, name, type, position, parent_id, owner_id, starter_message_id, created_at, last_activity)
       VALUES (?, NULL, ?, 'thread', 0, ?, ?, ?, ?, ?)`,
      [channel.guild_id, name, channel.id, userId, messageId, at, at]
    );
    let row = null;
    if (messageId == null) {
      ({ lastID: row } = await db.run(
        `INSERT INTO guild_messages (channel_id, sender_id, content, system, timestamp) VALUES (?, ?, ?, ?, ?)`,
        [channel.id, userId, name, threads.THREAD_ROW, at]
      ));
      await db.run('UPDATE guild_channels SET starter_message_id = ? WHERE id = ?', [row, id]);
      await db.run(
        `INSERT INTO guild_channel_reads (user_id, channel_id, last_read_id) VALUES (?, ?, ?)
         ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`,
        [userId, channel.id, row]
      );
    }
    await threads.addMember(id, userId);
    await logAudit({
      guildId: channel.guild_id,
      action: 'thread_create',
      actorId: userId,
      targetType: 'thread',
      targetId: id,
      channelId: channel.id,
      details: { name, channelName: channel.name },
    });
    return { threadId: id, rowId: row };
  });

  if (rowId) {
    const { MESSAGE_SELECT, withReactions } = require('./guildMessages');
    const [message] = await withReactions([await db.get(`${MESSAGE_SELECT} WHERE m.id = ?`, [rowId])]);
    await sendToChannel(channel, { type: 'guild_message_new', guildId: channel.guild_id, message });
  }
  await threads.announceThread(threadId, { joinedIds: [userId] });
  return threads.getThread(threadId, userId);
}

router.post('/channels/:channelId/threads', authenticateJWT, requireTextChannel, withActionErrors(async (req, res) => {
  const thread = await startThread(
    { channel: req.channel, permissions: req.permissions, userId: req.user.id },
    { name: req.body?.name, messageId: req.body?.messageId ?? null }
  );
  res.status(201).json(thread);
}));

// The channel's threads, active and archived, most recently active first.
router.get('/channels/:channelId/threads', authenticateJWT, requireTextChannel, async (req, res) => {
  res.json(await threads.channelThreads(req.channel.id, req.user.id));
});

// The thread, and the message it started from (null if that's gone, or for a thread started on
// its own).
router.get('/threads/:threadId', authenticateJWT, requireThread, async (req, res) => {
  const { MESSAGE_SELECT, withReactions } = require('./guildMessages');
  const row = req.thread.starter_message_id && await db.get(
    `${MESSAGE_SELECT} WHERE m.id = ? AND m.system IS NULL`,
    [req.thread.starter_message_id]
  );
  const [starter = null] = row ? await withReactions([row]) : [];
  res.json({ thread: req.thread, starter });
});

// Renames (`name`) or archives (`archived`) the thread: its starter or Manage Messages; anyone
// who may post in it can unarchive it (posting does too).
router.patch('/threads/:threadId', authenticateJWT, requireThread, withActionErrors(async (req, res) => {
  await updateThread({ thread: req.thread, channel: req.channel, permissions: req.permissions, userId: req.user.id }, req.body ?? {});
  res.json(await threads.getThread(req.thread.id, req.user.id));
}));

// Renames (`name`) or archives (`archived`) `thread` (as threads.getThread gives it).
async function updateThread({ thread, channel, permissions, userId }, { name: givenName, archived }) {
  const own = thread.owner_id === userId;
  const updates = [];
  const params = [];
  if (givenName !== undefined) {
    const name = cleanName(givenName, threads.MAX_THREAD_NAME);
    if (!name) throw new ActionError(400, nameError);
    if (!own && !canManage(permissions)) throw new ActionError(403, "You don't have permission to do that");
    updates.push('name = ?');
    params.push(name);
  }
  if (archived !== undefined) {
    if (typeof archived !== 'boolean') throw new ActionError(400, 'Invalid archived');
    const allowed = archived ? own || canManage(permissions) : has(permissions, PERMISSIONS.SEND_MESSAGES) || canManage(permissions);
    if (!allowed) throw new ActionError(403, "You don't have permission to do that");
    updates.push('archived = ?');
    params.push(archived ? 1 : 0);
    // Unarchiving starts its week again.
    if (!archived) {
      updates.push('last_activity = ?');
      params.push(Math.floor(Date.now() / 1000));
    }
  }
  if (!updates.length) return;
  await db.transaction(async () => {
    await db.run(`UPDATE guild_channels SET ${updates.join(', ')} WHERE id = ?`, [...params, thread.id]);
    const saved = await threads.getThread(thread.id);
    const changes = diff(thread, { name: saved.name, archived: saved.archived });
    if (Object.keys(changes).length) {
      await logAudit({
        guildId: channel.guild_id,
        action: 'thread_update',
        actorId: userId,
        targetType: 'thread',
        targetId: thread.id,
        channelId: thread.parent_id,
        details: { name: saved.name, changes },
      });
    }
  });
  await threads.announceThread(thread.id);
}

// Deletes the thread and everything in it (Manage Messages), and its "started a thread" row.
router.delete('/threads/:threadId', authenticateJWT, requireThread, withActionErrors(async (req, res) => {
  await deleteThread({ thread: req.thread, permissions: req.permissions, userId: req.user.id });
  res.json({ success: true });
}));

async function deleteThread({ thread, permissions, userId }) {
  if (!canManage(permissions)) throw new ActionError(403, "You don't have permission to do that");
  const { id, guild_id: guildId, parent_id: parentId, starter_message_id: starterId } = thread;
  const row = starterId && await db.get('SELECT id FROM guild_messages WHERE id = ? AND system = ?', [starterId, threads.THREAD_ROW]);
  const parent = await db.get('SELECT name FROM guild_channels WHERE id = ?', [parentId]);
  await db.transaction(async () => {
    await logAudit({
      guildId,
      action: 'thread_delete',
      actorId: userId,
      targetType: 'thread',
      targetId: id,
      channelId: parentId,
      details: { name: thread.name, channelName: parent?.name },
    });
    await deleteChannelContents('?', [id], { threads: false });
    await db.run('DELETE FROM guild_channels WHERE id = ?', [id]);
    if (row) {
      await db.run('DELETE FROM guild_reactions WHERE message_id = ?', [row.id]);
      await db.run('DELETE FROM guild_messages WHERE id = ?', [row.id]);
    }
  });
  releaseUploads();
  const channel = { id: parentId, guild_id: guildId };
  if (row) await sendToChannel(channel, { type: 'guild_message_delete', guildId, channelId: parentId, messageId: row.id });
  await sendToChannel(channel, { type: 'guild_thread_delete', guildId, channelId: parentId, threadId: id });
}

// `userId` joins or leaves thread `threadId`: members have it in their channel list.
async function setThreadMembership(threadId, userId, joined) {
  const changed = joined ? await threads.addMember(threadId, userId) : await threads.removeMember(threadId, userId);
  if (changed) await threads.announceThread(threadId, joined ? { joinedIds: [userId] } : { leftIds: [userId] });
}

async function setMembership(req, res, joined) {
  await setThreadMembership(req.thread.id, req.user.id, joined);
  res.json({ threadId: req.thread.id, joined });
}

router.put('/threads/:threadId/member', authenticateJWT, requireThread, (req, res) => setMembership(req, res, true));
router.delete('/threads/:threadId/member', authenticateJWT, requireThread, (req, res) => setMembership(req, res, false));

module.exports = router;
module.exports.startThread = startThread;
module.exports.updateThread = updateThread;
module.exports.deleteThread = deleteThread;
module.exports.setThreadMembership = setThreadMembership;
