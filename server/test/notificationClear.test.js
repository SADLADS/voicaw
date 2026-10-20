import './helpers/mockS3.js';
import './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const { clearChatReactions } = require('../push.js');
const clients = app.locals.clients;

// Reading a chat takes its notification down on the reader's devices (push.js
// clearNotifications): `notification_clear { tags }` to their open pages (and to Android apps,
// fcm.test.js), only when a notification for it went out since they last read it. Reaction
// notifications go when their chat is on one of the user's screens (clearChatReactions, called
// from a socket's presence, which tests can't send).

let userCount = 0;
async function makeUser(prefix = 'clear-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-clear-123';
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  return { id: regRes.body.id, username, token: loginRes.body.token };
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const post = (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body);

function connect(user, presence = {}) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)), presence: { at: Date.now(), ...presence } };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return events;
}

const clears = (events) => events.filter((e) => e.type === 'notification_clear');
const pause = () => new Promise((r) => setTimeout(r, 100));

describe('clearing notifications when a chat is read', () => {
  it('clears a DM notification once it is read, and only once', async () => {
    const [alice, bob] = [await makeUser(), await makeUser()];
    const events = connect(bob);
    expect((await post(alice, '/dm-send', { recipient_id: bob.id, content: 'v1.hi' })).status).toBe(201);
    await expect.poll(() => events.some((e) => e.type === 'message_sound')).toBe(true);

    expect((await post(bob, `/dm-mark-read/${alice.id}`)).status).toBe(200);
    expect(clears(events)).toEqual([{ type: 'notification_clear', tags: [`dm-${alice.id}`] }]);
    // Nothing new was notified: reading again sends nothing.
    await post(bob, `/dm-mark-read/${alice.id}`);
    await pause();
    expect(clears(events)).toHaveLength(1);
  });

  it('sends nothing for a chat that was never notified', async () => {
    const [alice, bob] = [await makeUser(), await makeUser()];
    const events = connect(bob);
    await post(bob, `/dm-mark-read/${alice.id}`);
    await pause();
    expect(clears(events)).toEqual([]);
  });

  it('clears a guild channel only when nothing is left unread in it', async () => {
    const owner = await makeUser('clear-owner');
    const guild = (await post(owner, '/guilds', { name: 'Clears' })).body;
    const general = guild.channels[0];
    const bob = await makeUser();
    const invite = await post(owner, `/guilds/${guild.id}/invites`);
    await post(bob, `/invites/${invite.body.code}`);
    const events = connect(bob);

    const first = (await post(owner, `/channels/${general.id}/messages`, { content: `<@${bob.id}> one` })).body;
    await post(owner, `/channels/${general.id}/messages`, { content: `<@${bob.id}> two` });
    await expect.poll(() => events.filter((e) => e.type === 'message_sound').length).toBe(2);

    // Read up to the first: the second is still unread, so its notification stays.
    await post(bob, `/channels/${general.id}/read`, { messageId: first.id });
    await pause();
    expect(clears(events)).toEqual([]);

    await post(bob, `/channels/${general.id}/read`, { latest: true });
    expect(clears(events)).toEqual([{ type: 'notification_clear', tags: [`channel-${general.id}`] }]);
  });

  it("clears a chat's reaction notifications once it's on screen, and only those that went out", async () => {
    const [ann, bob, carol] = [await makeUser(), await makeUser(), await makeUser()];
    // Ann's desktop app, which takes reactions in encrypted chats.
    const events = connect(ann, { desktopNotifications: true, reactionPushes: true });
    const message = (await post(ann, '/dm-send', { recipient_id: bob.id, content: 'v1.hello' })).body;
    const reaction = `v1.${'A'.repeat(require('../config.js').getMaxEncryptedLength(256) - 3)}`;
    expect((await post(bob, '/dm-reactions', { messageId: message.id, content: reaction })).status).toBe(201);
    await expect.poll(() => events.some((e) => e.type === 'notification' && e.payload.type === 'reaction')).toBe(true);

    clearChatReactions(ann.id, String(carol.id)); // another chat: nothing
    clearChatReactions(ann.id, String(bob.id));
    expect(clears(events)).toEqual([{ type: 'notification_clear', tags: [`reaction-dm-${message.id}`] }]);
    clearChatReactions(ann.id, String(bob.id)); // already gone
    expect(clears(events)).toHaveLength(1);
  });
});
