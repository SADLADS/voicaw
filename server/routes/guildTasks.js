const express = require('express');
const db = require('../db');
const { authenticateJWT } = require('../auth');
const { PERMISSIONS, has } = require('../permissions');
const { getChannelAccess, getChannelViewers, sendToChannel } = require('../guilds');
const {
  MAX_TITLE,
  MAX_DESCRIPTION,
  MAX_COMMENT,
  MAX_ASSIGNEES,
  MAX_TASKS_PER_BOARD,
  MAX_DEPTH,
  boardTasks,
  getTask,
  subtreeIds,
  depthOf,
  heightOf,
  deleteTaskRows,
  notifyAssigned,
} = require('../guildTasks');

// List channels: tasks and their comments. A task has no permissions of its own: its board's
// (the channel's) decide. View Channel sees the board (without it, 404), Edit Tasks adds,
// edits, assigns, completes, moves and deletes tasks, Send Messages comments, and Manage
// Messages deletes other people's comments. Events go to whoever can see the board.
const router = express.Router();

const now = () => Math.floor(Date.now() / 1000);
const forbidden = (res) => res.status(403).json({ error: "You don't have permission to do that" });
const notFound = (res, what = 'Task') => res.status(404).json({ error: `${what} not found` });

// The board as the caller sees it ({ channel, member, permissions }), or null if it isn't a
// list channel they can see.
async function boardAccess(channelId, userId) {
  const access = await getChannelAccess(channelId, userId);
  if (!access || access.channel.type !== 'list' || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) return null;
  return access;
}

// req.access for the board in the URL.
async function requireBoard(req, res, next) {
  const access = await boardAccess(Number(req.params.channelId), req.user.id);
  if (!access) return notFound(res, 'Channel');
  req.access = access;
  next();
}

// req.task and req.access for the task in the URL (404 if the caller can't see its board).
async function requireTask(req, res, next) {
  const task = await getTask(Number(req.params.taskId));
  const access = task && await boardAccess(task.channel_id, req.user.id);
  if (!access) return notFound(res);
  req.task = task;
  req.access = access;
  next();
}

const requireEdit = (req, res, next) => (has(req.access.permissions, PERMISSIONS.EDIT_TASKS) ? next() : forbidden(res));

const event = (access, type, fields) => ({ type, guildId: access.channel.guild_id, channelId: access.channel.id, ...fields });

// ---- Checking what's sent ----

function cleanTitle(title) {
  if (typeof title !== 'string') return null;
  const trimmed = title.replace(/\s+/g, ' ').trim();
  return trimmed && trimmed.length <= MAX_TITLE ? trimmed : null;
}

// undefined: not sent; null: cleared; false: invalid.
function cleanDescription(description) {
  if (description === undefined) return undefined;
  if (description === null) return null;
  if (typeof description !== 'string' || description.length > MAX_DESCRIPTION) return false;
  return description.trim() ? description.replace(/\s+$/, '') : null;
}

// 'YYYY-MM-DD' (a real day), null to clear; false if invalid.
function cleanDueDate(date) {
  if (date === undefined) return undefined;
  if (date === null || date === '') return null;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : false;
}

// The assignees as a list of distinct user ids who can see the board; false if invalid.
async function cleanAssignees(ids, channel) {
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids) || ids.some((id) => !Number.isInteger(id))) return false;
  const unique = [...new Set(ids)];
  if (unique.length > MAX_ASSIGNEES) return false;
  if (!unique.length) return unique;
  const viewers = new Set(await getChannelViewers(channel));
  return unique.every((id) => viewers.has(id)) ? unique : false;
}

// Sets the task's assignees to `userIds`; resolves to those newly added.
async function setAssignees(taskId, userIds, actorId) {
  const current = (await db.all('SELECT user_id FROM guild_task_assignees WHERE task_id = ?', [taskId])).map((r) => r.user_id);
  const added = userIds.filter((id) => !current.includes(id));
  const removed = current.filter((id) => !userIds.includes(id));
  for (const id of removed) await db.run('DELETE FROM guild_task_assignees WHERE task_id = ? AND user_id = ?', [taskId, id]);
  const at = now();
  for (const id of added) {
    await db.run(
      'INSERT INTO guild_task_assignees (task_id, user_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?)',
      [taskId, id, actorId, at]
    );
  }
  return added;
}

// `parentId` must be a task on the same board (or null: the top level).
async function checkParent(parentId, channelId) {
  if (parentId == null) return true;
  if (!Number.isInteger(parentId)) return false;
  return Boolean(await db.get('SELECT id FROM guild_tasks WHERE id = ? AND channel_id = ?', [parentId, channelId]));
}

// Puts `taskId` among `parentId`'s children just before `beforeId` (null: at the end) and
// numbers them again. Resolves to the siblings' new { id, parent_id, position }.
async function placeTask(channelId, taskId, parentId, beforeId) {
  const siblings = (await db.all(
    `SELECT id FROM guild_tasks WHERE channel_id = ? AND parent_id IS ? AND id != ? ORDER BY position, id`,
    [channelId, parentId ?? null, taskId]
  )).map((r) => r.id);
  const at = beforeId == null ? siblings.length : siblings.indexOf(beforeId);
  if (at < 0) return null;
  siblings.splice(at, 0, taskId);
  const placed = [];
  for (const [position, id] of siblings.entries()) {
    await db.run('UPDATE guild_tasks SET position = ?, parent_id = ? WHERE id = ?', [position, parentId ?? null, id]);
    placed.push({ id, parent_id: parentId ?? null, position });
  }
  return placed;
}

// ---- Tasks ----

router.get('/channels/:channelId/tasks', authenticateJWT, requireBoard, async (req, res) => {
  res.json(await boardTasks(req.access.channel.id));
});

// { title, description?, dueDate?, assigneeIds?, parentId? }: at the end of its parent's
// subtasks (or of the board).
router.post('/channels/:channelId/tasks', authenticateJWT, requireBoard, requireEdit, async (req, res) => {
  const { channel } = req.access;
  const body = req.body ?? {};
  const title = cleanTitle(body.title);
  if (!title) return res.status(400).json({ error: `Task titles are 1–${MAX_TITLE} characters` });
  const description = cleanDescription(body.description);
  if (description === false) return res.status(400).json({ error: `Descriptions are at most ${MAX_DESCRIPTION} characters` });
  const dueDate = cleanDueDate(body.dueDate);
  if (dueDate === false) return res.status(400).json({ error: 'Invalid due date' });
  const assignees = await cleanAssignees(body.assigneeIds ?? [], channel);
  if (assignees === false) return res.status(400).json({ error: `Assignees must be up to ${MAX_ASSIGNEES} people who can see this list` });
  const parentId = body.parentId ?? null;
  if (!(await checkParent(parentId, channel.id))) return res.status(400).json({ error: 'Invalid parent task' });
  if (await depthOf(parentId) + 1 > MAX_DEPTH) return res.status(400).json({ error: `Tasks nest at most ${MAX_DEPTH} levels deep` });

  const result = await db.transaction(async () => {
    const { count } = await db.get('SELECT COUNT(*) AS count FROM guild_tasks WHERE channel_id = ?', [channel.id]);
    if (count >= MAX_TASKS_PER_BOARD) return null;
    const { max } = await db.get(
      'SELECT MAX(position) AS max FROM guild_tasks WHERE channel_id = ? AND parent_id IS ?',
      [channel.id, parentId]
    );
    const at = now();
    const { lastID } = await db.run(
      `INSERT INTO guild_tasks (channel_id, parent_id, position, title, description, due_date, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [channel.id, parentId, max == null ? 0 : max + 1, title, description ?? null, dueDate ?? null, req.user.id, at, at]
    );
    const added = await setAssignees(lastID, assignees, req.user.id);
    return { id: lastID, added };
  });
  if (!result) return res.status(400).json({ error: `A list holds at most ${MAX_TASKS_PER_BOARD} tasks` });

  const task = await getTask(result.id);
  await sendToChannel(channel, event(req.access, 'guild_task_upsert', { task }));
  notifyAssigned(task, channel, req.user, result.added).catch((err) => console.error('Task notification failed:', err.message));
  res.status(201).json(task);
});

// Any of { title, description, dueDate, assigneeIds, completed }.
router.patch('/tasks/:taskId', authenticateJWT, requireTask, requireEdit, async (req, res) => {
  const { channel } = req.access;
  const body = req.body ?? {};
  const updates = [];
  const params = [];
  if (body.title !== undefined) {
    const title = cleanTitle(body.title);
    if (!title) return res.status(400).json({ error: `Task titles are 1–${MAX_TITLE} characters` });
    updates.push('title = ?');
    params.push(title);
  }
  const description = cleanDescription(body.description);
  if (description === false) return res.status(400).json({ error: `Descriptions are at most ${MAX_DESCRIPTION} characters` });
  if (description !== undefined) {
    updates.push('description = ?');
    params.push(description);
  }
  const dueDate = cleanDueDate(body.dueDate);
  if (dueDate === false) return res.status(400).json({ error: 'Invalid due date' });
  if (dueDate !== undefined) {
    updates.push('due_date = ?');
    params.push(dueDate);
  }
  if (body.completed !== undefined) {
    if (typeof body.completed !== 'boolean') return res.status(400).json({ error: 'completed must be true or false' });
    // Completing a completed task keeps who did it first and when.
    if (body.completed !== Boolean(req.task.completed_at)) {
      updates.push('completed_at = ?', 'completed_by = ?');
      params.push(body.completed ? now() : null, body.completed ? req.user.id : null);
    }
  }
  const assignees = await cleanAssignees(body.assigneeIds, channel);
  if (assignees === false) return res.status(400).json({ error: `Assignees must be up to ${MAX_ASSIGNEES} people who can see this list` });

  const added = await db.transaction(async () => {
    if (updates.length) {
      await db.run(`UPDATE guild_tasks SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`, [...params, now(), req.task.id]);
    }
    return assignees ? setAssignees(req.task.id, assignees, req.user.id) : [];
  });

  const task = await getTask(req.task.id);
  await sendToChannel(channel, event(req.access, 'guild_task_upsert', { task }));
  notifyAssigned(task, channel, req.user, added).catch((err) => console.error('Task notification failed:', err.message));
  res.json(task);
});

// { parentId, beforeId }: under `parentId` (null: the top level), just before its subtask
// `beforeId` (null: last). Not into itself or its own subtasks, nor deeper than MAX_DEPTH.
router.put('/tasks/:taskId/move', authenticateJWT, requireTask, requireEdit, async (req, res) => {
  const { channel } = req.access;
  const parentId = req.body?.parentId ?? null;
  const beforeId = req.body?.beforeId ?? null;
  if (!(await checkParent(parentId, channel.id))) return res.status(400).json({ error: 'Invalid parent task' });
  if (beforeId != null && (!Number.isInteger(beforeId) || beforeId === req.task.id)) {
    return res.status(400).json({ error: 'Invalid position' });
  }
  if (parentId != null && (await subtreeIds(req.task.id)).includes(parentId)) {
    return res.status(400).json({ error: "A task can't go inside its own subtasks" });
  }
  if (await depthOf(parentId) + await heightOf(req.task.id) > MAX_DEPTH) {
    return res.status(400).json({ error: `Tasks nest at most ${MAX_DEPTH} levels deep` });
  }
  const placed = await db.transaction(() => placeTask(channel.id, req.task.id, parentId, beforeId));
  if (!placed) return res.status(400).json({ error: 'Invalid position' });
  await sendToChannel(channel, event(req.access, 'guild_tasks_move', { tasks: placed }));
  res.json({ tasks: placed });
});

// Deletes the task, its subtasks and their comments.
router.delete('/tasks/:taskId', authenticateJWT, requireTask, requireEdit, async (req, res) => {
  const ids = await db.transaction(async () => {
    const all = await subtreeIds(req.task.id);
    await deleteTaskRows(all);
    return all;
  });
  await sendToChannel(req.access.channel, event(req.access, 'guild_task_delete', { ids }));
  res.json({ ids });
});

// ---- Comments ----

const COMMENT_SELECT = `
  SELECT c.id, c.task_id, c.channel_id, c.sender_id, c.content, c.timestamp, c.edited_at,
    u.username AS sender_username, u.display_name AS sender_display_name
  FROM guild_task_comments c LEFT JOIN users u ON u.id = c.sender_id`;

const getComment = (id) => db.get(`${COMMENT_SELECT} WHERE c.id = ?`, [id]);

function cleanComment(content) {
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  return trimmed && content.length <= MAX_COMMENT ? trimmed : null;
}

// Oldest first.
router.get('/tasks/:taskId/comments', authenticateJWT, requireTask, async (req, res) => {
  res.json(await db.all(`${COMMENT_SELECT} WHERE c.task_id = ? ORDER BY c.id`, [req.task.id]));
});

router.post('/tasks/:taskId/comments', authenticateJWT, requireTask, async (req, res) => {
  if (!has(req.access.permissions, PERMISSIONS.SEND_MESSAGES)) return forbidden(res);
  const content = cleanComment(req.body?.content);
  if (!content) return res.status(400).json({ error: `Comments are 1–${MAX_COMMENT} characters` });
  const { lastID } = await db.run(
    'INSERT INTO guild_task_comments (task_id, channel_id, sender_id, content, timestamp) VALUES (?, ?, ?, ?, ?)',
    [req.task.id, req.access.channel.id, req.user.id, content, now()]
  );
  const comment = await getComment(lastID);
  await sendToChannel(req.access.channel, event(req.access, 'guild_task_comment_new', { taskId: req.task.id, comment }));
  res.status(201).json(comment);
});

// req.comment, req.task and req.access for the comment in the URL.
async function requireComment(req, res, next) {
  const id = Number(req.params.commentId);
  const comment = Number.isInteger(id) ? await getComment(id) : null;
  const access = comment && await boardAccess(comment.channel_id, req.user.id);
  if (!access) return notFound(res, 'Comment');
  req.comment = comment;
  req.access = access;
  next();
}

// The author only.
router.patch('/task-comments/:commentId', authenticateJWT, requireComment, async (req, res) => {
  if (req.comment.sender_id !== req.user.id) return forbidden(res);
  const content = cleanComment(req.body?.content);
  if (!content) return res.status(400).json({ error: `Comments are 1–${MAX_COMMENT} characters` });
  await db.run('UPDATE guild_task_comments SET content = ?, edited_at = ? WHERE id = ?', [content, now(), req.comment.id]);
  const comment = await getComment(req.comment.id);
  await sendToChannel(req.access.channel, event(req.access, 'guild_task_comment_edit', { taskId: comment.task_id, comment }));
  res.json(comment);
});

// The author, or Manage Messages.
router.delete('/task-comments/:commentId', authenticateJWT, requireComment, async (req, res) => {
  if (req.comment.sender_id !== req.user.id && !has(req.access.permissions, PERMISSIONS.MANAGE_MESSAGES)) return forbidden(res);
  await db.run('DELETE FROM guild_task_comments WHERE id = ?', [req.comment.id]);
  await sendToChannel(req.access.channel, event(req.access, 'guild_task_comment_delete', {
    taskId: req.comment.task_id, commentId: req.comment.id,
  }));
  res.json({ success: true });
});

module.exports = router;
