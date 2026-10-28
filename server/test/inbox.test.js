import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db');
const { PERMISSIONS: P } = require('../permissions.js');

let userCount = 0;
async function makeUser(prefix = 'inbox-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-inbox-123';
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  return { id: regRes.body.id, username, token: loginRes.body.token };
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
};

const inbox = async (user) => {
  const res = await api.get(user, '/inbox');
  expect(res.status).toBe(200);
  return res.body;
};
const dm = (from, to, content) => api.post(from, '/dm-send', { recipient_id: to.id, content });

async function guildWith(owner, members) {
  const guild = (await api.post(owner, '/guilds', { name: 'Inbox guild' })).body;
  for (const user of members) {
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(user, `/invites/${invite.body.code}`);
  }
  return { guild, general: guild.channels[0], everyone: guild.roles.find((r) => r.is_everyone) };
}

describe('GET /inbox', () => {
  it('needs a login', async () => {
    expect((await request(app).get('/api/inbox')).status).toBe(401);
  });

  it("a DM: only the newest message from each person, as its push's payload, and whether it's unread", async () => {
    const ann = await makeUser();
    const bob = await makeUser();
    const cat = await makeUser();
    await dm(bob, ann, 'cipher-1');
    await dm(bob, ann, 'cipher-2');
    await dm(ann, bob, 'cipher-own');
    await dm(cat, ann, 'cipher-3');
    await dm(ann, ann, 'note');

    const entries = await inbox(ann);
    expect(entries.map((e) => e.payload.ciphertext)).toEqual(['cipher-3', 'cipher-2']);
    expect(entries[1]).toMatchObject({ unread: true, payload: { type: 'dm', senderId: bob.id, url: `/dm/${bob.id}`, tag: `dm-${bob.id}` } });

    await api.post(ann, `/dm-mark-read/${bob.id}`);
    expect((await inbox(ann)).find((e) => e.payload.senderId === bob.id).unread).toBe(false);
  });

  it('leaves out muted conversations and people you blocked', async () => {
    const ann = await makeUser();
    const bob = await makeUser();
    const cat = await makeUser();
    await dm(bob, ann, 'from-bob');
    await dm(cat, ann, 'from-cat');
    await api.put(ann, `/conversation-settings/dm/${bob.id}`, { mute: { duration: 3600 } });
    await api.put(ann, `/blocks/${cat.id}`);
    expect(await inbox(ann)).toEqual([]);
  });

  it('a group: its newest message from someone else, in an epoch you have a key for', async () => {
    const ann = await makeUser();
    const bob = await makeUser();
    const id = `inbox-group-${userCount}`;
    const now = Math.floor(Date.now() / 1000);
    await db.transaction(async () => {
      await db.run('INSERT INTO group_dms (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)', [id, 'Old', bob.id, now]);
      for (const user of [ann, bob]) {
        await db.run('INSERT INTO group_dm_members (group_id, user_id, joined_at) VALUES (?, ?, ?)', [id, user.id, now]);
      }
      // Ann only has the key of epoch 2.
      await db.run('INSERT INTO group_dm_epoch_keys (group_id, epoch, user_id, envelope) VALUES (?, 2, ?, ?)', [id, ann.id, 'k']);
      for (const [epoch, content] of [[1, 'before-ann'], [2, 'g-1'], [2, 'g-2']]) {
        await db.run('INSERT INTO group_dm_messages (group_id, epoch, sender_id, content, timestamp) VALUES (?, ?, ?, ?, ?)', [id, epoch, bob.id, content, now]);
      }
      await db.run('INSERT INTO group_dm_messages (group_id, epoch, sender_id, content, timestamp) VALUES (?, 1, ?, ?, ?)', [id, bob.id, 'old-epoch-newer', now]);
    });
    const entries = await inbox(ann);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ unread: true, payload: { type: 'group', groupId: id, epoch: 2, ciphertext: 'g-2', url: `/dm/g/${id}` } });
    expect(await inbox(bob)).toEqual([]);
  });

  it('a guild: mentions and replies to you, in channels you can see, unless your level is None', async () => {
    const owner = await makeUser('inbox-owner');
    const ann = await makeUser();
    const { guild, general, everyone } = await guildWith(owner, [ann]);
    const say = (user, channel, content, extra = {}) => api.post(user, `/channels/${channel.id}/messages`, { content, ...extra });

    const mine = (await say(ann, general, 'my message')).body;
    await say(owner, general, 'not about ann');
    await say(owner, general, `hi <@${ann.id}>`);
    await say(owner, general, 'a reply', { replyTo: mine.id });
    const secret = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'secret', type: 'text' })).body;
    await say(owner, secret, `secret <@${ann.id}>`);
    await api.put(owner, `/guilds/${guild.id}/channels/${secret.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.VIEW_CHANNEL });

    const entries = await inbox(ann);
    expect(entries.map((e) => e.payload.body)).toEqual(['a reply', `hi @${ann.username}`]);
    expect(entries[0]).toMatchObject({
      unread: true,
      payload: { type: 'guild', guildId: guild.id, url: `/guild/${guild.id}/${general.id}`, tag: `channel-${general.id}` },
    });
    expect(entries[0].payload.title).toContain('#general');

    await api.put(ann, `/channels/${general.id}/notifications`, { level: 'none' });
    expect(await inbox(ann)).toEqual([]);
  });
});
