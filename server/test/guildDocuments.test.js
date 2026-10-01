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
async function makeUser(prefix = 'doc-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-docs-123';
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

// A guild with an owner, `count` members and a document channel.
async function setUp(count = 2) {
  const owner = await makeUser('d-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Docs Guild' })).body;
  const members = [];
  for (let i = 0; i < count; i++) {
    const user = await makeUser('d-member');
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(user, `/invites/${invite.body.code}`);
    members.push(user);
  }
  const res = await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'Handbook', type: 'doc' });
  expect(res.status).toBe(201);
  return { owner, members, guild, docs: res.body, general: guild.channels[0], everyone: guild.roles.find((r) => r.is_everyone) };
}

const COVER = 'http://localhost:0/uploads/abc.bin#v=1&k=key&t=image/png&s=10&w=800&h=200';
const addDoc = (user, channel, body) => api.post(user, `/channels/${channel.id}/documents`, body);
const override = (actor, guild, channel, type, id, allow, deny) => api.put(
  actor, `/guilds/${guild.id}/channels/${channel.id}/overrides/${type}/${id}`, { allow, deny }
);
const reply = (user, channel, documentId, content, extra = {}) => api.post(
  user, `/channels/${channel.id}/messages`, { content, documentId, ...extra }
);

describe('document channels', () => {
  it('is a channel type, and @everyone may create documents by default', async () => {
    const { owner, guild, docs } = await setUp(0);
    expect(docs.type).toBe('doc');
    const layout = (await api.get(owner, `/guilds/${guild.id}`)).body;
    expect(layout.channels.find((c) => c.id === docs.id)).toMatchObject({ type: 'doc', name: 'handbook' });
    expect(DEFAULT_EVERYONE_PERMISSIONS & P.CREATE_DOCUMENTS).toBe(P.CREATE_DOCUMENTS);
  });

  it('creates, reads, lists and edits documents, and tells everyone who can see the channel', async () => {
    const { owner, members: [alice], docs } = await setUp(1);
    const events = listen(alice);
    const created = await addDoc(owner, docs, { title: '  Welcome   aboard ', cover: COVER, content: '# Hi\n\nSome **bold** text.\n\n' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      title: 'Welcome aboard', cover: COVER, content: '# Hi\n\nSome **bold** text.', created_by: owner.id,
      version: 1, reactions: [], reply_count: 0,
    });
    const id = created.body.id;
    expect(events.find((e) => e.type === 'guild_document_upsert')?.document).toMatchObject({ id, title: 'Welcome aboard' });

    const second = (await addDoc(alice, docs, { title: 'Second' })).body;
    const feed = (await api.get(alice, `/channels/${docs.id}/documents`)).body;
    expect(feed.map((d) => d.id)).toEqual([second.id, id]); // newest first
    expect(feed[1].content).toBeUndefined();
    expect(feed[1].content_start).toBe('# Hi\n\nSome **bold** text.');

    const edited = await api.patch(owner, `/documents/${id}`, { version: 1, content: 'Changed', cover: null });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ content: 'Changed', cover: null, title: 'Welcome aboard', version: 2, updated_by: owner.id });
    expect(events.find((e) => e.type === 'guild_document_update')?.document.content).toBe('Changed');
    expect((await api.get(alice, `/documents/${id}`)).body.content).toBe('Changed');
  });

  it('refuses a save over a newer one, sending the newer document', async () => {
    const { owner, docs } = await setUp(0);
    const doc = (await addDoc(owner, docs, { title: 'Draft' })).body;
    expect((await api.patch(owner, `/documents/${doc.id}`, { version: 1, content: 'First' })).status).toBe(200);
    const stale = await api.patch(owner, `/documents/${doc.id}`, { version: 1, content: 'Stale' });
    expect(stale.status).toBe(409);
    expect(stale.body.document).toMatchObject({ content: 'First', version: 2 });
    expect((await api.patch(owner, `/documents/${doc.id}`, { content: 'No version' })).status).toBe(400);
  });

  it('checks what it is sent', async () => {
    const { owner, docs, general } = await setUp(0);
    expect((await addDoc(owner, docs, { title: '   ' })).status).toBe(400);
    expect((await addDoc(owner, docs, { title: 'x'.repeat(201) })).status).toBe(400);
    expect((await addDoc(owner, docs, { title: 'a', content: 'x'.repeat(100001) })).status).toBe(400);
    expect((await addDoc(owner, docs, { title: 'a', cover: 'https://elsewhere.example/a.png' })).status).toBe(400);
    expect((await addDoc(owner, docs, { title: 'a', cover: 42 })).status).toBe(400);
    // A long document fits through the bigger body limit.
    expect((await addDoc(owner, docs, { title: 'Long', content: 'é'.repeat(100000) })).status).toBe(201);
    // Not a document channel.
    expect((await addDoc(owner, general, { title: 'a' })).status).toBe(404);
  });

  it('lets authors edit their own, and Manage Messages anyone\'s', async () => {
    const { owner, members: [alice, bob], guild, docs } = await setUp(2);
    const doc = (await addDoc(alice, docs, { title: "Alice's" })).body;
    expect((await api.patch(bob, `/documents/${doc.id}`, { version: 1, title: 'Bob was here' })).status).toBe(403);
    expect((await api.delete(bob, `/documents/${doc.id}`)).status).toBe(403);
    expect((await api.patch(owner, `/documents/${doc.id}`, { version: 1, title: 'Owner was here' })).status).toBe(200);

    const mod = (await api.post(owner, `/guilds/${guild.id}/roles`, { name: 'Mod', permissions: P.MANAGE_MESSAGES })).body;
    await api.put(owner, `/guilds/${guild.id}/members/${bob.id}/roles`, { roleIds: [mod.id] });
    expect((await api.patch(bob, `/documents/${doc.id}`, { version: 2, title: 'Bob was here' })).status).toBe(200);
  });

  it('takes Create Documents away with an override, which also stops editing your own', async () => {
    const { owner, members: [alice], guild, docs, everyone } = await setUp(1);
    const doc = (await addDoc(alice, docs, { title: 'Mine' })).body;
    expect((await override(owner, guild, docs, 'role', everyone.id, 0, P.CREATE_DOCUMENTS)).status).toBe(200);
    expect((await addDoc(alice, docs, { title: 'Another' })).status).toBe(403);
    expect((await api.patch(alice, `/documents/${doc.id}`, { version: 1, title: 'Edit' })).status).toBe(403);
    // Replies and reactions still work.
    expect((await reply(alice, docs, doc.id, 'Still replying')).status).toBe(201);
    expect((await api.post(alice, `/documents/${doc.id}/reactions`, { emoji: '👍' })).status).toBe(201);
  });

  it('hides a private document channel', async () => {
    const { owner, members: [alice], guild, docs, everyone } = await setUp(1);
    const doc = (await addDoc(owner, docs, { title: 'Secret' })).body;
    await override(owner, guild, docs, 'role', everyone.id, 0, P.VIEW_CHANNEL);
    expect((await api.get(alice, `/channels/${docs.id}/documents`)).status).toBe(404);
    expect((await api.get(alice, `/documents/${doc.id}`)).status).toBe(404);
    expect((await api.get(alice, `/channels/${docs.id}/messages?document=${doc.id}`)).status).toBe(404);
    const outsider = await makeUser('d-outsider');
    expect((await api.get(outsider, `/documents/${doc.id}`)).status).toBe(404);
  });

  it('reacts to documents, one of each per person, removing only your own', async () => {
    const { owner, members: [alice], docs } = await setUp(1);
    const events = listen(owner);
    const doc = (await addDoc(owner, docs, { title: 'React to me' })).body;
    const added = await api.post(alice, `/documents/${doc.id}/reactions`, { emoji: '🎉' });
    expect(added.status).toBe(201);
    expect(events.find((e) => e.type === 'guild_document_reaction_add')?.reaction).toMatchObject({ document_id: doc.id, user_id: alice.id, emoji: '🎉' });
    expect((await api.post(alice, `/documents/${doc.id}/reactions`, { emoji: '🎉' })).status).toBe(409);
    expect((await api.post(alice, `/documents/${doc.id}/reactions`, { emoji: 'two words' })).status).toBe(400);
    expect((await api.get(owner, `/documents/${doc.id}`)).body.reactions).toHaveLength(1);

    expect((await api.delete(owner, `/document-reactions/${added.body.id}`)).status).toBe(403);
    expect((await api.delete(alice, `/document-reactions/${added.body.id}`)).status).toBe(200);
    expect(events.at(-1)).toMatchObject({ type: 'guild_document_reaction_remove', documentId: doc.id, reactionId: added.body.id });
  });

  it('keeps each document\'s replies to itself', async () => {
    const { owner, members: [alice], docs, general } = await setUp(1);
    const events = listen(owner);
    const one = (await addDoc(owner, docs, { title: 'One' })).body;
    const two = (await addDoc(owner, docs, { title: 'Two' })).body;

    const first = await reply(alice, docs, one.id, 'About one');
    expect(first.status).toBe(201);
    expect(first.body.document_id).toBe(one.id);
    expect(events.find((e) => e.type === 'guild_message_new')?.message.document_id).toBe(one.id);
    await reply(alice, docs, two.id, 'About two');

    const ofOne = (await api.get(owner, `/channels/${docs.id}/messages?document=${one.id}`)).body;
    expect(ofOne.map((m) => m.content)).toEqual(['About one']);
    // A reply to a reply stays in the same document.
    expect((await reply(owner, docs, two.id, 'Wrong thread', { replyTo: first.body.id })).status).toBe(400);
    expect((await reply(owner, docs, one.id, 'Right thread', { replyTo: first.body.id })).status).toBe(201);

    // A document channel needs a document of its own; a text channel takes none.
    expect((await api.post(owner, `/channels/${docs.id}/messages`, { content: 'No document' })).status).toBe(404);
    expect((await api.get(owner, `/channels/${docs.id}/messages`)).status).toBe(404);
    expect((await reply(owner, general, one.id, 'Wrong channel')).status).toBe(400);

    // Replies are ordinary messages: edits, reactions and deletes work.
    expect((await api.put(alice, `/guild-messages/${first.body.id}`, { content: 'About one!' })).status).toBe(200);
    expect((await api.post(owner, `/guild-messages/${first.body.id}/reactions`, { emoji: '👀' })).status).toBe(201);
    // No pins in a document channel.
    expect((await api.put(owner, `/guild-messages/${first.body.id}/pin`)).status).toBe(400);

    const feed = (await api.get(owner, `/channels/${docs.id}/documents`)).body;
    expect(feed.find((d) => d.id === one.id).reply_count).toBe(2);
    expect(feed.find((d) => d.id === two.id).reply_count).toBe(1);
    expect(feed.find((d) => d.id === one.id).last_reply_id).toBeGreaterThan(first.body.id);
  });

  it('pushes a mention in a reply with a link to the document', async () => {
    const { owner, members: [alice], guild, docs } = await setUp(1);
    const endpoint = `https://push.test/${alice.username}`;
    await api.post(alice, '/save-subscription', { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } });
    const doc = (await addDoc(owner, docs, { title: 'Ping' })).body;
    const before = sentPushes.length;
    await reply(owner, docs, doc.id, `Look <@${alice.id}>`);
    await waitForPushes(1, before);
    const push = sentPushes.slice(before).map((p) => p.payload).find((p) => p.type === 'guild');
    expect(push.url).toBe(`/guild/${guild.id}/${docs.id}?doc=${doc.id}`);
  });

  it('deletes a document with its replies and reactions, in the audit log', async () => {
    const { owner, members: [alice], guild, docs } = await setUp(1);
    const events = listen(alice);
    const doc = (await addDoc(alice, docs, { title: 'Doomed' })).body;
    const first = (await reply(owner, docs, doc.id, 'A reply')).body;
    await api.post(owner, `/guild-messages/${first.id}/reactions`, { emoji: '👍' });
    await api.post(owner, `/documents/${doc.id}/reactions`, { emoji: '👍' });

    expect((await api.delete(alice, `/documents/${doc.id}`)).status).toBe(200);
    expect(events.at(-1)).toMatchObject({ type: 'guild_document_delete', documentId: doc.id, replyIds: [first.id] });
    expect((await api.get(alice, `/documents/${doc.id}`)).status).toBe(404);
    expect((await db.get('SELECT COUNT(*) AS n FROM guild_messages WHERE document_id = ?', [doc.id])).n).toBe(0);
    expect((await db.get('SELECT COUNT(*) AS n FROM guild_reactions WHERE message_id = ?', [first.id])).n).toBe(0);
    expect((await db.get('SELECT COUNT(*) AS n FROM guild_document_reactions WHERE document_id = ?', [doc.id])).n).toBe(0);

    const log = (await api.get(owner, `/guilds/${guild.id}/audit-log`)).body;
    const entry = log.entries.find((e) => e.action === 'document_delete');
    expect(entry).toMatchObject({ actor_id: alice.id, target_id: String(alice.id) });
    expect(JSON.stringify(entry)).not.toContain('Doomed');
  });

  it('deleting the channel deletes its documents', async () => {
    const { owner, guild, docs } = await setUp(0);
    const doc = (await addDoc(owner, docs, { title: 'Gone soon' })).body;
    await reply(owner, docs, doc.id, 'bye');
    expect((await api.delete(owner, `/guilds/${guild.id}/channels/${docs.id}`)).status).toBe(200);
    expect(await db.get('SELECT id FROM guild_documents WHERE id = ?', [doc.id])).toBeUndefined();
    expect((await db.get('SELECT COUNT(*) AS n FROM guild_messages WHERE channel_id = ?', [docs.id])).n).toBe(0);
  });

  it('marks the channel read, and counts new replies as unread', async () => {
    const { owner, members: [alice], docs } = await setUp(1);
    const doc = (await addDoc(owner, docs, { title: 'Read me' })).body;
    const sent = (await reply(owner, docs, doc.id, 'New reply')).body;
    const unread = (await api.get(alice, '/guild-unread')).body.find((r) => r.channel_id === docs.id);
    expect(unread.count).toBe(1);
    expect((await api.post(alice, `/channels/${docs.id}/read`, { messageId: sent.id })).status).toBe(200);
    expect((await api.get(alice, '/guild-unread')).body.find((r) => r.channel_id === docs.id)).toBeUndefined();
  });
});
