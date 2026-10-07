import './helpers/mockS3.js';
import { sentPushes, waitForPushes } from './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

// Notifications when someone reacts to your message (reactionPushes.js).
const app = require('../index.js');
const db = require('../db.js');
const clients = app.locals.clients;

// A DM reaction envelope: "v1." + base64(IV || 256 padded bytes || tag).
const REACTION = `v1.${'A'.repeat(require('../config.js').getMaxEncryptedLength(256) - 3)}`;
const POLL = `poll:v1:${JSON.stringify({ q: 'Lunch?', multi: false, o: [{ id: 'aaaa1111', t: 'Pizza' }] })}`;

let userCount = 0;
async function makeUser(prefix = 'rp') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-react-push-1';
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  const user = { id: regRes.body.id, username, token: loginRes.body.token };
  // A browser subscribed to web push, and the desktop app (which says it drops reactions it
  // shouldn't show), each collecting what it's sent.
  user.endpoint = `https://push.test/${username}`;
  await api.post(user, '/save-subscription', { subscription: { endpoint: user.endpoint, keys: { p256dh: 'p', auth: 'a' } } });
  user.desktop = connect(user, { desktopNotifications: true, reactionPushes: true });
  return user;
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
};

// A socket for `user` with `presence`; -> the notifications it's sent.
function connect(user, presence) {
  const notifications = [];
  const ws = { readyState: 1, send: (m) => { const e = JSON.parse(m); if (e.type === 'notification') notifications.push(e.payload); }, presence: { at: Date.now(), ...presence } };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  notifications.ws = ws;
  return notifications;
}

const settle = () => new Promise((r) => setTimeout(r, 100));
const webPushesTo = (user, since) => sentPushes.slice(since).filter((p) => p.endpoint === user.endpoint && p.payload.type === 'reaction');
const reactionsOn = (notifications) => notifications.filter((p) => p.type === 'reaction');

async function dmPair() {
  const [ann, bob] = [await makeUser(), await makeUser()];
  const message = (await api.post(ann, '/dm-send', { recipient_id: bob.id, content: 'v1.hello' })).body;
  ann.desktop.length = 0;
  return { ann, bob, message };
}
const reactDm = (user, message) => api.post(user, '/dm-reactions', { messageId: message.id, content: REACTION });

describe('reaction notifications in DMs', () => {
  it("go to the author's apps only, with the encrypted reaction and message", async () => {
    const { ann, bob, message } = await dmPair();
    const old = connect(ann, { desktopNotifications: true }); // a desktop app from before
    const since = sentPushes.length;
    expect((await reactDm(bob, message)).status).toBe(201);
    await settle();
    expect(reactionsOn(ann.desktop)).toEqual([expect.objectContaining({
      type: 'reaction', chat: 'dm', url: `/dm/${bob.id}`, tag: `reaction-dm-${message.id}`,
      messageId: message.id, reactorId: bob.id, senderId: ann.id, recipientId: bob.id,
      reaction: REACTION, ciphertext: 'v1.hello',
    })]);
    // Never a browser (it would have to show something even for a poll vote), nor an old app.
    expect(webPushesTo(ann, since)).toEqual([]);
    expect(reactionsOn(old)).toEqual([]);
    // Nor the reactor, nor about the same reactor again straight away.
    expect(reactionsOn(bob.desktop)).toEqual([]);
    await api.post(bob, '/dm-reactions', { messageId: message.id, content: REACTION });
    await settle();
    expect(reactionsOn(ann.desktop)).toHaveLength(1);
  });

  it('not for your own reactions, notes, or a muted or blocked conversation', async () => {
    const { ann, bob, message } = await dmPair();
    await reactDm(ann, message);
    const note = (await api.post(ann, '/dm-send', { recipient_id: ann.id, content: 'v1.note' })).body;
    await reactDm(ann, note);
    await settle();
    expect(reactionsOn(ann.desktop)).toEqual([]);

    expect((await api.put(ann, `/conversation-settings/dm/${bob.id}`, { mute: { duration: null } })).status).toBe(200);
    await reactDm(bob, message);
    await settle();
    expect(reactionsOn(ann.desktop)).toEqual([]);

    const other = await dmPair();
    expect((await api.put(other.ann, `/blocks/${other.bob.id}`)).status).toBeLessThan(300);
    await reactDm(other.bob, other.message);
    await settle();
    expect(reactionsOn(other.ann.desktop)).toEqual([]);
  });

  it('not while looking at the conversation', async () => {
    const { ann, bob, message } = await dmPair();
    Object.assign(ann.desktop.ws.presence, { visible: true, chatId: String(bob.id) });
    await reactDm(bob, message);
    await settle();
    expect(reactionsOn(ann.desktop)).toEqual([]);
  });

  it('follow the reactionNotifications preference', async () => {
    const { ann, bob, message } = await dmPair();
    expect((await api.put(ann, '/preferences', { reactionNotifications: 'sometimes' })).status).toBe(400);
    expect((await api.put(ann, '/preferences', { reactionNotifications: 'off' })).body.reactionNotifications).toBe('off');
    await reactDm(bob, message);
    await settle();
    expect(reactionsOn(ann.desktop)).toEqual([]);

    const other = await dmPair();
    expect((await api.get(other.ann, '/preferences')).body.reactionNotifications).toBe('all');
    await api.put(other.ann, '/preferences', { reactionNotifications: 'dms' });
    await reactDm(other.bob, other.message);
    await settle();
    expect(reactionsOn(other.ann.desktop)).toHaveLength(1);
  });

  it('reach Android apps only if their subscription says they can drop them', async () => {
    const ann = await makeUser();
    const save = (fcm) => api.post(ann, '/save-subscription', { subscription: { endpoint: `fcm:${fcm.token}`, fcm } });
    const key = Buffer.alloc(32, 1).toString('base64');
    expect((await save({ token: 'new-phone', key, reactionPushes: true })).status).toBe(200);
    expect((await save({ token: 'old-phone', key })).status).toBe(200);
    const rows = await db.all("SELECT endpoint, subscription FROM push_subscriptions WHERE user_id = ? AND endpoint LIKE 'fcm:%' ORDER BY endpoint", [ann.id]);
    expect(rows.map((r) => JSON.parse(r.subscription).fcm.reactionPushes)).toEqual([true, undefined]);
  });
});

// A guild where `ann` (its owner) has written a message and `bob` is a member.
async function guildPair() {
  const [ann, bob] = [await makeUser('rpg'), await makeUser('rpg')];
  const guild = (await api.post(ann, '/guilds', { name: 'Reacts' })).body;
  const invite = await api.post(ann, `/guilds/${guild.id}/invites`);
  await api.post(bob, `/invites/${invite.body.code}`);
  const general = guild.channels[0];
  const message = (await api.post(ann, `/channels/${general.id}/messages`, { content: 'Lunch at noon' })).body;
  return { ann, bob, guild, general, message };
}
const reactGuild = (user, message, emoji = '👍') => api.post(user, `/guild-messages/${message.id}/reactions`, { emoji });

describe('reaction notifications in guilds', () => {
  it('go to every device of the author, worded by the server', async () => {
    const { ann, bob, guild, general, message } = await guildPair();
    const since = sentPushes.length;
    expect((await reactGuild(bob, message)).status).toBe(201);
    const [push] = (await waitForPushes(1, since)).filter((p) => p.endpoint === ann.endpoint);
    expect(push.payload).toMatchObject({
      type: 'reaction', chat: 'guild', emoji: '👍', preview: 'Lunch at noon',
      body: 'Reacted 👍 to your message: Lunch at noon',
      url: `/guild/${guild.id}/${general.id}`, tag: `reaction-guild-${message.id}`,
    });
    expect(push.payload.title).toMatch(/#general, Reacts\)$/);
    expect(reactionsOn(ann.desktop)).toHaveLength(1);
    expect(webPushesTo(bob, since)).toEqual([]);
  });

  it("not for poll votes, the 'nothing' level, a muted channel or the 'dms' preference", async () => {
    const { ann, bob, general } = await guildPair();
    const since = sentPushes.length;
    const poll = (await api.post(ann, `/channels/${general.id}/messages`, { content: POLL })).body;
    expect((await reactGuild(bob, poll, 'poll:aaaa1111')).status).toBe(201);
    await settle();
    expect(webPushesTo(ann, since)).toEqual([]);

    const levels = await guildPair();
    await api.put(levels.ann, `/guilds/${levels.guild.id}/notifications`, { level: 'none' });
    await reactGuild(levels.bob, levels.message);
    const muted = await guildPair();
    expect((await api.put(muted.ann, `/channels/${muted.general.id}/mute`, {})).status).toBeLessThan(300);
    await reactGuild(muted.bob, muted.message);
    const dmsOnly = await guildPair();
    await api.put(dmsOnly.ann, '/preferences', { reactionNotifications: 'dms' });
    await reactGuild(dmsOnly.bob, dmsOnly.message);
    await settle();
    for (const { ann: author } of [levels, muted, dmsOnly]) expect(webPushesTo(author, since)).toEqual([]);
  });

  it('do count at the default mentions level', async () => {
    const { ann, bob, message } = await guildPair();
    const since = sentPushes.length;
    await reactGuild(bob, message, '🎉');
    expect((await waitForPushes(1, since)).filter((p) => p.endpoint === ann.endpoint)).toHaveLength(1);
  });
});
