import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';
import { signedUploads } from './helpers/mockS3.js';

const app = require('../index.js');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser(prefix = 'guild-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-guild-123';
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

// Collects the websocket events sent to `user`.
function listen(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)) };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  // Not enumerable, so toEqual only compares the events.
  Object.defineProperty(events, 'stop', {
    value: () => clients.set(String(user.id), clients.get(String(user.id)).filter((s) => s !== ws)),
  });
  return events;
}

async function createGuild(owner, name = 'Test Guild') {
  const res = await api.post(owner, '/guilds', { name });
  expect(res.status).toBe(201);
  return res.body;
}

async function join(user, guild, inviter) {
  const invite = await api.post(inviter, `/guilds/${guild.id}/invites`);
  const res = await api.post(user, `/invites/${invite.body.code}`);
  expect(res.status).toBe(201);
  return res.body;
}

// A guild owned by `owner` with `member` in it, and its #general channel.
async function guildWithMember() {
  const owner = await makeUser('owner');
  const member = await makeUser('member');
  const guild = await createGuild(owner);
  await join(member, guild, owner);
  return { owner, member, guild, general: guild.channels[0] };
}

describe('guilds', () => {
  it('creates a guild with a Text Channels category and #general', async () => {
    const owner = await makeUser();
    const events = listen(owner);
    const guild = await createGuild(owner, '  My Guild  ');
    events.stop();

    expect(guild).toMatchObject({ name: 'My Guild', owner: owner.id, icon_version: 0 });
    expect(guild.categories).toEqual([{ id: expect.any(Number), name: 'Text Channels', position: 0 }]);
    expect(guild.channels).toEqual([
      expect.objectContaining({ name: 'general', type: 'text', category_id: guild.categories[0].id }),
    ]);
    expect(events).toEqual([{ type: 'guild_add', guild }]);

    const list = await api.get(owner, '/guilds');
    expect(list.body.map((g) => g.id)).toEqual([guild.id]);
  });

  it('rejects bad names and requires auth', async () => {
    const owner = await makeUser();
    expect((await api.post(owner, '/guilds', { name: '   ' })).status).toBe(400);
    expect((await api.post(owner, '/guilds', { name: 'x'.repeat(101) })).status).toBe(400);
    expect((await request(app).post('/api/guilds').send({ name: 'x' })).status).toBe(401);
  });

  it('hides guilds from non-members', async () => {
    const { guild, general } = await guildWithMember();
    const outsider = await makeUser();
    expect((await api.get(outsider, `/guilds/${guild.id}`)).status).toBe(404);
    expect((await api.get(outsider, `/guilds/${guild.id}/members`)).status).toBe(404);
    expect((await api.get(outsider, `/channels/${general.id}/messages`)).status).toBe(404);
    expect((await api.post(outsider, `/channels/${general.id}/messages`, { content: 'hi' })).status).toBe(404);
  });

  it('lets only the owner rename it, and tells every member', async () => {
    const { owner, member, guild } = await guildWithMember();
    expect((await api.patch(member, `/guilds/${guild.id}`, { name: 'Mine now' })).status).toBe(403);

    const events = listen(member);
    const res = await api.patch(owner, `/guilds/${guild.id}`, { name: 'Renamed' });
    events.stop();
    expect(res.body.name).toBe('Renamed');
    // Each member gets the guild as they see it (their own permissions).
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'guild_update', guild: { id: guild.id, name: 'Renamed' } });
    expect(events[0].guild.my_permissions).not.toBe(res.body.my_permissions);
  });

  it('bumps the icon version after an upload, and removes it', async () => {
    const { owner, member, guild } = await guildWithMember();
    const forbidden = await api.get(member, `/upload_guild_icon?guildId=${guild.id}&type=image/png&size=100`);
    expect(forbidden.status).toBe(403);

    const upload = await api.get(owner, `/upload_guild_icon?guildId=${guild.id}&type=image/png&size=100`);
    expect(upload.status).toBe(201);
    expect(signedUploads.at(-1)).toEqual({ filename: String(guild.id), bucket: 'guild-icons', contentType: 'image/png', contentLength: 100 });
    expect((await api.get(owner, `/upload_guild_icon?guildId=${guild.id}&type=text/html&size=100`)).status).toBe(400);

    expect((await api.patch(owner, `/guilds/${guild.id}`, { iconUploaded: true })).body.icon_version).toBe(1);
    expect((await api.patch(owner, `/guilds/${guild.id}`, { iconUploaded: true })).body.icon_version).toBe(2);
    expect((await api.patch(owner, `/guilds/${guild.id}`, { icon: null })).body.icon_version).toBe(0);
  });

  it('deletes a guild and everything in it', async () => {
    const { owner, member, guild, general } = await guildWithMember();
    await api.post(member, `/channels/${general.id}/messages`, { content: 'hello' });
    expect((await api.delete(member, `/guilds/${guild.id}`)).status).toBe(403);

    const events = listen(member);
    expect((await api.delete(owner, `/guilds/${guild.id}`)).status).toBe(200);
    events.stop();
    expect(events).toEqual([{ type: 'guild_remove', guildId: guild.id }]);
    expect((await api.get(owner, `/guilds/${guild.id}`)).status).toBe(404);
    expect((await api.get(member, '/guilds')).body).toEqual([]);
  });

  it('transfers ownership to a member', async () => {
    const { owner, member, guild } = await guildWithMember();
    const outsider = await makeUser();
    expect((await api.post(owner, `/guilds/${guild.id}/transfer`, { userId: outsider.id })).status).toBe(400);
    expect((await api.post(owner, `/guilds/${guild.id}/transfer`, { userId: member.id })).status).toBe(200);
    expect((await api.get(owner, `/guilds/${guild.id}`)).body.owner).toBe(member.id);
    // The old owner can now leave.
    expect((await api.delete(owner, `/guilds/${guild.id}/members/me`)).status).toBe(200);
  });
});

describe('guild members, invites and bans', () => {
  it('joins through an invite, and tells the members', async () => {
    const owner = await makeUser();
    const guild = await createGuild(owner);
    const joiner = await makeUser();

    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    expect(invite.status).toBe(201);
    expect(invite.body.code).toMatch(/^[A-Za-z0-9]{8}$/);

    const preview = await api.get(joiner, `/invites/${invite.body.code}`);
    expect(preview.body).toMatchObject({ guild_id: guild.id, name: guild.name, member_count: 1, is_member: false, creator_username: owner.username });

    const ownerEvents = listen(owner);
    const joinerEvents = listen(joiner);
    const res = await api.post(joiner, `/invites/${invite.body.code}`);
    ownerEvents.stop();
    joinerEvents.stop();
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(guild.id);
    expect(joinerEvents.map((e) => e.type)).toEqual(['guild_add', 'guild_member_add']);
    expect(ownerEvents).toEqual([{
      type: 'guild_member_add',
      guildId: guild.id,
      member: { id: joiner.id, username: joiner.username, display_name: null, custom_status: null, bio: null, avatar: null, last_online: expect.any(Number), bot: 0, joined_at: expect.any(Number), role_ids: [], status: expect.any(String) },
    }]);

    const members = await api.get(owner, `/guilds/${guild.id}/members`);
    expect(members.body.map((m) => m.id).sort()).toEqual([owner.id, joiner.id].sort());

    // Joining again is harmless and uses nothing.
    expect((await api.post(joiner, `/invites/${invite.body.code}`)).status).toBe(200);
    const invites = await api.get(owner, `/guilds/${guild.id}/invites`);
    expect(invites.body[0].uses).toBe(1);
  });

  it('honours max uses and expiry', async () => {
    const owner = await makeUser();
    const guild = await createGuild(owner);
    const once = await api.post(owner, `/guilds/${guild.id}/invites`, { maxUses: 1 });
    await api.post(await makeUser(), `/invites/${once.body.code}`);
    const late = await makeUser();
    expect((await api.post(late, `/invites/${once.body.code}`)).status).toBe(404);
    expect((await api.get(late, `/invites/${once.body.code}`)).status).toBe(404);

    const timed = await api.post(owner, `/guilds/${guild.id}/invites`, { maxAge: 60 });
    expect(timed.body.expires_at).toBeGreaterThan(Date.now() / 1000);
    expect((await api.post(owner, `/guilds/${guild.id}/invites`, { maxAge: -1 })).status).toBe(400);
    expect((await api.post(owner, `/guilds/${guild.id}/invites`, { maxUses: 1.5 })).status).toBe(400);
    expect((await api.get(late, '/invites/nonsense')).status).toBe(404);
  });

  it('lets the creator or the owner revoke an invite', async () => {
    const { owner, member, guild } = await guildWithMember();
    const other = await makeUser();
    await join(other, guild, owner);
    const invite = await api.post(member, `/guilds/${guild.id}/invites`);
    expect((await api.delete(other, `/invites/${invite.body.code}`)).status).toBe(403);
    expect((await api.delete(owner, `/invites/${invite.body.code}`)).status).toBe(200);
    expect((await api.post(await makeUser(), `/invites/${invite.body.code}`)).status).toBe(404);
  });

  it('lets members leave, but not the owner', async () => {
    const { owner, member, guild } = await guildWithMember();
    expect((await api.delete(owner, `/guilds/${guild.id}/members/me`)).status).toBe(400);

    const ownerEvents = listen(owner);
    expect((await api.delete(member, `/guilds/${guild.id}/members/me`)).status).toBe(200);
    ownerEvents.stop();
    expect(ownerEvents).toEqual([{ type: 'guild_member_remove', guildId: guild.id, userId: member.id }]);
    expect((await api.get(member, `/guilds/${guild.id}`)).status).toBe(404);
  });

  it('lets the owner kick; kicked members can rejoin', async () => {
    const { owner, member, guild } = await guildWithMember();
    expect((await api.delete(member, `/guilds/${guild.id}/members/${owner.id}`)).status).toBe(403);

    const events = listen(member);
    expect((await api.delete(owner, `/guilds/${guild.id}/members/${member.id}`)).status).toBe(200);
    events.stop();
    expect(events).toEqual([{ type: 'guild_remove', guildId: guild.id }]);
    await join(member, guild, owner);
  });

  it('bans keep people out until unbanned', async () => {
    const { owner, member, guild } = await guildWithMember();
    expect((await api.put(member, `/guilds/${guild.id}/bans/${owner.id}`)).status).toBe(403);
    expect((await api.put(owner, `/guilds/${guild.id}/bans/${member.id}`)).status).toBe(200);
    expect((await api.get(member, `/guilds/${guild.id}`)).status).toBe(404);

    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    expect((await api.post(member, `/invites/${invite.body.code}`)).status).toBe(403);
    expect((await api.get(owner, `/guilds/${guild.id}/bans`)).body.map((b) => b.id)).toEqual([member.id]);

    expect((await api.delete(owner, `/guilds/${guild.id}/bans/${member.id}`)).status).toBe(200);
    expect((await api.post(member, `/invites/${invite.body.code}`)).status).toBe(201);
  });
});

describe('vanity invites', () => {
  it('lets only the owner set one, which never runs out and counts its uses', async () => {
    const { owner, member, guild } = await guildWithMember();
    expect((await api.get(member, `/guilds/${guild.id}/vanity-url`)).body).toEqual({ code: null, uses: 0 });
    expect((await api.put(member, `/guilds/${guild.id}/vanity-url`, { code: 'mine' })).status).toBe(403);

    const set = await api.put(owner, `/guilds/${guild.id}/vanity-url`, { code: ' Cool-Guild ' });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ code: 'cool-guild', uses: 0 });

    // Any case, any number of people; banned people still can't.
    const outsider = await makeUser();
    const preview = await api.get(outsider, '/invites/COOL-guild');
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ code: 'cool-guild', guild_id: guild.id, creator_username: null, member_count: 2, is_member: false });
    for (let i = 0; i < 3; i++) expect((await api.post(await makeUser(), '/invites/cool-guild')).status).toBe(201);
    expect((await api.post(member, '/invites/cool-guild')).status).toBe(200);
    expect((await api.get(member, `/guilds/${guild.id}/vanity-url`)).body).toEqual({ code: 'cool-guild', uses: 3 });
    expect((await api.put(owner, `/guilds/${guild.id}/bans/${outsider.id}`)).status).toBe(200);
    expect((await api.post(outsider, '/invites/cool-guild')).status).toBe(403);

    // It isn't an ordinary invite: not listed, not revocable that way.
    expect((await api.get(owner, `/guilds/${guild.id}/invites`)).body.map((i) => i.code)).not.toContain('cool-guild');
    expect((await api.delete(owner, '/invites/cool-guild')).status).toBe(404);

    // Removing it frees the code for another guild.
    expect((await api.put(owner, `/guilds/${guild.id}/vanity-url`, { code: null })).body).toEqual({ code: null, uses: 0 });
    expect((await api.get(outsider, '/invites/cool-guild')).status).toBe(404);
    const otherOwner = await makeUser();
    const other = await createGuild(otherOwner, 'Other');
    expect((await api.put(otherOwner, `/guilds/${other.id}/vanity-url`, { code: 'cool-guild' })).status).toBe(200);

    const log = await api.get(owner, `/guilds/${guild.id}/audit-log`);
    expect(log.body.entries.filter((e) => e.action === 'vanity_update').map((e) => e.details)).toEqual([
      { before: 'cool-guild', after: null },
      { before: null, after: 'cool-guild' },
    ]);
  });

  it('refuses bad and taken codes', async () => {
    const owner = await makeUser();
    const guild = await createGuild(owner);
    for (const code of ['ab', '-abc', 'abc-', 'has space', 'a'.repeat(33), 'émoji', 42]) {
      expect((await api.put(owner, `/guilds/${guild.id}/vanity-url`, { code })).status).toBe(400);
    }
    const taker = await makeUser();
    const taken = await createGuild(taker);
    expect((await api.put(taker, `/guilds/${taken.id}/vanity-url`, { code: 'taken' })).status).toBe(200);
    expect((await api.put(owner, `/guilds/${guild.id}/vanity-url`, { code: 'TAKEN' })).status).toBe(409);

    // An ordinary invite's code, in any case, is taken too.
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    expect((await api.put(owner, `/guilds/${guild.id}/vanity-url`, { code: invite.body.code.toLowerCase() })).status).toBe(409);
  });
});

describe('guild channels and categories', () => {
  it('creates channels (Discord-style names) and categories, owner only', async () => {
    const { owner, member, guild } = await guildWithMember();
    expect((await api.post(member, `/guilds/${guild.id}/channels`, { name: 'nope' })).status).toBe(403);

    const category = await api.post(owner, `/guilds/${guild.id}/categories`, { name: 'Voice' });
    expect(category.status).toBe(201);
    const channel = await api.post(owner, `/guilds/${guild.id}/channels`, { name: '  Off Topic  Chat ', topic: 'anything', categoryId: category.body.id });
    expect(channel.status).toBe(201);
    expect(channel.body).toMatchObject({ name: 'off-topic-chat', topic: 'anything', category_id: category.body.id, type: 'text' });
    const voice = await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'Lounge', type: 'voice' });
    expect(voice.body).toMatchObject({ type: 'voice', category_id: null });

    expect((await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'x', type: 'forum' })).status).toBe(400);
    expect((await api.post(owner, `/guilds/${guild.id}/channels`, { name: '' })).status).toBe(400);

    // Another guild's category can't be used.
    const otherGuild = await createGuild(owner, 'Other');
    expect((await api.post(owner, `/guilds/${otherGuild.id}/channels`, { name: 'x', categoryId: category.body.id })).status).toBe(400);

    const layout = await api.get(member, `/guilds/${guild.id}`);
    expect(layout.body.channels.map((c) => c.name)).toEqual(['general', 'off-topic-chat', 'lounge']);
    expect((await api.get(member, `/channels/${voice.body.id}/messages`)).status).toBe(200);
  });

  it('edits and deletes channels and categories', async () => {
    const { owner, member, guild, general } = await guildWithMember();
    const edited = await api.patch(owner, `/guilds/${guild.id}/channels/${general.id}`, { name: 'Main', topic: 'Say hi' });
    expect(edited.body).toMatchObject({ name: 'main', topic: 'Say hi' });
    expect((await api.patch(member, `/guilds/${guild.id}/channels/${general.id}`, { name: 'x' })).status).toBe(403);

    // Deleting a category leaves its channels, uncategorised.
    const categoryId = guild.categories[0].id;
    expect((await api.patch(owner, `/guilds/${guild.id}/categories/${categoryId}`, { name: 'Chat' })).status).toBe(200);
    expect((await api.delete(owner, `/guilds/${guild.id}/categories/${categoryId}`)).status).toBe(200);
    let layout = (await api.get(owner, `/guilds/${guild.id}`)).body;
    expect(layout.categories).toEqual([]);
    expect(layout.channels[0]).toMatchObject({ id: general.id, category_id: null });

    await api.post(member, `/channels/${general.id}/messages`, { content: 'bye' });
    expect((await api.delete(owner, `/guilds/${guild.id}/channels/${general.id}`)).status).toBe(200);
    layout = (await api.get(owner, `/guilds/${guild.id}`)).body;
    expect(layout.channels).toEqual([]);
    expect((await api.get(member, `/channels/${general.id}/messages`)).status).toBe(404);
  });

  it('flags channels as NSFW, kept by clones and in the audit log', async () => {
    const { owner, member, guild, general } = await guildWithMember();
    expect(general.nsfw).toBe(false);
    const created = await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'art', nsfw: true });
    expect(created.body).toMatchObject({ name: 'art', nsfw: true });
    expect((await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'x', nsfw: 'yes' })).status).toBe(400);

    const edited = await api.patch(owner, `/guilds/${guild.id}/channels/${general.id}`, { nsfw: true });
    expect(edited.body).toMatchObject({ id: general.id, nsfw: true });
    expect((await api.patch(owner, `/guilds/${guild.id}/channels/${general.id}`, { nsfw: 1 })).status).toBe(400);
    expect((await api.patch(member, `/guilds/${guild.id}/channels/${general.id}`, { nsfw: false })).status).toBe(403);

    const clone = await api.post(owner, `/guilds/${guild.id}/channels/${created.body.id}/clone`, {});
    expect(clone.body).toMatchObject({ name: 'art', nsfw: true });

    const layout = (await api.get(member, `/guilds/${guild.id}`)).body;
    expect(layout.channels.map((c) => [c.name, c.nsfw])).toEqual([['general', true], ['art', true], ['art', true]]);

    const log = (await api.get(owner, `/guilds/${guild.id}/audit-log`)).body;
    const update = log.entries.find((e) => e.action === 'channel_update');
    expect(update.details.changes).toEqual({ nsfw: [false, true] });
  });

  it('reorders everything at once', async () => {
    const { owner, guild, general } = await guildWithMember();
    const [textCategory] = guild.categories;
    const other = (await api.post(owner, `/guilds/${guild.id}/categories`, { name: 'Other' })).body;
    const memes = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'memes', categoryId: textCategory.id })).body;

    const res = await api.put(owner, `/guilds/${guild.id}/layout`, {
      categories: [other.id, textCategory.id],
      channels: [{ id: memes.id, categoryId: other.id }, { id: general.id, categoryId: textCategory.id }],
    });
    expect(res.status).toBe(200);
    expect(res.body.categories.map((c) => c.id)).toEqual([other.id, textCategory.id]);
    expect(res.body.channels.map((c) => [c.id, c.category_id])).toEqual([[memes.id, other.id], [general.id, textCategory.id]]);

    // Every id exactly once.
    const missing = await api.put(owner, `/guilds/${guild.id}/layout`, {
      categories: [other.id, textCategory.id],
      channels: [{ id: memes.id, categoryId: null }],
    });
    expect(missing.status).toBe(400);
  });
});

describe('guild messages', () => {
  it('sends, pages and delivers messages to every member', async () => {
    const { owner, member, guild, general } = await guildWithMember();
    const events = listen(owner);
    const sent = await api.post(member, `/channels/${general.id}/messages`, { content: '  hello  ' });
    events.stop();
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({
      channel_id: general.id, sender_id: member.id, sender_username: member.username,
      content: 'hello', edited: 0, reactions: [],
    });
    expect(events).toEqual([{ type: 'guild_message_new', guildId: guild.id, message: sent.body }]);

    for (let i = 0; i < 4; i++) await api.post(owner, `/channels/${general.id}/messages`, { content: `m${i}` });
    const newest = await api.get(member, `/channels/${general.id}/messages?limit=2`);
    expect(newest.body.map((m) => m.content)).toEqual(['m2', 'm3']);
    const older = await api.get(member, `/channels/${general.id}/messages?limit=10&before=${newest.body[0].id}`);
    expect(older.body.map((m) => m.content)).toEqual(['hello', 'm0', 'm1']);
  });

  it('checks content and replies', async () => {
    const { owner, member, guild, general } = await guildWithMember();
    expect((await api.post(member, `/channels/${general.id}/messages`, { content: '   ' })).status).toBe(400);
    expect((await api.post(member, `/channels/${general.id}/messages`, { content: 'x'.repeat(5001) })).status).toBe(400);
    expect((await api.post(member, `/channels/${general.id}/messages`, { content: 'x'.repeat(5000) })).status).toBe(201);

    const parent = await api.post(owner, `/channels/${general.id}/messages`, { content: 'question?' });
    const reply = await api.post(member, `/channels/${general.id}/messages`, { content: 'answer', replyTo: parent.body.id });
    expect(reply.body).toMatchObject({ parent_message_id: parent.body.id, parent_content: 'question?', parent_sender_id: owner.id, parent_username: owner.username });

    // Not to a message in another channel.
    const other = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'other' })).body;
    expect((await api.post(member, `/channels/${other.id}/messages`, { content: 'x', replyTo: parent.body.id })).status).toBe(400);
  });

  it('lets authors edit, and authors or the owner delete', async () => {
    const { owner, member, general } = await guildWithMember();
    const msg = (await api.post(member, `/channels/${general.id}/messages`, { content: 'typo' })).body;

    expect((await api.put(owner, `/guild-messages/${msg.id}`, { content: 'hacked' })).status).toBe(403);
    const events = listen(owner);
    expect((await api.put(member, `/guild-messages/${msg.id}`, { content: 'fixed' })).status).toBe(200);
    events.stop();
    expect(events[0]).toMatchObject({ type: 'guild_message_edit', messageId: msg.id, channelId: general.id, content: 'fixed' });
    const [stored] = (await api.get(owner, `/channels/${general.id}/messages`)).body;
    expect(stored).toMatchObject({ content: 'fixed', edited: 1 });

    const third = await makeUser();
    expect((await api.delete(third, `/guild-messages/${msg.id}`)).status).toBe(404);
    const ownMsg = (await api.post(owner, `/channels/${general.id}/messages`, { content: 'mine' })).body;
    expect((await api.delete(member, `/guild-messages/${ownMsg.id}`)).status).toBe(403);
    expect((await api.delete(owner, `/guild-messages/${msg.id}`)).status).toBe(200);
    expect((await api.delete(owner, `/guild-messages/${ownMsg.id}`)).status).toBe(200);
    expect((await api.get(owner, `/channels/${general.id}/messages`)).body).toEqual([]);
  });

  it('adds and removes reactions', async () => {
    const { owner, member, general } = await guildWithMember();
    const msg = (await api.post(owner, `/channels/${general.id}/messages`, { content: 'react to me' })).body;

    const events = listen(owner);
    const reaction = await api.post(member, `/guild-messages/${msg.id}/reactions`, { emoji: '👍' });
    events.stop();
    expect(reaction.status).toBe(201);
    expect(reaction.body).toMatchObject({ message_id: msg.id, user_id: member.id, emoji: '👍' });
    expect(events[0]).toMatchObject({ type: 'guild_reaction_add', channelId: general.id, reaction: reaction.body });

    expect((await api.post(member, `/guild-messages/${msg.id}/reactions`, { emoji: '👍' })).status).toBe(409);
    expect((await api.post(member, `/guild-messages/${msg.id}/reactions`, { emoji: '' })).status).toBe(400);
    expect((await api.post(member, `/guild-messages/${msg.id}/reactions`, { emoji: 'a b' })).status).toBe(400);

    const [withReaction] = (await api.get(owner, `/channels/${general.id}/messages`)).body;
    expect(withReaction.reactions).toEqual([{ id: reaction.body.id, user_id: member.id, emoji: '👍', timestamp: expect.any(Number) }]);

    expect((await api.delete(owner, `/guild-reactions/${reaction.body.id}`)).status).toBe(403);
    expect((await api.delete(member, `/guild-reactions/${reaction.body.id}`)).status).toBe(200);
  });

  it('counts unread messages per channel', async () => {
    const { owner, member, guild, general } = await guildWithMember();
    // History from before joining isn't unread.
    await api.post(owner, `/channels/${general.id}/messages`, { content: 'before' });
    const late = await makeUser();
    await join(late, guild, owner);
    expect((await api.get(late, '/guild-unread')).body).toEqual([]);

    await api.post(owner, `/channels/${general.id}/messages`, { content: 'one' });
    const two = (await api.post(owner, `/channels/${general.id}/messages`, { content: 'two' })).body;
    expect((await api.get(late, '/guild-unread')).body).toEqual([{ channel_id: general.id, guild_id: guild.id, count: 2, mentions: 0 }]);
    // Your own messages don't count, and sending marks the channel read.
    expect((await api.get(owner, '/guild-unread')).body).toEqual([]);
    await api.post(member, `/channels/${general.id}/messages`, { content: 'mine' });
    expect((await api.get(member, '/guild-unread')).body).toEqual([]);

    expect((await api.post(late, `/channels/${general.id}/read`, { messageId: two.id })).status).toBe(200);
    expect((await api.get(late, '/guild-unread')).body).toEqual([{ channel_id: general.id, guild_id: guild.id, count: 1, mentions: 0 }]);
    // The marker never moves backwards.
    await api.post(late, `/channels/${general.id}/read`, { messageId: 1 });
    expect((await api.get(late, '/guild-unread')).body[0].count).toBe(1);
  });
});
