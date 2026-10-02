import { deletedObjects, failingDeletes, putMockObject, objects } from './helpers/mockS3.js';
import './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import opaque from '@serenity-kit/opaque';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db.js');
const { cleanUpUploads, UNSENT_SECONDS } = require('../uploads.js');
const { uploadKeysIn } = require('../uploadKeys.js');
const { removeStaleTimers } = require('../pollTimers.js');

const PASSWORD = 'pw-uploads-123';
let userCount = 0;
async function makeUser(prefix = 'up-user') {
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
  patch: (user, url, body = {}) => request(app).patch(`/api${url}`).set(authed(user)).send(body),
  delete: (user, url) => request(app).delete(`/api${url}`).set(authed(user)),
};

// Uploads a file as the app does: asks for a URL (which registers it), then "puts" it.
async function upload(user) {
  const res = await api.get(user, '/upload_file?type=application/octet-stream&size=10');
  expect(res.status).toBe(201);
  const key = res.body.fileUrl.split('/uploads/')[1];
  putMockObject('uploads', key, Buffer.from('ciphertext'));
  return { key, url: `${res.body.fileUrl}#v=1&k=secret&t=image/png&s=10` };
}

const exists = (key) => objects.has(`uploads/${key}`);
const registered = async (key) => Boolean(await db.get('SELECT key FROM uploads WHERE key = ?', [key]));
// Makes an upload look older than the wait for its message.
const age = (key) => db.run('UPDATE uploads SET created_at = created_at - ? WHERE key = ?', [UNSENT_SECONDS + 60, key]);

async function guildWithChannel() {
  const owner = await makeUser('up-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Files' })).body;
  return { owner, guild, general: guild.channels[0] };
}

describe('uploadKeysIn', () => {
  it('finds our uploads (and video posters) in text, and nothing else', () => {
    const text = [
      '![a.png](http://localhost:0/uploads/aaa.bin#v=1&k=x&t=image/png&s=1)',
      '![v.mp4](http://localhost:0/uploads/bbb.bin#v=2&k=x&n=AAAAAAAAAAAAAAAA&t=video/mp4&s=9&p=ccc.bin)',
      'old http://localhost:0/uploads/ddd.png and a hook\'s "http://localhost:0/uploads/webhooks/u1/chart.png"',
      'not ours: https://example.com/uploads/eee.bin http://localhost:0/profile-pics/1/a.webp',
      'a poster elsewhere: http://localhost:0/uploads/fff.bin#v=2&p=../../x',
    ].join('\n');
    expect([...uploadKeysIn(text)].sort()).toEqual(['aaa.bin', 'bbb.bin', 'ccc.bin', 'ddd.png', 'fff.bin', 'webhooks/u1/chart.png']);
  });
});

describe('upload cleanup', () => {
  it("deletes a DM's files when the message is deleted, and the ones an edit drops", async () => {
    const [ann, bea] = [await makeUser(), await makeUser()];
    const [one, two, three] = [await upload(ann), await upload(ann), await upload(ann)];
    const sent = await api.post(ann, '/dm-send', { recipient_id: bea.id, content: 'v1.cipher', uploads: [one.key, two.key, 'not-registered.bin'] });
    expect(sent.status).toBe(201);
    await cleanUpUploads();
    expect([exists(one.key), exists(two.key)]).toEqual([true, true]);

    // The edit keeps one and adds three: two goes.
    expect((await api.put(ann, `/update-message/${sent.body.id}`, { content: 'v1.edited', uploads: [one.key, three.key] })).status).toBe(200);
    await cleanUpUploads();
    expect([exists(one.key), exists(two.key), exists(three.key)]).toEqual([true, false, true]);

    expect((await api.delete(ann, `/messages/${sent.body.id}`)).status).toBe(200);
    await cleanUpUploads();
    expect([exists(one.key), exists(three.key)]).toEqual([false, false]);
    expect(await registered(one.key)).toBe(false);
  });

  it('turns down an upload list that is not one', async () => {
    const [ann, bea] = [await makeUser(), await makeUser()];
    expect((await api.post(ann, '/dm-send', { recipient_id: bea.id, content: 'v1.c', uploads: 'a.bin' })).status).toBe(400);
    expect((await api.post(ann, '/dm-send', { recipient_id: bea.id, content: 'v1.c', uploads: [5] })).status).toBe(400);
  });

  it("keeps a file two messages show until both are gone, and someone else's message can't free it", async () => {
    const [ann, bea] = [await makeUser(), await makeUser()];
    const file = await upload(ann);
    const first = (await api.post(ann, '/dm-send', { recipient_id: bea.id, content: 'v1.a', uploads: [file.key] })).body;
    const second = (await api.post(bea, '/dm-send', { recipient_id: ann.id, content: 'v1.b', uploads: [file.key] })).body;
    await api.delete(ann, `/messages/${first.id}`);
    await cleanUpUploads();
    expect(exists(file.key)).toBe(true);
    await api.delete(bea, `/messages/${second.id}`);
    await cleanUpUploads();
    expect(exists(file.key)).toBe(false);
  });

  it('deletes files never sent after a day, not before', async () => {
    const ann = await makeUser();
    const file = await upload(ann);
    await cleanUpUploads();
    expect(exists(file.key)).toBe(true);
    await age(file.key);
    await cleanUpUploads();
    expect(exists(file.key)).toBe(false);
    expect(await registered(file.key)).toBe(false);
  });

  it("keeps what an older client (no upload list) sent: its sender's unsent uploads", async () => {
    const [ann, bea] = [await makeUser(), await makeUser()];
    const file = await upload(ann);
    const sent = (await api.post(ann, '/dm-send', { recipient_id: bea.id, content: 'v1.old' })).body;
    // Its edits don't change what it shows either.
    await api.put(ann, `/update-message/${sent.id}`, { content: 'v1.old-edit' });
    await age(file.key);
    await cleanUpUploads();
    expect(exists(file.key)).toBe(true);
    await api.delete(ann, `/messages/${sent.id}`);
    await cleanUpUploads();
    expect(exists(file.key)).toBe(true);
  });

  it('never touches files from before the registry', async () => {
    const [ann, bea] = [await makeUser(), await makeUser()];
    putMockObject('uploads', 'legacy-file.bin', Buffer.from('old'));
    const sent = (await api.post(ann, '/dm-send', { recipient_id: bea.id, content: 'v1.c', uploads: ['legacy-file.bin'] })).body;
    await api.delete(ann, `/messages/${sent.id}`);
    await cleanUpUploads();
    expect(exists('legacy-file.bin')).toBe(true);
  });

  it("tries again when the object store couldn't delete a file", async () => {
    const [ann, bea] = [await makeUser(), await makeUser()];
    const file = await upload(ann);
    const sent = (await api.post(ann, '/dm-send', { recipient_id: bea.id, content: 'v1.c', uploads: [file.key] })).body;
    failingDeletes.add(`uploads/${file.key}`);
    await api.delete(ann, `/messages/${sent.id}`);
    await cleanUpUploads();
    expect(exists(file.key)).toBe(true);
    expect(await registered(file.key)).toBe(true);
    failingDeletes.delete(`uploads/${file.key}`);
    await cleanUpUploads();
    expect(exists(file.key)).toBe(false);
  });

  it("reads guild messages' files itself: edits and deletes free them", async () => {
    const { owner, general } = await guildWithChannel();
    const [one, two] = [await upload(owner), await upload(owner)];
    const sent = await api.post(owner, `/channels/${general.id}/messages`, { content: `![a](${one.url}) ![b](${two.url})` });
    expect(sent.status).toBe(201);
    await api.put(owner, `/guild-messages/${sent.body.id}`, { content: `![a](${one.url})` });
    await cleanUpUploads();
    expect([exists(one.key), exists(two.key)]).toEqual([true, false]);
    await api.delete(owner, `/guild-messages/${sent.body.id}`);
    await cleanUpUploads();
    expect(exists(one.key)).toBe(false);
  });

  it("frees a document's images and cover when it changes or goes", async () => {
    const { owner, guild } = await guildWithChannel();
    const docs = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'Docs', type: 'doc' })).body;
    const [image, cover, other] = [await upload(owner), await upload(owner), await upload(owner)];
    const doc = (await api.post(owner, `/channels/${docs.id}/documents`, { title: 'D', cover: cover.url, content: `![i](${image.url})` })).body;
    const reply = (await api.post(owner, `/channels/${docs.id}/messages`, { content: `![o](${other.url})`, documentId: doc.id })).body;
    expect(reply.id).toBeTruthy();
    await api.patch(owner, `/documents/${doc.id}`, { version: doc.version, content: 'no images now' });
    await cleanUpUploads();
    expect([exists(image.key), exists(cover.key), exists(other.key)]).toEqual([false, true, true]);
    await api.delete(owner, `/documents/${doc.id}`);
    await cleanUpUploads();
    expect([exists(cover.key), exists(other.key)]).toEqual([false, false]);
  });

  it("frees a webhook message's files when they're dropped or it's deleted", async () => {
    const { owner, general } = await guildWithChannel();
    const hook = (await api.post(owner, `/channels/${general.id}/webhooks`, { name: 'Hook' })).body;
    const path = `/api/webhooks/${hook.id}/${hook.token}`;
    const posted = await request(app).post(`${path}?wait=true`)
      .attach('files[0]', Buffer.from('one'), { filename: 'one.txt', contentType: 'text/plain' })
      .attach('files[1]', Buffer.from('two'), { filename: 'two.txt', contentType: 'text/plain' });
    expect(posted.status).toBe(200);
    const [first, second] = posted.body.attachments.map((a) => a.url.split('/uploads/')[1]);
    expect([exists(first), exists(second)]).toEqual([true, true]);
    await request(app).patch(`${path}/messages/${posted.body.id}`).send({ attachments: [{ id: posted.body.attachments[0].id }] });
    await cleanUpUploads();
    expect([exists(first), exists(second)]).toEqual([true, false]);
    await request(app).delete(`${path}/messages/${posted.body.id}`);
    await cleanUpUploads();
    expect(exists(first)).toBe(false);
  });

  it('frees everything in a deleted channel, and in a deleted guild (its icon too)', async () => {
    const { owner, guild, general } = await guildWithChannel();
    const other = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'other' })).body;
    const [a, b] = [await upload(owner), await upload(owner)];
    await api.post(owner, `/channels/${other.id}/messages`, { content: `![a](${a.url})` });
    await api.post(owner, `/channels/${general.id}/messages`, { content: `![b](${b.url})` });
    expect((await api.delete(owner, `/guilds/${guild.id}/channels/${other.id}`)).status).toBe(200);
    await cleanUpUploads();
    expect([exists(a.key), exists(b.key)]).toEqual([false, true]);

    await db.run('UPDATE guilds SET icon_version = 1 WHERE id = ?', [guild.id]);
    expect((await api.delete(owner, `/guilds/${guild.id}`)).status).toBe(200);
    await cleanUpUploads();
    expect(exists(b.key)).toBe(false);
    expect(deletedObjects).toContainEqual({ bucket: 'guild-icons', key: String(guild.id) });
  });

  it("frees deleted notes' files when the account goes", async () => {
    const ann = await makeUser();
    const file = await upload(ann);
    await api.post(ann, '/dm-send', { recipient_id: ann.id, content: 'v1.note', uploads: [file.key] });
    // A login proof of the password, as the app sends it (see account.test.js).
    await opaque.ready;
    const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password: PASSWORD });
    const started = await request(app).post('/api/initiatelogin').send({ userIdentifier: ann.username, startLoginRequest });
    const login = opaque.client.finishLogin({ clientLoginState, loginResponse: started.body.loginResponse, password: PASSWORD });
    const res = await request(app).delete('/api/account').set(authed(ann))
      .send({ finishLoginRequest: login.finishLoginRequest, clientSessionKey: login.sessionKey });
    expect(res.status).toBe(200);
    await cleanUpUploads();
    expect(exists(file.key)).toBe(false);
  });
});

describe('stale poll timers', () => {
  it('go with polls whose chat was deleted', async () => {
    await db.run("INSERT INTO poll_timers (kind, message_id, ends_at) VALUES ('guild', 99999999, 0)");
    await removeStaleTimers();
    expect(await db.get("SELECT * FROM poll_timers WHERE kind = 'guild' AND message_id = 99999999")).toBeUndefined();
  });
});
