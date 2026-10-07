import { objects } from './helpers/mockS3.js';
import { sentPushes, waitForPushes } from './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const sharp = require('sharp');
const app = require('../index.js');
const { PERMISSIONS: P, DEFAULT_EVERYONE_PERMISSIONS } = require('../permissions.js');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser(prefix = 'hook-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-webhooks-123';
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

// A webhook's own paths (no login), as a Discord client would use them.
const hookPath = (hook, rest = '') => `/api/webhooks/${hook.id}/${hook.token}${rest}`;

function connect(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)), presence: { at: Date.now() } };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return events;
}

// A guild (owner + one member) with its #general, and a webhook there made by the owner.
async function setUp() {
  const owner = await makeUser('h-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Hooks' })).body;
  const member = await makeUser('h-member');
  const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
  await api.post(member, `/invites/${invite.body.code}`);
  const general = guild.channels[0];
  const hook = (await api.post(owner, `/channels/${general.id}/webhooks`, { name: 'Captain Hook' })).body;
  return { owner, member, guild, general, hook, everyone: guild.roles.find((r) => r.is_everyone) };
}

const messagesIn = async (user, channel) => (await api.get(user, `/channels/${channel.id}/messages`)).body;
const png = (color = '#3080ff', size = 40) => sharp({ create: { width: size, height: size / 2, channels: 3, background: color } }).png().toBuffer();

describe('managing webhooks (logged in)', () => {
  it('needs Manage Webhooks; creates one with a Discord-style token and URL', async () => {
    const { owner, member, guild, general, hook, everyone } = await setUp();
    expect(hook).toMatchObject({ type: 1, id: expect.any(String), name: 'Captain Hook', channel_id: String(general.id), guild_id: String(guild.id), avatar: null });
    expect(hook.token).toMatch(/^[A-Za-z0-9_-]{68}$/);
    expect(hook.url).toMatch(new RegExp(`/api/webhooks/${hook.id}/${hook.token}$`));
    expect(hook.user).toMatchObject({ id: String(owner.id), username: owner.username });

    expect((await api.post(member, `/channels/${general.id}/webhooks`, { name: 'Nope' })).status).toBe(403);
    expect((await api.get(member, `/channels/${general.id}/webhooks`)).status).toBe(403);
    expect((await api.delete(member, `/webhooks/${hook.id}`)).status).toBe(403);

    // A role with Manage Webhooks.
    await api.patch(owner, `/guilds/${guild.id}/roles/${everyone.id}`, { permissions: DEFAULT_EVERYONE_PERMISSIONS | P.MANAGE_WEBHOOKS });
    const second = await api.post(member, `/channels/${general.id}/webhooks`, { name: 'Spidey Bot' });
    expect(second.status).toBe(200);
    expect((await api.get(member, `/channels/${general.id}/webhooks`)).body.map((h) => h.name)).toEqual(['Captain Hook', 'Spidey Bot']);
    expect((await api.get(owner, `/guilds/${guild.id}/webhooks`)).body).toHaveLength(2);

    expect((await api.post(owner, `/channels/${general.id}/webhooks`, { name: '' })).body).toMatchObject({ code: 50035, errors: { name: { _errors: [expect.any(Object)] } } });
    const outsider = await makeUser();
    expect((await api.get(outsider, `/webhooks/${hook.id}`)).status).toBe(404);
  });

  it('renames, changes the picture and channel, and deletes', async () => {
    const { owner, guild, hook } = await setUp();
    const other = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'alerts', type: 'text' })).body;
    const avatar = `data:image/png;base64,${(await png()).toString('base64')}`;
    const changed = (await api.patch(owner, `/webhooks/${hook.id}`, { name: 'Deploys', avatar, channel_id: String(other.id) })).body;
    expect(changed).toMatchObject({ name: 'Deploys', channel_id: String(other.id), avatar: expect.any(String) });
    expect(changed.avatar_url).toContain(`/profile-pics/webhooks/${hook.id}/${changed.avatar}.webp`);
    expect(objects.get(`profile-pics/webhooks/${hook.id}/${changed.avatar}.webp`).contentType).toBe('image/webp');

    const list = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'tasks', type: 'list' })).body;
    expect((await api.patch(owner, `/webhooks/${hook.id}`, { channel_id: list.id })).status).toBe(400);
    expect((await api.patch(owner, `/webhooks/${hook.id}`, { avatar: 'data:image/png;base64,bm90IGFuIGltYWdl' })).body).toMatchObject({ code: 50035 });

    expect((await api.delete(owner, `/webhooks/${hook.id}`)).status).toBe(204);
    expect((await request(app).get(hookPath(hook))).body).toMatchObject({ code: 10015 });
  });

  it("goes with its channel", async () => {
    const { owner, guild, general, hook } = await setUp();
    await api.delete(owner, `/guilds/${guild.id}/channels/${general.id}`);
    expect((await request(app).post(hookPath(hook)).send({ content: 'hi' })).status).toBe(404);
  });
});

describe('executing a webhook (Discord API)', () => {
  it('posts JSON as the webhook, live, and answers 204 or (wait=true) the message', async () => {
    const { member, general, hook } = await setUp();
    const events = connect(member);
    const res = await request(app).post(hookPath(hook)).send({ content: 'Build **passed**' });
    expect(res.status).toBe(204);

    const [message] = (await messagesIn(member, general)).slice(-1);
    expect(message).toMatchObject({
      sender_id: 0, webhook_id: Number(hook.id), webhook_name: 'Captain Hook', sender_username: 'Captain Hook',
      webhook_avatar: null, content: 'Build **passed**', embeds: [], attachments: [],
    });
    expect(events.find((e) => e.type === 'guild_message_new').message.id).toBe(message.id);
    // Unread for members, like anyone else's message.
    expect((await api.get(member, '/guild-unread')).body.find((u) => u.channel_id === general.id).count).toBeGreaterThan(0);

    const waited = await request(app).post(`${hookPath(hook)}?wait=true`).send({ content: 'again', username: 'CI', avatar_url: 'https://example.com/ci.png' });
    expect(waited.status).toBe(200);
    expect(waited.body).toMatchObject({
      id: expect.any(String), type: 0, content: 'again', channel_id: String(general.id), webhook_id: hook.id,
      author: { id: hook.id, username: 'CI', bot: true }, embeds: [], attachments: [], mention_everyone: false,
      timestamp: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), edited_timestamp: null,
    });
    const [overridden] = (await messagesIn(member, general)).slice(-1);
    expect(overridden).toMatchObject({ webhook_name: 'CI', webhook_avatar: 'https://example.com/ci.png' });
  });

  it("answers on Discord's versioned paths, and to forms", async () => {
    const { member, general, hook } = await setUp();
    expect((await request(app).post(`/api/v10/webhooks/${hook.id}/${hook.token}`).send({ content: 'v10' })).status).toBe(204);
    expect((await request(app).get(`/api/v9/webhooks/${hook.id}/${hook.token}`)).body).toMatchObject({ id: hook.id, name: 'Captain Hook' });
    const form = await request(app).post(hookPath(hook)).type('form').send({ content: 'from a form' });
    expect(form.status).toBe(204);
    expect((await messagesIn(member, general)).map((m) => m.content).slice(-2)).toEqual(['v10', 'from a form']);
  });

  it('keeps embeds, checked like Discord does', async () => {
    const { member, general, hook } = await setUp();
    const embed = {
      title: 'Deploy', url: 'https://ci.example/1', description: 'All **good**', color: 0x57F287,
      timestamp: '2026-09-30T12:00:00.000Z', author: { name: 'bot', icon_url: 'https://ci.example/a.png' },
      fields: [{ name: 'Branch', value: 'dev', inline: true }, { name: 'Time', value: '3m' }],
      footer: { text: 'CI' }, image: { url: 'https://ci.example/chart.png' }, thumbnail: { url: 'https://ci.example/t.png' },
      video: { url: 'https://ignored.example' },
    };
    expect((await request(app).post(hookPath(hook)).send({ embeds: [embed] })).status).toBe(204);
    const [message] = (await messagesIn(member, general)).slice(-1);
    expect(message.content).toBe('');
    expect(message.embeds).toEqual([{
      type: 'rich', title: 'Deploy', url: 'https://ci.example/1', description: 'All **good**', color: 0x57F287,
      timestamp: '2026-09-30T12:00:00.000Z', author: { name: 'bot', icon_url: 'https://ci.example/a.png' },
      fields: [{ name: 'Branch', value: 'dev', inline: true }, { name: 'Time', value: '3m', inline: false }],
      footer: { text: 'CI' }, image: { url: 'https://ci.example/chart.png' }, thumbnail: { url: 'https://ci.example/t.png' },
    }]);

    const tooLong = await request(app).post(hookPath(hook)).send({ embeds: [{ title: 'x'.repeat(257) }] });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body).toMatchObject({ code: 50035, message: 'Invalid Form Body', errors: { embeds: { 0: { title: { _errors: [{ code: 'BASE_TYPE_MAX_LENGTH' }] } } } } });
    expect((await request(app).post(hookPath(hook)).send({ embeds: [{ url: 'javascript:alert(1)' }] })).body.errors.embeds[0].url).toBeDefined();
    expect((await request(app).post(hookPath(hook)).send({ embeds: [{ color: -1 }] })).status).toBe(400);
    expect((await request(app).post(hookPath(hook)).send({ embeds: Array(11).fill({ title: 'x' }) })).status).toBe(400);
    expect((await request(app).post(hookPath(hook)).send({ embeds: [{ description: 'x'.repeat(4000) }, { description: 'x'.repeat(2001) }] })).body)
      .toMatchObject({ code: 50035 });
  });

  it('refuses bad requests the way Discord does', async () => {
    const { hook } = await setUp();
    expect((await request(app).post(`/api/webhooks/${hook.id}/wrong`).send({ content: 'x' })).body).toMatchObject({ code: 50027, message: 'Invalid Webhook Token' });
    expect((await request(app).post(`/api/webhooks/999999/${hook.token}`).send({ content: 'x' })).status).toBe(404);
    expect((await request(app).post(hookPath(hook)).send({ content: '   ' })).body).toMatchObject({ code: 50006 });
    expect((await request(app).post(hookPath(hook)).send({})).status).toBe(400);
    expect((await request(app).post(hookPath(hook)).set('Content-Type', 'application/json').send('{"content":')).body).toMatchObject({ code: 50109 });
    expect((await request(app).post(`${hookPath(hook)}?thread_id=5`).send({ content: 'x' })).status).toBe(400);
    expect((await request(app).post(hookPath(hook)).send({ content: 'x', username: 'y'.repeat(81) })).body.errors.username).toBeDefined();
    expect((await request(app).post(hookPath(hook)).send({ content: 'x', avatar_url: 'ftp://x' })).status).toBe(400);
  });

  it('takes files (multipart with payload_json), usable in embeds as attachment://', async () => {
    const { member, general, hook } = await setUp();
    const image = await png('#ff0000', 64);
    const res = await request(app)
      .post(`${hookPath(hook)}?wait=true`)
      .field('payload_json', JSON.stringify({
        content: 'report',
        embeds: [{ title: 'Chart', image: { url: 'attachment://chart.png' } }],
        attachments: [{ id: 0, description: 'the chart' }],
      }))
      .attach('files[0]', image, { filename: 'chart.png', contentType: 'image/png' })
      .attach('files[1]', Buffer.from('<script>alert(1)</script>'), { filename: 'page one.html', contentType: 'text/html' });
    expect(res.status).toBe(200);
    const [chart, page] = res.body.attachments;
    expect(chart).toMatchObject({ filename: 'chart.png', size: image.length, content_type: 'image/png', width: 64, height: 32, description: 'the chart' });
    expect(chart.url).toMatch(/\/uploads\/webhooks\/[0-9a-f-]+\/chart\.png$/);
    expect(page).toMatchObject({ filename: 'page_one.html', content_type: 'application/octet-stream' });
    expect(objects.get(page.url.slice(page.url.indexOf('uploads/'))).contentType).toBe('application/octet-stream');
    expect(res.body.embeds[0].image).toEqual({ url: chart.url, width: 64, height: 32 });

    const [message] = (await messagesIn(member, general)).slice(-1);
    expect(message.attachments.map((a) => a.filename)).toEqual(['chart.png', 'page_one.html']);

    // Just a file, the simplest multipart (curl -F file=@x).
    const only = await request(app).post(hookPath(hook)).attach('file', image, { filename: 'x.png', contentType: 'image/png' });
    expect(only.status).toBe(204);

    // discord.py sends every file as application/octet-stream: the type comes from the name,
    // checked against the contents for pictures.
    const sent = await request(app)
      .post(`${hookPath(hook)}?wait=true`)
      .attach('files[0]', image, { filename: 'graph.png', contentType: 'application/octet-stream' })
      .attach('files[1]', Buffer.from('not a picture'), { filename: 'fake.png', contentType: 'application/octet-stream' })
      .attach('files[2]', Buffer.from('ID3'), { filename: 'song.MP3', contentType: 'application/octet-stream' });
    const [graph, fake, song] = sent.body.attachments;
    expect(graph).toMatchObject({ content_type: 'image/png', width: 64, height: 32 });
    expect(objects.get(graph.url.slice(graph.url.indexOf('uploads/'))).contentType).toBe('image/png');
    expect(fake.content_type).toBe('application/octet-stream');
    expect(fake.width).toBeUndefined();
    expect(song.content_type).toBe('audio/mpeg');
  });

  it('pings like Discord: everything by default, narrowed by allowed_mentions', async () => {
    const { member, general, hook } = await setUp();
    const mentions = async () => (await api.get(member, '/guild-unread')).body.find((u) => u.channel_id === general.id)?.mentions ?? 0;

    await request(app).post(hookPath(hook)).send({ content: '@everyone deploy' });
    expect(await mentions()).toBe(1);
    await request(app).post(hookPath(hook)).send({ content: `@everyone <@${member.id}> quiet`, allowed_mentions: { parse: [] } });
    expect(await mentions()).toBe(1);
    await request(app).post(hookPath(hook)).send({ content: `@everyone <@${member.id}>`, allowed_mentions: { users: [String(member.id)] } });
    expect(await mentions()).toBe(2);
    const [last] = (await messagesIn(member, general)).slice(-1);
    expect(last.mention_everyone).toBe(0);
    expect((await request(app).post(hookPath(hook)).send({ content: 'x', allowed_mentions: { parse: ['users'], users: ['1'] } })).status).toBe(400);
  });

  it('pushes as the webhook, unless it asks not to', async () => {
    const { member, general, hook } = await setUp();
    await api.post(member, '/save-subscription', { subscription: { endpoint: `https://push.test/${member.username}`, keys: { p256dh: 'p', auth: 'a' } } });
    let since = sentPushes.length;
    await request(app).post(hookPath(hook)).send({ content: '@everyone shipped', username: 'Deployer' });
    await waitForPushes(1000, since, 300);
    const push = sentPushes.slice(since).find((p) => p.endpoint === `https://push.test/${member.username}`);
    expect(push.payload).toMatchObject({ title: `Deployer (#${general.name}, Hooks)`, body: '@everyone shipped', image: '/default.png' });

    since = sentPushes.length;
    await request(app).post(hookPath(hook)).send({ content: '@everyone shh', flags: 1 << 12 });
    await waitForPushes(1000, since, 300);
    expect(sentPushes.slice(since).filter((p) => p.endpoint === `https://push.test/${member.username}`)).toHaveLength(0);
  });
});

describe('a webhook with its token', () => {
  it('reads, edits and deletes only its own messages', async () => {
    const { owner, member, general, hook } = await setUp();
    const events = connect(member);
    const sent = (await request(app).post(`${hookPath(hook)}?wait=true`).send({ content: 'v1', embeds: [{ title: 'a' }] })).body;
    expect((await request(app).get(hookPath(hook, `/messages/${sent.id}`))).body).toMatchObject({ id: sent.id, content: 'v1' });

    const edited = await request(app).patch(hookPath(hook, `/messages/${sent.id}`)).send({ content: 'v2', embeds: [] });
    expect(edited.body).toMatchObject({ content: 'v2', embeds: [], edited_timestamp: expect.any(String) });
    expect(events.find((e) => e.type === 'guild_message_edit')).toMatchObject({ messageId: Number(sent.id), content: 'v2', embeds: [] });
    const [message] = (await messagesIn(member, general)).slice(-1);
    expect(message).toMatchObject({ content: 'v2', edited: 1 });
    expect((await request(app).patch(hookPath(hook, `/messages/${sent.id}`)).send({ content: '' })).body).toMatchObject({ code: 50006 });

    // Not another webhook's, nor a person's.
    const other = (await api.post(owner, `/channels/${general.id}/webhooks`, { name: 'Other' })).body;
    expect((await request(app).patch(hookPath(other, `/messages/${sent.id}`)).send({ content: 'x' })).status).toBe(404);
    const mine = (await api.post(member, `/channels/${general.id}/messages`, { content: 'hi' })).body;
    expect((await request(app).delete(hookPath(hook, `/messages/${mine.id}`))).status).toBe(404);
    // People can't edit it; Manage Messages can delete it.
    expect((await api.put(member, `/guild-messages/${sent.id}`, { content: 'hack' })).status).toBe(403);

    expect((await request(app).delete(hookPath(hook, `/messages/${sent.id}`))).status).toBe(204);
    expect(events.find((e) => e.type === 'guild_message_delete')).toMatchObject({ messageId: Number(sent.id) });
    expect((await request(app).get(hookPath(hook, `/messages/${sent.id}`))).status).toBe(404);
  });

  it('changes its name and picture (not its channel), and deletes itself; old messages stay', async () => {
    const { member, general, hook } = await setUp();
    await request(app).post(hookPath(hook)).send({ content: 'before' });
    const avatar = `data:image/png;base64,${(await png()).toString('base64')}`;
    const changed = (await request(app).patch(hookPath(hook)).send({ name: 'Renamed', avatar })).body;
    expect(changed).toMatchObject({ name: 'Renamed', avatar: expect.any(String) });
    expect(changed.user).toBeUndefined();
    expect((await request(app).patch(hookPath(hook)).send({ channel_id: general.id })).status).toBe(400);

    await request(app).post(hookPath(hook)).send({ content: 'after' });
    const [before, after] = (await messagesIn(member, general)).slice(-2);
    expect(before).toMatchObject({ webhook_name: 'Captain Hook', webhook_avatar: null });
    expect(after).toMatchObject({ webhook_name: 'Renamed', webhook_avatar: changed.avatar_url });

    expect((await request(app).delete(hookPath(hook))).status).toBe(204);
    expect((await request(app).post(hookPath(hook)).send({ content: 'gone' })).status).toBe(404);
    expect((await messagesIn(member, general)).slice(-2).map((m) => m.content)).toEqual(['before', 'after']);
  });

describe('webhooks and pins', () => {
  it("pins a webhook's message; the pins list has its name and embeds", async () => {
    const { owner, general, hook } = await setUp();
    const sent = (await request(app).post(`${hookPath(hook)}?wait=true`).send({ embeds: [{ title: 'Pin me' }] })).body;
    expect((await api.put(owner, `/guild-messages/${sent.id}/pin`)).status).toBe(200);
    const [pinned] = (await api.get(owner, `/channels/${general.id}/pins`)).body;
    expect(pinned).toMatchObject({ id: Number(sent.id), webhook_name: 'Captain Hook', sender_username: 'Captain Hook', embeds: [{ title: 'Pin me' }], pinned_by: owner.id });
  });
});
});
