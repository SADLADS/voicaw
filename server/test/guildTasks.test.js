import './helpers/mockS3.js';
import { sentPushes, waitForPushes } from './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db.js');
const { PERMISSIONS: P, DEFAULT_EVERYONE_PERMISSIONS } = require('../permissions.js');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser(prefix = 'task-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-tasks-123';
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  return { id: regRes.body.id, username, token: loginRes.body.token };
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
  patch: (user, url, body = {}) => request(app).patch(`/api${url}`).set(authed(user)).send(body),
  delete: (user, url) => request(app).delete(`/api${url}`).set(authed(user)),
};

function listen(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)) };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return events;
}

async function subscribe(user) {
  const endpoint = `https://push.test/${user.username}`;
  await api.post(user, '/save-subscription', { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } });
  return endpoint;
}

// A guild with an owner, `count` members and a list channel.
async function setUp(count = 2) {
  const owner = await makeUser('t-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Tasks Guild' })).body;
  const members = [];
  for (let i = 0; i < count; i++) {
    const user = await makeUser('t-member');
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(user, `/invites/${invite.body.code}`);
    members.push(user);
  }
  const res = await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'Roadmap', type: 'list' });
  expect(res.status).toBe(201);
  return { owner, members, guild, board: res.body, general: guild.channels[0], everyone: guild.roles.find((r) => r.is_everyone) };
}

const addTask = (user, board, body) => api.post(user, `/channels/${board.id}/tasks`, body);
const tasksOf = async (user, board) => (await api.get(user, `/channels/${board.id}/tasks`)).body;
const override = (actor, guild, board, type, id, allow, deny) => api.put(
  actor, `/guilds/${guild.id}/channels/${board.id}/overrides/${type}/${id}`, { allow, deny }
);

describe('list channels', () => {
  it('is a channel type, in the layout like any other', async () => {
    const { owner, guild, board } = await setUp(0);
    expect(board.type).toBe('list');
    const layout = (await api.get(owner, `/guilds/${guild.id}`)).body;
    expect(layout.channels.find((c) => c.id === board.id)).toMatchObject({ type: 'list', name: 'roadmap' });
    expect((await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'x', type: 'board' })).status).toBe(400);
  });

  it('gives @everyone Edit Tasks by default', () => {
    expect(DEFAULT_EVERYONE_PERMISSIONS & P.EDIT_TASKS).toBe(P.EDIT_TASKS);
  });

  it('creates, edits, completes and deletes tasks, and tells everyone who can see the board', async () => {
    const { owner, members: [alice], board } = await setUp(1);
    const events = listen(alice);
    const created = await addTask(owner, board, { title: '  Ship   lists ', description: 'All of it', dueDate: '2026-10-31' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      title: 'Ship lists', description: 'All of it', due_date: '2026-10-31', parent_id: null,
      completed_at: null, assignees: [], comment_count: 0, created_by: owner.id,
    });
    const id = created.body.id;
    expect(events.find((e) => e.type === 'guild_task_upsert')?.task.id).toBe(id);

    const done = await api.patch(alice, `/tasks/${id}`, { completed: true, title: 'Ship lists!' });
    expect(done.status).toBe(200);
    expect(done.body.completed_by).toBe(alice.id);
    expect(done.body.completed_at).toBeGreaterThan(0);
    expect(done.body.title).toBe('Ship lists!');

    const undone = await api.patch(owner, `/tasks/${id}`, { completed: false, dueDate: null, description: '' });
    expect(undone.body).toMatchObject({ completed_at: null, completed_by: null, due_date: null, description: null });

    expect((await api.delete(alice, `/tasks/${id}`)).status).toBe(200);
    expect(events.at(-1)).toMatchObject({ type: 'guild_task_delete', ids: [id] });
    expect(await tasksOf(owner, board)).toEqual([]);
  });

  it('checks what it is sent', async () => {
    const { owner, board } = await setUp(0);
    expect((await addTask(owner, board, { title: '   ' })).status).toBe(400);
    expect((await addTask(owner, board, { title: 'x'.repeat(201) })).status).toBe(400);
    expect((await addTask(owner, board, { title: 'a', dueDate: '2026-02-30' })).status).toBe(400);
    expect((await addTask(owner, board, { title: 'a', dueDate: 'tomorrow' })).status).toBe(400);
    expect((await addTask(owner, board, { title: 'a', description: 'x'.repeat(4001) })).status).toBe(400);
    expect((await addTask(owner, board, { title: 'a', parentId: 999999 })).status).toBe(400);
    const task = (await addTask(owner, board, { title: 'a' })).body;
    expect((await api.patch(owner, `/tasks/${task.id}`, { completed: 'yes' })).status).toBe(400);
  });

  it('nests subtasks, and deleting a task deletes its subtasks and comments', async () => {
    const { owner, board } = await setUp(0);
    const parent = (await addTask(owner, board, { title: 'Parent' })).body;
    const child = (await addTask(owner, board, { title: 'Child', parentId: parent.id })).body;
    const grandchild = (await addTask(owner, board, { title: 'Grandchild', parentId: child.id })).body;
    expect(child.parent_id).toBe(parent.id);
    await api.post(owner, `/tasks/${grandchild.id}/comments`, { content: 'deep' });

    const res = await api.delete(owner, `/tasks/${parent.id}`);
    expect(res.body.ids.sort()).toEqual([parent.id, child.id, grandchild.id].sort());
    const left = await db.get('SELECT COUNT(*) AS n FROM guild_task_comments WHERE task_id = ?', [grandchild.id]);
    expect(left.n).toBe(0);
  });

  it('limits nesting depth', async () => {
    const { owner, board } = await setUp(0);
    let parentId = null;
    for (let level = 1; level <= 5; level++) {
      const res = await addTask(owner, board, { title: `L${level}`, parentId });
      expect(res.status).toBe(201);
      parentId = res.body.id;
    }
    expect((await addTask(owner, board, { title: 'L6', parentId })).status).toBe(400);
  });

  it('reorders and moves tasks, never into their own subtasks', async () => {
    const { owner, members: [alice], board } = await setUp(1);
    const events = listen(alice);
    const ids = [];
    for (const title of ['A', 'B', 'C']) ids.push((await addTask(owner, board, { title })).body.id);
    const [idA, idB, idC] = ids;

    // C before A.
    const moved = await api.put(owner, `/tasks/${idC}/move`, { parentId: null, beforeId: idA });
    expect(moved.status).toBe(200);
    expect(moved.body.tasks.map((t) => t.id)).toEqual([idC, idA, idB]);
    expect(events.at(-1).type).toBe('guild_tasks_move');

    // A under B (last).
    await api.put(owner, `/tasks/${idA}/move`, { parentId: idB, beforeId: null });
    const tasks = await tasksOf(owner, board);
    expect(tasks.find((t) => t.id === idA).parent_id).toBe(idB);
    expect(tasks.filter((t) => t.parent_id === null).sort((x, y) => x.position - y.position).map((t) => t.id)).toEqual([idC, idB]);

    // B into A (its own subtask): refused.
    expect((await api.put(owner, `/tasks/${idB}/move`, { parentId: idA })).status).toBe(400);
    expect((await api.put(owner, `/tasks/${idB}/move`, { parentId: idB })).status).toBe(400);
    // beforeId must be a sibling there.
    expect((await api.put(owner, `/tasks/${idC}/move`, { parentId: null, beforeId: idA })).status).toBe(400);
  });

  it('refuses a move that would nest too deep', async () => {
    const { owner, board } = await setUp(0);
    let parentId = null;
    for (let level = 1; level <= 4; level++) parentId = (await addTask(owner, board, { title: `L${level}`, parentId })).body.id;
    const top = (await addTask(owner, board, { title: 'Top' })).body;
    await addTask(owner, board, { title: 'Under top', parentId: top.id });
    // Top has two levels; under L4 it would reach level 6.
    expect((await api.put(owner, `/tasks/${top.id}/move`, { parentId })).status).toBe(400);
  });

  it('only accepts assignees who can see the board, and notifies the newly assigned', async () => {
    const { owner, members: [alice, bob], guild, board } = await setUp(2);
    const aliceEndpoint = await subscribe(alice);
    const bobEndpoint = await subscribe(bob);
    const aliceEvents = listen(alice);

    const since = sentPushes.length;
    const task = (await addTask(owner, board, { title: 'Write docs', assigneeIds: [alice.id, alice.id] })).body;
    expect(task.assignees).toEqual([alice.id]);
    const pushes = await waitForPushes(1, since);
    const push = pushes.find((p) => p.endpoint === aliceEndpoint);
    expect(push.payload).toMatchObject({
      type: 'task', body: 'Write docs', url: `/guild/${guild.id}/${board.id}?task=${task.id}`, tag: `task-${task.id}`,
    });
    expect(push.payload.title).toContain('assigned you a task');
    expect(aliceEvents.find((e) => e.type === 'guild_task_assigned')).toMatchObject({ taskId: task.id, by: owner.id });

    // Adding Bob notifies only Bob; assigning yourself notifies nobody.
    const since2 = sentPushes.length;
    await api.patch(owner, `/tasks/${task.id}`, { assigneeIds: [alice.id, bob.id] });
    await api.patch(bob, `/tasks/${task.id}`, { assigneeIds: [alice.id, bob.id] });
    const later = await waitForPushes(2, since2, 300);
    expect(later.map((p) => p.endpoint)).toEqual([bobEndpoint]);

    // Bob can't see the board any more: can't be assigned.
    await override(owner, guild, board, 'member', bob.id, 0, P.VIEW_CHANNEL);
    expect((await api.patch(owner, `/tasks/${task.id}`, { assigneeIds: [bob.id] })).status).toBe(400);
    // Nor can a stranger, and at most 10.
    const stranger = await makeUser('t-stranger');
    expect((await addTask(owner, board, { title: 'x', assigneeIds: [stranger.id] })).status).toBe(400);
  });

  it('keeps viewing and editing separate, per role or member', async () => {
    const { owner, members: [alice, bob], guild, board, everyone } = await setUp(2);
    const task = (await addTask(owner, board, { title: 'Read only' })).body;

    // Read-only for @everyone, editable by an "Editors" role and by Bob himself.
    await override(owner, guild, board, 'role', everyone.id, 0, P.EDIT_TASKS);
    expect((await addTask(alice, board, { title: 'nope' })).status).toBe(403);
    expect((await api.patch(alice, `/tasks/${task.id}`, { completed: true })).status).toBe(403);
    expect((await api.put(alice, `/tasks/${task.id}/move`, { parentId: null })).status).toBe(403);
    expect((await api.delete(alice, `/tasks/${task.id}`)).status).toBe(403);
    expect((await api.get(alice, `/channels/${board.id}/tasks`)).status).toBe(200);
    // Still allowed to comment (Send Messages).
    expect((await api.post(alice, `/tasks/${task.id}/comments`, { content: 'Looks good' })).status).toBe(201);

    const role = (await api.post(owner, `/guilds/${guild.id}/roles`, { name: 'Editors' })).body;
    await override(owner, guild, board, 'role', role.id, P.EDIT_TASKS, 0);
    await api.put(owner, `/guilds/${guild.id}/members/${alice.id}/roles`, { roleIds: [role.id] });
    expect((await api.patch(alice, `/tasks/${task.id}`, { completed: true })).status).toBe(200);

    await override(owner, guild, board, 'member', bob.id, P.EDIT_TASKS, 0);
    expect((await addTask(bob, board, { title: 'Bob can' })).status).toBe(201);

    // Private board: only those allowed View Channel see it, and its tasks 404 for the rest.
    await override(owner, guild, board, 'role', everyone.id, 0, P.VIEW_CHANNEL | P.EDIT_TASKS);
    expect((await api.get(bob, `/channels/${board.id}/tasks`)).status).toBe(404);
    expect((await api.get(bob, `/tasks/${task.id}/comments`)).status).toBe(404);
    expect((await api.patch(bob, `/tasks/${task.id}`, { title: 'x' })).status).toBe(404);
    const bobEvents = listen(bob);
    await addTask(owner, board, { title: 'Secret' });
    expect(bobEvents.some((e) => e.type === 'guild_task_upsert')).toBe(false);
  });

  it('is only for list channels and members', async () => {
    const { owner, general, board } = await setUp(0);
    expect((await api.get(owner, `/channels/${general.id}/tasks`)).status).toBe(404);
    expect((await addTask(owner, general, { title: 'x' })).status).toBe(404);
    const outsider = await makeUser('t-out');
    expect((await api.get(outsider, `/channels/${board.id}/tasks`)).status).toBe(404);
    // A list channel has no messages.
    expect((await api.post(owner, `/channels/${board.id}/messages`, { content: 'hi' })).status).toBe(400);
  });

  it('has comments: authors edit theirs, authors or Manage Messages delete', async () => {
    const { owner, members: [alice, bob], guild, board, everyone } = await setUp(2);
    const task = (await addTask(owner, board, { title: 'Discuss' })).body;
    const bobEvents = listen(bob);
    const comment = (await api.post(alice, `/tasks/${task.id}/comments`, { content: ' First! ' })).body;
    expect(comment).toMatchObject({ content: 'First!', sender_id: alice.id, task_id: task.id, sender_username: alice.username });
    expect(bobEvents.at(-1)).toMatchObject({ type: 'guild_task_comment_new', taskId: task.id });
    expect((await tasksOf(owner, board))[0].comment_count).toBe(1);

    expect((await api.patch(bob, `/task-comments/${comment.id}`, { content: 'hijack' })).status).toBe(403);
    const edited = await api.patch(alice, `/task-comments/${comment.id}`, { content: 'First, edited' });
    expect(edited.body.edited_at).toBeGreaterThan(0);
    expect((await api.delete(bob, `/task-comments/${comment.id}`)).status).toBe(403);
    expect((await api.delete(owner, `/task-comments/${comment.id}`)).status).toBe(200);
    expect(bobEvents.at(-1)).toMatchObject({ type: 'guild_task_comment_delete', commentId: comment.id });
    expect((await api.get(bob, `/tasks/${task.id}/comments`)).body).toEqual([]);

    // Without Send Messages: no comments.
    await override(owner, guild, board, 'role', everyone.id, 0, P.SEND_MESSAGES);
    expect((await api.post(bob, `/tasks/${task.id}/comments`, { content: 'hi' })).status).toBe(403);
    expect((await api.post(bob, `/tasks/${task.id}/comments`, { content: '' })).status).toBe(403);
  });

  it('deleting the channel deletes its tasks; leaving the guild unassigns you', async () => {
    const { owner, members: [alice], guild, board } = await setUp(1);
    const task = (await addTask(owner, board, { title: 'Mine', assigneeIds: [alice.id] })).body;
    await api.delete(alice, `/guilds/${guild.id}/members/me`);
    expect((await tasksOf(owner, board))[0].assignees).toEqual([]);

    await api.post(owner, `/tasks/${task.id}/comments`, { content: 'bye' });
    expect((await api.delete(owner, `/guilds/${guild.id}/channels/${board.id}`)).status).toBe(200);
    expect((await db.get('SELECT COUNT(*) AS n FROM guild_tasks WHERE channel_id = ?', [board.id])).n).toBe(0);
    expect((await db.get('SELECT COUNT(*) AS n FROM guild_task_comments WHERE channel_id = ?', [board.id])).n).toBe(0);
  });

  it('lets a channel override change Edit Tasks', async () => {
    const { owner, guild, board, everyone } = await setUp(0);
    expect((await override(owner, guild, board, 'role', everyone.id, 0, P.EDIT_TASKS)).status).toBe(200);
  });
});
