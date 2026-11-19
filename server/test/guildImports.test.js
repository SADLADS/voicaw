import { objects } from './helpers/mockS3.js';
import './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const sharp = require('sharp');
const app = require('../index.js');
const db = require('../db');
const { setSetting } = require('../appSettings');
const { PERMISSIONS: P, DEFAULT_EVERYONE_PERMISSIONS } = require('../permissions.js');
const { s3Endpoint } = require('../config');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser(prefix = 'imp-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-imports-123';
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

function connect(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)), presence: { at: Date.now() } };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return events;
}

// A guild (owner + a member called "sam") with its #general.
async function setUp() {
  const owner = await makeUser('i-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'New home' })).body;
  const member = await makeUser('sam');
  const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
  await api.post(member, `/invites/${invite.body.code}`);
  return { owner, member, guild, general: guild.channels[0], everyone: guild.roles.find((r) => r.is_everyone) };
}

const ARCHIVE = {
  source: 'discord-chat-exporter',
  sourceGuildName: 'Old Crew',
  authors: [
    { sourceId: '111', name: 'Sam', names: ['sammy_old'] },
    { sourceId: '222', name: 'kestrel99' },
    { sourceId: '333', name: 'Botto', isBot: true },
  ],
  channels: [{ sourceId: '900', name: 'general' }, { sourceId: '901', name: 'memes' }],
};

const ms = (iso) => new Date(iso).getTime();

async function startImport(owner, guild, general, extra = {}) {
  const created = await api.post(owner, `/guilds/${guild.id}/imports`, { ...ARCHIVE, ...extra });
  expect(created.status).toBe(201);
  const mapped = await api.put(owner, `/guilds/${guild.id}/imports/${created.body.id}/mapping`, {
    channels: [{ sourceId: '900', channelId: general.id }],
  });
  expect(mapped.status).toBe(200);
  return created.body;
}

const authorOf = (imp, sourceId) => imp.authors.find((a) => a.source_id === sourceId);
const messagesIn = async (user, channel, query = '') => (await api.get(user, `/channels/${channel.id}/messages${query}`)).body;

describe('who may import', () => {
  it('needs Administrator (or the owner) and the app-wide switch', async () => {
    const { owner, member, guild, everyone } = await setUp();
    expect((await api.post(member, `/guilds/${guild.id}/imports`, ARCHIVE)).status).toBe(403);
    expect((await api.get(member, `/guilds/${guild.id}/imports`)).status).toBe(403);
    await api.patch(owner, `/guilds/${guild.id}/roles/${everyone.id}`, { permissions: DEFAULT_EVERYONE_PERMISSIONS | P.MANAGE_GUILD });
    expect((await api.post(member, `/guilds/${guild.id}/imports`, ARCHIVE)).status).toBe(403);
    await api.patch(owner, `/guilds/${guild.id}/roles/${everyone.id}`, { permissions: DEFAULT_EVERYONE_PERMISSIONS | P.ADMINISTRATOR });
    expect((await api.post(member, `/guilds/${guild.id}/imports`, ARCHIVE)).status).toBe(201);

    await setSetting('historyImports', 'off');
    try {
      const refused = await api.post(owner, `/guilds/${guild.id}/imports`, ARCHIVE);
      expect(refused.status).toBe(403);
      expect(refused.body.error).toMatch(/turned off/);
    } finally {
      await setSetting('historyImports', 'on');
    }
    const outsider = await makeUser();
    expect((await api.get(outsider, `/guilds/${guild.id}/imports`)).status).toBe(404);
  });

  it('suggests members by name, but never one who opted out', async () => {
    const { owner, member, guild } = await setUp();
    const imp = (await api.post(owner, `/guilds/${guild.id}/imports`, {
      ...ARCHIVE, authors: [{ sourceId: '111', name: 'Someone', names: [member.username] }],
    })).body;
    expect(imp.suggested).toEqual({ [authorOf(imp, '111').id]: member.id });

    await api.put(member, '/preferences', { importOptOut: true });
    const again = (await api.post(owner, `/guilds/${guild.id}/imports`, {
      ...ARCHIVE, authors: [{ sourceId: '111', name: 'Someone', names: [member.username] }],
    })).body;
    expect(again.suggested).toEqual({});
    expect(again.opted_out).toEqual([member.id]);
    const refused = await api.put(owner, `/guilds/${guild.id}/imports/${again.id}/mapping`, {
      authors: [{ id: authorOf(again, '111').id, userId: member.id }],
    });
    expect(refused.status).toBe(400);
  });
});

describe('adding messages', () => {
  it('merges them by time into a channel that already has messages, with no unread, pings or pushes', async () => {
    const { owner, member, guild, general } = await setUp();
    // A live message first (its id is lower than any imported one, but it's newer).
    await api.post(owner, `/channels/${general.id}/messages`, { content: 'hello from now' });
    const memberEvents = connect(member);
    const imp = await startImport(owner, guild, general);
    await api.put(owner, `/guilds/${guild.id}/imports/${imp.id}/mapping`, {
      label: 'Discord', authors: [{ id: authorOf(imp, '111').id, userId: member.id }],
    });
    const unreadBefore = (await api.get(member, '/guild-unread')).body;

    const sent = await api.post(owner, `/guilds/${guild.id}/imports/${imp.id}/messages`, {
      channelSourceId: '900',
      names: { users: { 999: 'ghost' } },
      messages: [
        { sourceId: 'm1', authorSourceId: '111', timestamp: ms('2024-03-12T21:14:00Z'), content: 'raids tonight? <@222> <@999> <@111>' },
        {
          sourceId: 'm2', authorSourceId: '222', timestamp: ms('2024-03-12T21:16:00Z'), content: 'count me in', replyToSourceId: 'm1',
          reactions: [{ emoji: '🔥', count: 2, userSourceIds: ['111', '222'] }],
        },
        { sourceId: 'm3', authorSourceId: '333', timestamp: ms('2024-03-12T21:17:00Z'), content: 'score is 8', interaction: { name: 'score', userSourceId: '111' } },
        { sourceId: 'm4', authorSourceId: '222', timestamp: ms('2024-03-12T21:18:00Z'), content: '' },
      ],
    });
    expect(sent.body).toEqual({ added: 3, skipped: 1 });

    const history = await messagesIn(member, general);
    expect(history.map((m) => m.content)).toEqual([
      `raids tonight? @kestrel99 @ghost <@${member.id}>`, 'count me in', 'score is 8', 'hello from now',
    ]);
    const [first, second, third] = history;
    expect(first).toMatchObject({
      sender_id: member.id,
      imported: { label: 'Discord', source_guild_name: 'Old Crew', source_channel_name: 'general', importer_id: owner.id, author: { name: 'Sam', mapped: true } },
    });
    expect(second).toMatchObject({
      sender_id: 0,
      sender_username: 'kestrel99',
      parent_message_id: first.id,
      parent_import_id: imp.id,
      imported: { author: { name: 'kestrel99', mapped: false } },
      import_reactions: [{ emoji: '🔥', count: 2, users: [{ user_id: member.id, name: 'Sam' }, { user_id: null, name: 'kestrel99' }] }],
    });
    expect(third.interaction).toMatchObject({ name: 'score', user_id: member.id, user_name: 'Sam' });

    // No unread, no mention rows, no live message events.
    expect((await api.get(member, '/guild-unread')).body).toEqual(unreadBefore);
    expect(await db.get('SELECT COUNT(*) AS n FROM guild_mentions WHERE user_id = ?', [member.id])).toEqual({ n: 0 });
    expect(memberEvents.filter((e) => e.type === 'guild_message_new')).toHaveLength(0);

    // A resumed import asks which are in already (to skip their files).
    const known = await api.post(owner, `/guilds/${guild.id}/imports/${imp.id}/known`, { sourceIds: ['m1', 'm4', 'nope'] });
    expect(known.body).toEqual({ known: ['m1'] });
    // Sending the batch again adds nothing.
    const again = await api.post(owner, `/guilds/${guild.id}/imports/${imp.id}/messages`, {
      channelSourceId: '900',
      messages: [{ sourceId: 'm1', authorSourceId: '111', timestamp: ms('2024-03-12T21:14:00Z'), content: 'raids tonight?' }],
    });
    expect(again.body).toEqual({ added: 0, skipped: 1 });

    await api.post(owner, `/guilds/${guild.id}/imports/${imp.id}/finish`);
    expect(memberEvents).toContainEqual({ type: 'guild_history_changed', guildId: guild.id, channelId: general.id });
    // Imported messages can't be edited, even by the member shown as their author.
    expect((await api.put(member, `/guild-messages/${first.id}`, { content: 'rewritten' })).status).toBe(403);
  });

  it('pages by time: before, after and around cross imported messages', async () => {
    const { owner, guild, general } = await setUp();
    const live = (await api.post(owner, `/channels/${general.id}/messages`, { content: 'live' })).body;
    const imp = await startImport(owner, guild, general);
    const messages = Array.from({ length: 6 }, (_, i) => ({
      sourceId: `p${i}`, authorSourceId: '222', timestamp: ms('2024-01-01T00:00:00Z') + i * 60_000, content: `old ${i}`,
    }));
    await api.post(owner, `/guilds/${guild.id}/imports/${imp.id}/messages`, { channelSourceId: '900', messages });

    const newest = await messagesIn(owner, general, '?limit=3');
    expect(newest.map((m) => m.content)).toEqual(['old 4', 'old 5', 'live']);
    const older = await messagesIn(owner, general, `?limit=3&before=${newest[0].id}`);
    expect(older.map((m) => m.content)).toEqual(['old 1', 'old 2', 'old 3']);
    const newer = await messagesIn(owner, general, `?limit=10&after=${older[2].id}`);
    expect(newer.map((m) => m.content)).toEqual(['old 4', 'old 5', 'live']);
    const around = await messagesIn(owner, general, `?limit=4&around=${older[1].id}`);
    expect(around.map((m) => m.content)).toEqual(['old 1', 'old 2', 'old 3', 'old 4']);
    expect((await api.get(owner, `/channels/${general.id}/messages?around=999999`)).status).toBe(404);

    // Live messages sent later still land at the end, and bots read in time order too.
    await api.post(owner, `/channels/${general.id}/messages`, { content: 'later' });
    expect((await messagesIn(owner, general, '?limit=2')).map((m) => m.content)).toEqual(['live', 'later']);
    expect(live.id).toBeLessThan(newest[0].id);
  });

  it('keeps files the import uploaded, and shows the rest as not included', async () => {
    const { owner, guild, general } = await setUp();
    const imp = await startImport(owner, guild, general);
    const prepared = await api.post(owner, `/guilds/${guild.id}/imports/${imp.id}/files`, { name: 'cat pic.png', size: 1234, width: 40, height: 20 });
    expect(prepared.status).toBe(201);
    expect(prepared.body.uploadUrl).toContain(`uploads/imports/${imp.id}/`);
    expect(prepared.body.attachment).toMatchObject({ filename: 'cat_pic.png', size: 1234, content_type: 'image/png', width: 40, height: 20 });
    expect(prepared.body.attachment.url.startsWith(`${s3Endpoint}/uploads/imports/${imp.id}/`)).toBe(true);
    expect((await api.post(owner, `/guilds/${guild.id}/imports/${imp.id}/files`, { name: 'huge.mp4', size: 200 * 1024 * 1024 })).status).toBe(413);

    await api.post(owner, `/guilds/${guild.id}/imports/${imp.id}/messages`, {
      channelSourceId: '900',
      messages: [{
        sourceId: 'f1', authorSourceId: '222', timestamp: ms('2024-02-02T10:00:00Z'), content: '',
        attachments: [
          prepared.body.attachment,
          { filename: 'gone.gif', size: 324843, url: 'https://cdn.example.com/attachments/1/2/gone.gif' },
        ],
      }],
    });
    const [message] = await messagesIn(owner, general);
    expect(message.attachments).toEqual([
      expect.objectContaining({ filename: 'cat_pic.png', url: prepared.body.attachment.url }),
      expect.objectContaining({ filename: 'gone.gif', size: 324843, missing: true }),
    ]);
    expect(message.attachments[1].url).toBeUndefined();
    const linked = await db.get('SELECT linked FROM uploads WHERE key = ?', [prepared.body.attachment.url.split('/uploads/')[1]]);
    expect(linked).toEqual({ linked: 1 });
  });

  it("stores an author's picture from the archive", async () => {
    const { owner, guild, general } = await setUp();
    const imp = await startImport(owner, guild, general);
    const picture = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#3080ff' } }).png().toBuffer();
    const res = await request(app)
      .put(`/api/guilds/${guild.id}/imports/${imp.id}/authors/${authorOf(imp, '222').id}/avatar`)
      .set(authed(owner)).set('Content-Type', 'image/png').send(picture);
    expect(res.status).toBe(200);
    expect(res.body.avatar).toMatch(new RegExp(`/profile-pics/imports/${imp.id}/\\d+-[0-9a-f]+\\.webp$`));
    expect(objects.has(res.body.avatar.split(`${s3Endpoint}/`)[1])).toBe(true);
  });
});

describe('unlinking and undoing', () => {
  it('"This wasn\'t me" turns the messages back to the archive name, and the importer can\'t relink', async () => {
    const { owner, member, guild, general } = await setUp();
    const imp = await startImport(owner, guild, general);
    const sam = authorOf(imp, '111');
    await api.put(owner, `/guilds/${guild.id}/imports/${imp.id}/mapping`, { authors: [{ id: sam.id, userId: member.id }] });
    await api.post(owner, `/guilds/${guild.id}/imports/${imp.id}/messages`, {
      channelSourceId: '900',
      messages: [{ sourceId: 'u1', authorSourceId: '111', timestamp: ms('2024-01-01T00:00:00Z'), content: 'hi' }],
    });
    expect((await api.get(member, '/guild-imports/me')).body).toEqual([
      expect.objectContaining({ id: sam.id, name: 'Sam', guild_id: guild.id, source_guild_name: 'Old Crew', message_count: 1 }),
    ]);
    const outsider = await makeUser();
    expect((await api.post(outsider, `/guild-imports/authors/${sam.id}/unlink`)).status).toBe(404);

    const events = connect(owner);
    expect((await api.post(member, `/guild-imports/authors/${sam.id}/unlink`)).body).toEqual({ unlinked: 1 });
    const [message] = await messagesIn(owner, general);
    expect(message).toMatchObject({ sender_id: 0, sender_username: 'Sam', imported: { author: { name: 'Sam', mapped: false } } });
    expect(events).toContainEqual({ type: 'guild_history_changed', guildId: guild.id, channelId: general.id });
    expect((await api.get(member, '/guild-imports/me')).body).toEqual([]);
    // Not shown to the importer, but enforced.
    expect((await api.get(owner, `/guilds/${guild.id}/imports/${imp.id}`)).body.authors.find((a) => a.id === sam.id)).not.toHaveProperty('unlinked_user_id');
    const relink = await api.put(owner, `/guilds/${guild.id}/imports/${imp.id}/mapping`, { authors: [{ id: sam.id, userId: member.id }] });
    expect(relink.status).toBe(400);
  });

  it('lets a linked member delete their imported messages, not once unlinked; deleted ones never come back', async () => {
    const { owner, member, guild, general } = await setUp();
    const imp = await startImport(owner, guild, general);
    const sam = authorOf(imp, '111');
    await api.put(owner, `/guilds/${guild.id}/imports/${imp.id}/mapping`, { authors: [{ id: sam.id, userId: member.id }] });
    const batch = {
      channelSourceId: '900',
      messages: [
        { sourceId: 'd1', authorSourceId: '111', timestamp: ms('2024-01-01T00:00:00Z'), content: 'mine' },
        { sourceId: 'd2', authorSourceId: '111', timestamp: ms('2024-01-01T00:01:00Z'), content: 'also mine' },
        { sourceId: 'd3', authorSourceId: '222', timestamp: ms('2024-01-01T00:02:00Z'), content: 'not mine' },
      ],
    };
    await api.post(owner, `/guilds/${guild.id}/imports/${imp.id}/messages`, batch);
    const [mine, alsoMine, notMine] = await messagesIn(member, general);
    expect((await api.delete(member, `/guild-messages/${notMine.id}`)).status).toBe(403);
    expect((await api.delete(member, `/guild-messages/${mine.id}`)).status).toBe(200);
    // Unlinked, the rest are no longer theirs to delete.
    await api.post(member, `/guild-imports/authors/${sam.id}/unlink`);
    expect((await api.delete(member, `/guild-messages/${alsoMine.id}`)).status).toBe(403);
    // Sending the batch again (a continued import) doesn't bring the deleted one back.
    expect((await api.post(owner, `/guilds/${guild.id}/imports/${imp.id}/messages`, batch)).body).toEqual({ added: 0, skipped: 3 });
    expect((await messagesIn(owner, general)).map((m) => m.content)).toEqual(['also mine', 'not mine']);
  });

  it('unlinks everything at once', async () => {
    const { owner, member, guild, general } = await setUp();
    for (const n of [1, 2]) {
      const imp = await startImport(owner, guild, general);
      await api.put(owner, `/guilds/${guild.id}/imports/${imp.id}/mapping`, { authors: [{ id: authorOf(imp, '111').id, userId: member.id }] });
      await api.post(owner, `/guilds/${guild.id}/imports/${imp.id}/messages`, {
        channelSourceId: '900',
        messages: [{ sourceId: `a${n}`, authorSourceId: '111', timestamp: ms('2024-01-01T00:00:00Z') + n, content: `hi ${n}` }],
      });
    }
    expect((await api.post(member, '/guild-imports/me/unlink-all')).body).toEqual({ unlinked: 2 });
    expect((await messagesIn(owner, general)).every((m) => m.sender_id === 0)).toBe(true);
  });

  it('remaps and renames authors, and deleting the import removes its messages', async () => {
    const { owner, member, guild, general } = await setUp();
    const imp = await startImport(owner, guild, general);
    const kestrel = authorOf(imp, '222');
    await api.post(owner, `/guilds/${guild.id}/imports/${imp.id}/messages`, {
      channelSourceId: '900',
      messages: [{ sourceId: 'r1', authorSourceId: '222', timestamp: ms('2024-01-01T00:00:00Z'), content: 'old words' }],
    });
    await api.put(owner, `/guilds/${guild.id}/imports/${imp.id}/mapping`, { authors: [{ id: kestrel.id, userId: member.id }] });
    expect((await messagesIn(owner, general))[0].sender_id).toBe(member.id);
    await api.put(owner, `/guilds/${guild.id}/imports/${imp.id}/mapping`, { authors: [{ id: kestrel.id, userId: null, name: 'Former member' }] });
    expect((await messagesIn(owner, general))[0]).toMatchObject({ sender_id: 0, sender_username: 'Former member' });

    const live = await api.post(owner, `/channels/${general.id}/messages`, { content: 'stays' });
    expect((await api.delete(member, `/guilds/${guild.id}/imports/${imp.id}`)).status).toBe(403);
    expect((await api.delete(owner, `/guilds/${guild.id}/imports/${imp.id}`)).status).toBe(200);
    expect((await messagesIn(owner, general)).map((m) => m.id)).toEqual([live.body.id]);
    expect((await api.get(owner, `/guilds/${guild.id}/imports`)).body).toEqual([]);
  });

  it("makes the archive's custom emoji the guild's ones the importer chose, or text", async () => {
    const { owner, guild, general } = await setUp();
    const other = (await api.post(owner, '/guilds', { name: 'Elsewhere' })).body;
    const emoji = async (g, name) => (await db.run(
      'INSERT INTO guild_emojis (guild_id, name, creator_id, available) VALUES (?, ?, ?, 1)', [g.id, name, owner.id]
    )).lastID;
    const party = await emoji(guild, 'party');
    const blob = await emoji(guild, 'blobwave');
    const foreign = await emoji(other, 'theirs');
    const imp = await startImport(owner, guild, general, {
      emojis: [{ sourceId: '5001', name: 'partyparrot' }, { sourceId: '5002', name: 'blobwave' }, { sourceId: '5003', name: 'wave' }, { sourceId: '5004', name: 'party' }],
    });
    expect(imp.emojis.map((e) => e.name)).toEqual(['partyparrot', 'blobwave', 'wave', 'party']);
    const mapping = (emojis) => api.put(owner, `/guilds/${guild.id}/imports/${imp.id}/mapping`, { emojis });
    expect((await mapping([{ sourceId: '5003', emojiId: foreign }])).status).toBe(400);
    expect((await mapping([{ sourceId: 'nope', emojiId: party }])).status).toBe(400);
    const mapped = await mapping([{ sourceId: '5001', emojiId: party }, { sourceId: '5004', emojiId: null }]);
    expect(mapped.status).toBe(200);
    expect(mapped.body.emojis.find((e) => e.source_id === '5001')).toMatchObject({ emoji_id: party, mapped: 1 });

    await api.post(owner, `/guilds/${guild.id}/imports/${imp.id}/messages`, {
      channelSourceId: '900',
      messages: [{
        sourceId: 'e1', authorSourceId: '222', timestamp: ms('2024-01-02T10:00:00Z'),
        // Chosen; not chosen (the same name); chosen as text although the guild has :party:; unknown.
        content: '<a:partyparrot:5001> <:blobwave:5002> <:party:5004> <:wave:5003>',
        reactions: [{ customName: 'partyparrot', customId: '5001', count: 1, userSourceIds: ['222'] }, { customName: 'party', customId: '5004', count: 2 }],
      }],
    });
    const [message] = (await messagesIn(owner, general)).filter((m) => m.import_id);
    expect(message.content).toBe(`<:party:${party}> <:blobwave:${blob}> :party: :wave:`);
    expect(message.import_reactions.map((r) => r.emoji)).toEqual([`<:party:${party}>`, ':party:']);
  });

  it("doesn't put messages into channels of other guilds or non-chat channels", async () => {
    const { owner, guild } = await setUp();
    const other = (await api.post(owner, '/guilds', { name: 'Elsewhere' })).body;
    const imp = (await api.post(owner, `/guilds/${guild.id}/imports`, ARCHIVE)).body;
    const res = await api.put(owner, `/guilds/${guild.id}/imports/${imp.id}/mapping`, { channels: [{ sourceId: '900', channelId: other.channels[0].id }] });
    expect(res.status).toBe(400);
    const unmapped = await api.post(owner, `/guilds/${guild.id}/imports/${imp.id}/messages`, {
      channelSourceId: '901', messages: [],
    });
    expect(unmapped.status).toBe(400);
  });
});
