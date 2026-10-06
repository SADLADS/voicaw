import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const { PERMISSIONS: P } = require('../permissions.js');
const { toDiscordPermissions } = require('../discord.js');

let userCount = 0;
async function makeUser(prefix = 'vc-user') {
  const username = `${prefix}-${++userCount}`;
  const { response: regRes } = await registerUser(app, request, username, 'pw-voice-chat-1');
  const { response: loginRes } = await loginUser(app, request, username, 'pw-voice-chat-1');
  return { id: regRes.body.id, username, token: loginRes.body.token };
}
const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
};
const discord = {
  get: (bot, url) => request(app).get(`/api/v10${url}`).set({ Authorization: `Bot ${bot.token}` }),
  post: (bot, url, body = {}) => request(app).post(`/api/v10${url}`).set({ Authorization: `Bot ${bot.token}` }).send(body),
};

// A guild with a voice channel, a member who isn't in its call, and a bot.
async function setUp() {
  const owner = await makeUser('vc-owner');
  const member = await makeUser('vc-member');
  const guild = (await api.post(owner, '/guilds', { name: 'Voice Chat' })).body;
  const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
  await api.post(member, `/invites/${invite.body.code}`);
  const lounge = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'Lounge', type: 'voice' })).body;
  const created = await api.post(owner, '/applications', { name: 'Chatter' });
  const bot = { id: created.body.id, token: created.body.token };
  await api.post(owner, '/oauth2/authorize', { client_id: bot.id, guild_id: guild.id, permissions: toDiscordPermissions(P.VIEW_CHANNEL | P.SEND_MESSAGES | P.MANAGE_MESSAGES) });
  return { owner, member, guild, lounge, bot };
}

describe("voice channels' chat", () => {
  it('takes messages from anyone who can see the channel, in the call or not', async () => {
    const { owner, member, guild, lounge } = await setUp();
    const sent = await api.post(member, `/channels/${lounge.id}/messages`, { content: 'hi from outside the call' });
    expect(sent.status).toBe(201);
    const history = (await api.get(owner, `/channels/${lounge.id}/messages`)).body;
    expect(history.messages ?? history).toEqual(expect.arrayContaining([expect.objectContaining({ id: sent.body.id, content: 'hi from outside the call' })]));

    // Unread until read.
    let unread = (await api.get(owner, '/guild-unread')).body;
    expect(unread).toEqual(expect.arrayContaining([expect.objectContaining({ channel_id: lounge.id, count: 1 })]));
    expect((await api.post(owner, `/channels/${lounge.id}/read`, { messageId: sent.body.id })).status).toBe(200);
    unread = (await api.get(owner, '/guild-unread')).body;
    expect(unread.find((r) => r.channel_id === lounge.id)).toBeUndefined();

    expect((await api.post(owner, '/typing', { chatId: `channel-${lounge.id}` })).status).toBe(204);

    // Pinned, and found by search.
    expect((await api.put(owner, `/guild-messages/${sent.body.id}/pin`)).status).toBe(200);
    expect((await api.get(member, `/channels/${lounge.id}/pins`)).body.map((m) => m.id)).toEqual([sent.body.id]);
    const found = (await api.get(member, `/guilds/${guild.id}/messages/search?content=outside`)).body;
    expect(found.messages.map((m) => m.id)).toEqual([sent.body.id]);
  });

  it('follows Send Messages and View Channel', async () => {
    const { owner, member, guild, lounge } = await setUp();
    const everyone = (await api.get(owner, `/guilds/${guild.id}`)).body.roles.find((r) => r.is_everyone);
    await api.put(owner, `/guilds/${guild.id}/channels/${lounge.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.SEND_MESSAGES });
    expect((await api.post(member, `/channels/${lounge.id}/messages`, { content: 'nope' })).status).toBe(403);
    await api.put(owner, `/guilds/${guild.id}/channels/${lounge.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.VIEW_CHANNEL });
    expect((await api.get(member, `/channels/${lounge.id}/messages`)).status).toBe(404);
  });

  it('has no threads, as in Discord', async () => {
    const { owner, lounge } = await setUp();
    expect((await api.post(owner, `/channels/${lounge.id}/threads`, { name: 'side' })).status).toBe(400);
  });

  it('takes webhooks', async () => {
    const { owner, lounge } = await setUp();
    const hook = await api.post(owner, `/channels/${lounge.id}/webhooks`, { name: 'Alerts' });
    expect(hook.status).toBe(200);
    const posted = await request(app).post(`/api/webhooks/${hook.body.id}/${hook.body.token}?wait=true`).send({ content: 'deploy done' });
    expect(posted.status).toBe(200);
    expect(posted.body).toMatchObject({ channel_id: String(lounge.id), content: 'deploy done' });
  });

  it("is a Discord voice channel's chat for bots", async () => {
    const { member, lounge, bot } = await setUp();
    const sent = await discord.post(bot, `/channels/${lounge.id}/messages`, { content: 'beep' });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ channel_id: String(lounge.id), content: 'beep' });
    const channel = (await discord.get(bot, `/channels/${lounge.id}`)).body;
    expect(channel).toMatchObject({ type: 2, last_message_id: sent.body.id });

    const theirs = (await api.post(member, `/channels/${lounge.id}/messages`, { content: 'boop' })).body;
    const read = (await discord.get(bot, `/channels/${lounge.id}/messages`)).body;
    expect(read.map((m) => m.content)).toEqual(['boop', 'beep']);
    expect(read[0].id).toBe(String(theirs.id));
  });
});
