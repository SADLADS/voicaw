const db = require('./db');
const { sendToUserSockets, isViewingConversation } = require('./sockets');
const { sendPushToUser, getUserImageUrl } = require('./push');

// List channels (Guilded's lists): a board of tasks in a tree. Rows, limits and the
// notification someone gets when assigned a task. Routes are in routes/guildTasks.js.

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 4000;
const MAX_COMMENT = 2000;
const MAX_ASSIGNEES = 10;
const MAX_TASKS_PER_BOARD = 2000;
// Levels of nesting: a top-level task is 1, its subtasks 2, and so on.
const MAX_DEPTH = 5;

const TASK_COLUMNS = `t.id, t.channel_id, t.parent_id, t.position, t.title, t.description, t.due_date,
  t.completed_at, t.completed_by, t.created_by, t.created_at, t.updated_at`;

// The tasks with their `assignees` (user ids, in the order assigned) and `comment_count`.
async function withDetails(tasks) {
  if (!tasks.length) return tasks;
  const ids = tasks.map((t) => t.id);
  const marks = ids.map(() => '?').join(',');
  const assignees = await db.all(
    `SELECT task_id, user_id FROM guild_task_assignees WHERE task_id IN (${marks}) ORDER BY assigned_at, user_id`,
    ids
  );
  const counts = await db.all(
    `SELECT task_id, COUNT(*) AS count FROM guild_task_comments WHERE task_id IN (${marks}) GROUP BY task_id`,
    ids
  );
  const byTask = new Map(ids.map((id) => [id, []]));
  for (const row of assignees) byTask.get(row.task_id).push(row.user_id);
  const countOf = new Map(counts.map((c) => [c.task_id, c.count]));
  return tasks.map((t) => ({ ...t, assignees: byTask.get(t.id), comment_count: countOf.get(t.id) ?? 0 }));
}

// Every task of the board, siblings in order (the client builds the tree).
async function boardTasks(channelId) {
  return withDetails(await db.all(
    `SELECT ${TASK_COLUMNS} FROM guild_tasks t WHERE t.channel_id = ? ORDER BY t.parent_id, t.position, t.id`,
    [channelId]
  ));
}

async function getTask(taskId) {
  if (!Number.isInteger(taskId)) return null;
  const task = await db.get(`SELECT ${TASK_COLUMNS} FROM guild_tasks t WHERE t.id = ?`, [taskId]);
  return task ? (await withDetails([task]))[0] : null;
}

// The ids of `taskId` and everything under it.
async function subtreeIds(taskId) {
  const rows = await db.all(
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM guild_tasks WHERE id = ?
       UNION ALL SELECT t.id FROM guild_tasks t JOIN sub ON t.parent_id = sub.id
     ) SELECT id FROM sub`,
    [taskId]
  );
  return rows.map((r) => r.id);
}

// How deep `taskId` is (top level: 1); 0 for null (the board itself).
async function depthOf(taskId) {
  if (taskId == null) return 0;
  const row = await db.get(
    `WITH RECURSIVE up(id, parent_id, depth) AS (
       SELECT id, parent_id, 1 FROM guild_tasks WHERE id = ?
       UNION ALL SELECT t.id, t.parent_id, up.depth + 1 FROM guild_tasks t JOIN up ON t.id = up.parent_id
     ) SELECT MAX(depth) AS depth FROM up`,
    [taskId]
  );
  return row?.depth ?? 0;
}

// How many levels `taskId`'s subtree has (a task without subtasks: 1).
async function heightOf(taskId) {
  const row = await db.get(
    `WITH RECURSIVE sub(id, level) AS (
       SELECT id, 1 FROM guild_tasks WHERE id = ?
       UNION ALL SELECT t.id, sub.level + 1 FROM guild_tasks t JOIN sub ON t.parent_id = sub.id
     ) SELECT MAX(level) AS height FROM sub`,
    [taskId]
  );
  return row?.height ?? 1;
}

// Deletes tasks (by id) with their assignees and comments. Inside a transaction.
async function deleteTaskRows(ids) {
  if (!ids.length) return;
  const marks = ids.map(() => '?').join(',');
  await db.run(`DELETE FROM guild_task_comments WHERE task_id IN (${marks})`, ids);
  await db.run(`DELETE FROM guild_task_assignees WHERE task_id IN (${marks})`, ids);
  await db.run(`DELETE FROM guild_tasks WHERE id IN (${marks})`, ids);
}

// Everything of the channels (an SQL list of ids, as deleteChannelContents takes them).
async function deleteChannelTasks(channelIdsSql, params) {
  const where = `task_id IN (SELECT id FROM guild_tasks WHERE channel_id IN (${channelIdsSql}))`;
  await db.run(`DELETE FROM guild_task_comments WHERE ${where}`, params);
  await db.run(`DELETE FROM guild_task_assignees WHERE ${where}`, params);
  await db.run(`DELETE FROM guild_tasks WHERE channel_id IN (${channelIdsSql})`, params);
}

// Someone leaving a guild stops being assigned anything in it.
async function unassignFromGuild(guildId, userId) {
  await db.run(
    `DELETE FROM guild_task_assignees WHERE user_id = ? AND task_id IN
       (SELECT t.id FROM guild_tasks t JOIN guild_channels c ON c.id = t.channel_id WHERE c.guild_id = ?)`,
    [userId, guildId]
  );
}

// Tells each of `userIds` (newly assigned `task` by `actor`) on their open apps
// (`guild_task_assigned`), and pushes to them unless their notification level for the guild is
// 'none' or they're looking at the board. Never to the actor themselves.
async function notifyAssigned(task, channel, actor, userIds) {
  const recipients = userIds.filter((id) => id !== actor.id);
  if (!recipients.length) return;
  for (const userId of recipients) {
    sendToUserSockets(userId, {
      type: 'guild_task_assigned', guildId: channel.guild_id, channelId: channel.id, taskId: task.id, title: task.title, by: actor.id,
    });
  }
  const levels = new Map((await db.all(
    `SELECT user_id, notify_level FROM guild_members WHERE guild_id = ? AND user_id IN (${recipients.map(() => '?').join(',')})`,
    [channel.guild_id, ...recipients]
  )).map((r) => [r.user_id, r.notify_level]));
  const guild = await db.get('SELECT name FROM guilds WHERE id = ?', [channel.guild_id]);
  const sender = await db.get('SELECT username, display_name FROM users WHERE id = ?', [actor.id]);
  const payload = {
    type: 'task',
    title: `${sender?.display_name || sender?.username} assigned you a task (#${channel.name}, ${guild.name})`,
    body: task.title,
    url: `/guild/${channel.guild_id}/${channel.id}?task=${task.id}`,
    tag: `task-${task.id}`,
    image: await getUserImageUrl(actor.id),
    timestamp: Math.floor(Date.now() / 1000),
  };
  for (const userId of recipients) {
    if (levels.get(userId) === 'none' || isViewingConversation(userId, `channel-${channel.id}`)) continue;
    sendPushToUser(userId, payload, { urgency: 'high' }).catch(() => {});
  }
}

module.exports = {
  MAX_TITLE,
  MAX_DESCRIPTION,
  MAX_COMMENT,
  MAX_ASSIGNEES,
  MAX_TASKS_PER_BOARD,
  MAX_DEPTH,
  withDetails,
  boardTasks,
  getTask,
  subtreeIds,
  depthOf,
  heightOf,
  deleteTaskRows,
  deleteChannelTasks,
  unassignFromGuild,
  notifyAssigned,
};
