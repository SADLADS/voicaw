import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db');

let userCount = 0;
async function makeUser() {
  const username = `recent-user-${++userCount}`;
  const password = 'pw-recent-123';
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  return { id: regRes.body.id, username, token: loginRes.body.token };
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const get = (user, url) => request(app).get(`/api${url}`).set(authed(user));
const post = (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body);

describe('GET /recent-chats (the share screen\'s order)', () => {
  it('needs a login', async () => {
    expect((await request(app).get('/api/recent-chats')).status).toBe(401);
  });

  it('lists where you last sent, newest first, and only your own sends', async () => {
    const [ann, bob, cat] = [await makeUser(), await makeUser(), await makeUser()];
    const guild = (await post(ann, '/guilds', { name: 'Recent guild' })).body;
    const general = guild.channels[0];

    const now = Math.floor(Date.now() / 1000);
    const toBob = await post(ann, '/dm-send', { recipient_id: bob.id, content: 'v1.a' });
    expect(toBob.status).toBe(201);
    // Bob writes to Cat and to Ann: neither is where Ann sent.
    await post(bob, '/dm-send', { recipient_id: cat.id, content: 'v1.b' });
    await post(bob, '/dm-send', { recipient_id: ann.id, content: 'v1.c' });
    const inGuild = await post(ann, `/channels/${general.id}/messages`, { content: 'hello' });
    expect(inGuild.status).toBe(201);
    const note = await post(ann, '/dm-send', { recipient_id: ann.id, content: 'v1.note' });
    // Seconds apart, so the order is certain.
    await db.run('UPDATE direct_messages SET timestamp = ? WHERE id = ?', [now - 30, toBob.body.id]);
    await db.run('UPDATE guild_messages SET timestamp = ? WHERE id = ?', [now - 20, inGuild.body.id]);
    await db.run('UPDATE direct_messages SET timestamp = ? WHERE id = ?', [now - 10, note.body.id]);

    // A group Ann is in and one she left: only the first is listed.
    for (const [id, stillIn] of [[`g-recent-${ann.id}`, true], [`g-left-${ann.id}`, false]]) {
      await db.run('INSERT INTO group_dms (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)', [id, 'G', ann.id, now]);
      if (stillIn) await db.run('INSERT INTO group_dm_members (group_id, user_id, joined_at) VALUES (?, ?, ?)', [id, ann.id, now]);
      await db.run('INSERT INTO group_dm_messages (group_id, epoch, sender_id, content, timestamp) VALUES (?, 1, ?, ?, ?)', [id, ann.id, 'x', now + 60]);
    }

    const res = await get(ann, '/recent-chats');
    expect(res.status).toBe(200);
    expect(res.body.map(({ kind, id }) => ({ kind, id }))).toEqual([
      { kind: 'group', id: `g-recent-${ann.id}` },
      { kind: 'dm', id: ann.id },
      { kind: 'channel', id: general.id },
      { kind: 'dm', id: bob.id },
    ]);
    expect(res.body[0].at).toBe(now + 60);

    // Cat sent nothing.
    expect((await get(cat, '/recent-chats')).body).toEqual([]);
  });
});
