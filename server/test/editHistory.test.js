import './helpers/mockS3.js';
import './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db.js');

const PASSWORD = 'pw-edits-123';
let userCount = 0;
async function makeUser(prefix = 'edits') {
  const username = `${prefix}-${++userCount}`;
  const { response: regRes } = await registerUser(app, request, username, PASSWORD);
  const { response: loginRes } = await loginUser(app, request, username, PASSWORD);
  return { id: regRes.body.id, username, token: loginRes.body.token };
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
  delete: (user, url) => request(app).delete(`/api${url}`).set(authed(user)),
};

const kept = (kind, id) => db.all('SELECT content FROM message_edits WHERE kind = ? AND message_id = ?', [kind, id]);

describe('guild message edit history', () => {
  it('keeps every earlier version for whoever can see the channel, until the message goes', async () => {
    const [owner, member, outsider] = [await makeUser(), await makeUser(), await makeUser()];
    const guild = (await api.post(owner, '/guilds', { name: 'Edits' })).body;
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(member, `/invites/${invite.body.code}`);
    const channel = guild.channels[0];

    const sent = (await api.post(owner, `/channels/${channel.id}/messages`, { content: 'first' })).body;
    expect((await api.get(member, `/guild-messages/${sent.id}/edits`)).body).toEqual({ versions: [], edited_at: null });

    await api.put(owner, `/guild-messages/${sent.id}`, { content: 'second' });
    // Saving the same text again keeps nothing.
    await api.put(owner, `/guild-messages/${sent.id}`, { content: 'second' });
    await api.put(owner, `/guild-messages/${sent.id}`, { content: 'third' });

    const res = await api.get(member, `/guild-messages/${sent.id}/edits`);
    expect(res.status).toBe(200);
    expect(res.body.versions).toEqual([
      { content: 'first', written_at: sent.timestamp, edited: 0 },
      { content: 'second', written_at: expect.any(Number), edited: 1 },
    ]);
    expect(res.body.edited_at).toEqual(expect.any(Number));
    expect((await api.get(outsider, `/guild-messages/${sent.id}/edits`)).status).toBe(404);

    expect((await api.delete(owner, `/guild-messages/${sent.id}`)).status).toBe(200);
    expect(await kept('guild', sent.id)).toEqual([]);
  });
});

describe('DM edit history', () => {
  it('keeps the ciphertexts for both people only, and records when it was edited', async () => {
    const [ann, bea, cal] = [await makeUser(), await makeUser(), await makeUser()];
    const sent = (await api.post(ann, '/dm-send', { recipient_id: bea.id, content: 'v1.first' })).body;
    expect((await api.put(ann, `/update-message/${sent.id}`, { content: 'v1.second' })).status).toBe(200);

    const res = await api.get(bea, `/dm-messages/${sent.id}/edits`);
    expect(res.status).toBe(200);
    expect(res.body.versions).toEqual([{ content: 'v1.first', written_at: expect.any(Number), edited: 0 }]);
    expect(res.body.edited_at).toEqual(expect.any(Number));
    expect((await api.get(ann, `/dm-messages/${sent.id}/edits`)).status).toBe(200);
    expect((await api.get(cal, `/dm-messages/${sent.id}/edits`)).status).toBe(404);
    expect((await api.get(cal, '/dm-messages/999999/edits')).status).toBe(404);

    const rows = (await api.get(bea, `/dm-messages/${ann.id}`)).body;
    expect((rows.messages ?? rows).find((m) => m.id === sent.id).edited_at).toEqual(expect.any(Number));

    expect((await api.delete(ann, `/messages/${sent.id}`)).status).toBe(200);
    expect(await kept('dm', sent.id)).toEqual([]);
  });
});
