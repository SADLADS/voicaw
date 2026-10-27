import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const { PERMISSIONS: P } = require('../permissions.js');
const { HAS, searchHas, searchText } = require('../searchText.js');

let userCount = 0;
async function makeUser(prefix = 'search-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-search-123';
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  return { id: regRes.body.id, username, token: loginRes.body.token };
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url, query) => request(app).get(`/api${url}`).query(query ?? {}).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
  delete: (user, url) => request(app).delete(`/api${url}`).set(authed(user)),
};

async function setUpGuild() {
  const owner = await makeUser('search-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Search Guild' })).body;
  const members = [];
  for (let i = 0; i < 2; i++) {
    const user = await makeUser();
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(user, `/invites/${invite.body.code}`);
    members.push(user);
  }
  const random = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'random' })).body;
  return { owner, members, guild, general: guild.channels[0], random, everyone: guild.roles.find((r) => r.is_everyone) };
}

const post = async (user, channel, content) => (await api.post(user, `/channels/${channel.id}/messages`, { content })).body.id;
const search = (user, guild, query) => api.get(user, `/guilds/${guild.id}/messages/search`, query);
const found = async (user, guild, query) => {
  const res = await search(user, guild, query);
  expect(res.status).toBe(200);
  return res.body.messages.map((m) => m.id);
};

const upload = (name, type) => `![${name}](https://media.example/uploads/abc.bin#v=1&k=secretkey&t=${encodeURIComponent(type)}&s=10)`;

describe('what gets indexed', () => {
  it('keeps names and words, not links, keys or mention ids', () => {
    const text = searchText({ content: `hello <@12> <@&3> <#45> <:party_parrot:99> ${upload('holiday.png', 'image/png')} ![GIF](https://static.klipy.com/x.webp#gif&w=1&h=1)` });
    expect(text).toContain('hello');
    expect(text).toContain('party_parrot');
    expect(text).toContain('holiday.png');
    expect(text).not.toMatch(/secretkey|klipy|12|45|GIF/);
    expect(searchText({ content: 'poll:v1:{"q":"Lunch?","multi":false,"o":[{"id":"aaaaaaaa","t":"Pizza"}]}' })).toBe('Lunch?\nPizza');
    expect(searchText({ content: '', embeds: JSON.stringify([{ title: 'Build', fields: [{ name: 'Status', value: 'green' }] }]), attachments: JSON.stringify([{ filename: 'log.txt' }]) }))
      .toBe('Build\nStatus\ngreen\nlog.txt');
  });

  it('works out has:', () => {
    expect(searchHas({ content: 'see https://example.com' })).toBe(HAS.link);
    expect(searchHas({ content: upload('a.png', 'image/png') })).toBe(HAS.file | HAS.image);
    expect(searchHas({ content: upload('a.mp4', 'video/mp4') })).toBe(HAS.file | HAS.video);
    expect(searchHas({ content: upload('a.ogg', 'audio/ogg') })).toBe(HAS.file | HAS.sound);
    expect(searchHas({ content: upload('a.zip', 'application/zip') })).toBe(HAS.file);
    expect(searchHas({ content: '![GIF](https://static.klipy.com/x.webp#gif&w=1&h=1)' })).toBe(HAS.image);
    expect(searchHas({ content: 'poll:v1:{"q":"?","o":[]}' })).toBe(HAS.poll);
    expect(searchHas({ content: `fwd:v1:{"t":1}\nsee ${upload('a.png', 'image/png')}` })).toBe(HAS.forward | HAS.file | HAS.image);
    expect(searchText({ content: `fwd:v1:{"t":1}\nsee <@4> ${upload('a.png', 'image/png')}` })).toBe(searchText({ content: `see <@4> ${upload('a.png', 'image/png')}` }));
    expect(searchHas({ content: '', embeds: '[{"title":"x"}]', attachments: '[{"content_type":"image/png"}]' })).toBe(HAS.embed | HAS.file | HAS.image);
  });
});

describe('guild search', () => {
  it('finds words by prefix, phrases exactly, and follows edits and deletes', async () => {
    const { owner, members: [alice], guild, general } = await setUpGuild();
    const pizza = await post(alice, general, 'Who wants pizza tonight?');
    const pasta = await post(owner, general, 'Pasta beats pizza, tonight and every night');
    await post(owner, general, 'Nothing about food');

    expect(await found(owner, guild, { content: 'pizza' })).toEqual([pasta, pizza]);
    expect(await found(owner, guild, { content: 'piz tonig' })).toEqual([pasta, pizza]);
    expect(await found(owner, guild, { content: '"wants pizza"' })).toEqual([pizza]);
    expect(await found(owner, guild, { content: 'PIZZA', sort_order: 'asc' })).toEqual([pizza, pasta]);
    expect(await found(owner, guild, { content: 'pizza sushi' })).toEqual([]);

    await api.put(alice, `/guild-messages/${pizza}`, { content: 'Who wants sushi?' });
    expect(await found(owner, guild, { content: 'sushi' })).toEqual([pizza]);
    expect(await found(owner, guild, { content: 'pizza' })).toEqual([pasta]);
    await api.delete(owner, `/guild-messages/${pasta}`);
    expect(await found(owner, guild, { content: 'pizza' })).toEqual([]);

    const res = await search(owner, guild, { content: 'sushi' });
    expect(res.body.total_results).toBe(1);
    expect(res.body.messages[0]).toMatchObject({ id: pizza, channel_id: general.id, sender_id: alice.id, content: 'Who wants sushi?', reactions: [] });
  });

  it('filters by author, channel, has and mentions', async () => {
    const { owner, members: [alice, bob], guild, general, random } = await setUpGuild();
    const a1 = await post(alice, general, `hey <@${bob.id}> look https://example.com`);
    const a2 = await post(alice, random, `photo ${upload('beach.jpg', 'image/jpeg')}`);
    const b1 = await post(bob, general, `thanks <@${alice.id}> and <@${bob.id}>`);
    const o1 = await post(owner, random, 'poll:v1:{"q":"Beach day?","multi":false,"o":[{"id":"aaaaaaaa","t":"Yes"}]}');

    expect(await found(owner, guild, { author_id: alice.id })).toEqual([a2, a1]);
    expect(await found(owner, guild, { author_id: [alice.id, owner.id] })).toEqual([o1, a2, a1]);
    expect(await found(owner, guild, { channel_id: random.id })).toEqual([o1, a2]);
    expect(await found(owner, guild, { channel_id: random.id, author_id: alice.id })).toEqual([a2]);
    expect(await found(owner, guild, { has: 'link' })).toEqual([a1]);
    expect(await found(owner, guild, { has: ['image', 'file'] })).toEqual([a2]);
    expect(await found(owner, guild, { has: 'poll' })).toEqual([o1]);
    expect(await found(owner, guild, { has: 'video' })).toEqual([]);
    expect(await found(owner, guild, { mentions: bob.id })).toEqual([b1, a1]);
    expect(await found(owner, guild, { mentions: [bob.id, alice.id] })).toEqual([b1]);
    expect(await found(owner, guild, { content: 'beach' })).toEqual([o1, a2]);
    // Mention ids and attachment links aren't words.
    expect(await found(owner, guild, { content: String(bob.id) })).toEqual([]);
    expect(await found(owner, guild, { content: 'secretkey' })).toEqual([]);
  });

  it('finds what forwards say, and has:forward', async () => {
    const { owner, members: [alice, bob], guild, general } = await setUpGuild();
    const f1 = await post(alice, general, `fwd:v1:{"t":1700000000}\nsurfing <@${bob.id}> ${upload('wave.jpg', 'image/jpeg')}`);
    const a1 = await post(alice, general, 'surfing again');
    expect(await found(owner, guild, { has: 'forward' })).toEqual([f1]);
    expect(await found(owner, guild, { has: 'image' })).toEqual([f1]);
    expect(await found(owner, guild, { content: 'surfing' })).toEqual([a1, f1]);
    // `mentions:` reads the text, so a forward naming someone is found (it never pinged them).
    expect(await found(owner, guild, { mentions: bob.id })).toEqual([f1]);
  });

  it('looks for emoji and punctuation as typed', async () => {
    const { owner, guild, general } = await setUpGuild();
    const party = await post(owner, general, 'we did it 🎉');
    await post(owner, general, 'we did it');
    expect(await found(owner, guild, { content: '🎉' })).toEqual([party]);
    expect(await found(owner, guild, { content: 'did 🎉' })).toEqual([party]);
    expect(await found(owner, guild, { content: '100%' })).toEqual([]);
  });

  it('pages 25 at a time with the total', async () => {
    const { owner, guild, general } = await setUpGuild();
    const ids = [];
    for (let i = 0; i < 30; i++) ids.push(await post(owner, general, `page test ${i}`));
    const first = await search(owner, guild, { content: 'page' });
    expect(first.body.total_results).toBe(30);
    expect(first.body.messages.map((m) => m.id)).toEqual(ids.slice(5).reverse());
    const second = await search(owner, guild, { content: 'page', offset: 25 });
    expect(second.body.messages.map((m) => m.id)).toEqual(ids.slice(0, 5).reverse());
  });

  it("only searches channels the caller can see, and guilds they're in", async () => {
    const { owner, members: [alice], guild, random, everyone } = await setUpGuild();
    const secret = await post(owner, random, 'the secret plan');
    expect(await found(alice, guild, { content: 'secret' })).toEqual([secret]);
    await api.put(owner, `/guilds/${guild.id}/channels/${random.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.VIEW_CHANNEL });
    expect(await found(alice, guild, { content: 'secret' })).toEqual([]);
    expect(await found(alice, guild, { channel_id: random.id })).toEqual([]);
    expect(await found(owner, guild, { content: 'secret' })).toEqual([secret]);

    const outsider = await makeUser();
    expect((await search(outsider, guild, { content: 'secret' })).status).toBe(404);
    expect((await request(app).get(`/api/guilds/${guild.id}/messages/search?content=secret`)).status).toBe(401);
  });

  it('refuses bad searches', async () => {
    const { owner, guild } = await setUpGuild();
    expect((await search(owner, guild, {})).status).toBe(400);
    expect((await search(owner, guild, { has: 'sticker' })).status).toBe(400);
    expect((await search(owner, guild, { author_id: 'bob' })).status).toBe(400);
    expect((await search(owner, guild, { content: 'x', offset: -1 })).status).toBe(400);
    expect((await search(owner, guild, { content: 'x', sort_order: 'sideways' })).status).toBe(400);
    expect((await search(owner, guild, { content: 'x'.repeat(513) })).status).toBe(400);
    // FTS syntax is just text.
    expect((await search(owner, guild, { content: 'a" OR b* NEAR(' })).status).toBe(200);
  });

  it("indexes a webhook's embeds and files", async () => {
    const { owner, guild, general } = await setUpGuild();
    const hook = (await api.post(owner, `/channels/${general.id}/webhooks`, { name: 'CI' })).body;
    const sent = await request(app).post(`/api/webhooks/${hook.id}/${hook.token}?wait=true`)
      .send({ embeds: [{ title: 'Deploy finished', description: 'all green' }] });
    expect(sent.status).toBe(200);
    expect(await found(owner, guild, { content: 'deploy green' })).toEqual([Number(sent.body.id)]);
    expect(await found(owner, guild, { has: 'embed' })).toEqual([Number(sent.body.id)]);
    await request(app).patch(`/api/webhooks/${hook.id}/${hook.token}/messages/${sent.body.id}`)
      .send({ embeds: [{ title: 'Deploy failed' }] });
    expect(await found(owner, guild, { content: 'green' })).toEqual([]);
    expect(await found(owner, guild, { content: 'failed' })).toEqual([Number(sent.body.id)]);
  });
});
