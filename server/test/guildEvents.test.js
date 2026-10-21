import './helpers/mockS3.js';
import { sentPushes, waitForPushes } from './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db.js');
const { PERMISSIONS: P, DEFAULT_EVERYONE_PERMISSIONS } = require('../permissions.js');
const guildEvents = require('../guildEvents.js');
const { nextOccurrence, cleanRule, startsOnRule, fromWallClock, wallClock, addDays, dateKeyIn, occurrenceOnDate, isOccurrence } = require('../eventRecurrence.js');
const { scheduledEventObject } = require('../discord.js');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser(prefix = 'event-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-events-123';
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

async function subscribe(user) {
  const endpoint = `https://push.test/${user.username}`;
  await api.post(user, '/save-subscription', { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } });
  return endpoint;
}

const now = () => Math.floor(Date.now() / 1000);
const HOUR = 3600;

// A guild with an owner, `count` members and a voice channel.
async function setUp(count = 2) {
  const owner = await makeUser('e-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Events Guild' })).body;
  const members = [];
  for (let i = 0; i < count; i++) {
    const user = await makeUser('e-member');
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(user, `/invites/${invite.body.code}`);
    members.push(user);
  }
  const voice = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'Lounge', type: 'voice' })).body;
  return { owner, members, guild, voice, everyone: guild.roles.find((r) => r.is_everyone) };
}

const external = (overrides = {}) => ({
  name: 'Picnic', description: 'Bring food', entityType: 'external', location: 'The park',
  startTime: now() + HOUR, endTime: now() + 3 * HOUR, ...overrides,
});
const inVoice = (voice, overrides = {}) => ({ name: 'Game night', entityType: 'voice', channelId: voice.id, startTime: now() + HOUR, ...overrides });
const create = (user, guild, body) => api.post(user, `/guilds/${guild.id}/events`, body);
const listOf = async (user, guild) => (await api.get(user, `/guilds/${guild.id}/events`)).body;
const setEveryone = (owner, guild, everyone, permissions) => api.patch(owner, `/guilds/${guild.id}/roles/${everyone.id}`, { permissions });

describe('scheduled events', () => {
  it('gives @everyone Create Events but not Manage Events', () => {
    expect(DEFAULT_EVERYONE_PERMISSIONS & P.CREATE_EVENTS).toBe(P.CREATE_EVENTS);
    expect(DEFAULT_EVERYONE_PERMISSIONS & P.MANAGE_EVENTS).toBe(0);
  });

  it('creates an event somewhere else, makes its creator interested and tells the guild', async () => {
    const { owner, members: [alice], guild } = await setUp(1);
    const heard = listen(alice);
    const res = await create(alice, guild, external());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Picnic', description: 'Bring food', entity_type: 'external', location: 'The park', channel_id: null,
      status: 'scheduled', creator_id: alice.id, user_count: 1, interested: true, recurrence: null,
    });
    expect(heard).toContainEqual(expect.objectContaining({ type: 'guild_event_create', guildId: guild.id, event: expect.objectContaining({ id: res.body.id }) }));
    const list = await listOf(owner, guild);
    expect(list).toEqual([expect.objectContaining({ id: res.body.id, interested: false, user_count: 1 })]);
  });

  it('leaves the location of an event somewhere else optional', async () => {
    const { owner, guild } = await setUp(0);
    const res = await create(owner, guild, external({ location: null }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ entity_type: 'external', location: null });
    const set = await api.patch(owner, `/guild-events/${res.body.id}`, { location: 'The park' });
    expect(set.body.location).toBe('The park');
    expect((await api.patch(owner, `/guild-events/${res.body.id}`, { location: '  ' })).body.location).toBeNull();
  });

  it('checks what is sent', async () => {
    const { owner, guild, voice } = await setUp(0);
    const bad = async (body, message) => {
      const res = await create(owner, guild, body);
      expect(res.status).toBe(400);
      if (message) expect(res.body.error).toMatch(message);
    };
    await bad(external({ name: '' }), /name/);
    await bad(external({ name: 'x'.repeat(101) }), /name/);
    await bad(external({ description: 'x'.repeat(1001) }), /description/);
    await bad(external({ endTime: null }), /end time/);
    await bad(external({ startTime: now() - 10 }), /future/);
    await bad(external({ endTime: now() + 10 }), /after the start/);
    await bad(external({ entityType: 'stage' }));
    await bad(inVoice({ id: 999999 }), /voice channel/);
    await bad(inVoice(guild.channels[0]), /voice channel/); // #general is a text channel
    await bad(external({ image: 'https://elsewhere.test/x.png' }), /cover/);
    await bad(external({ recurrence: { frequency: 2, interval: 3, by_weekday: [0] } }), /repeat/);
    await bad(external({ timezone: 'Mars/Olympus' }), /time zone/);
    // A voice event needs no end time or location.
    expect((await create(owner, guild, inVoice(voice))).status).toBe(201);
  });

  it('needs Create Events, and Connect for a voice channel', async () => {
    const { owner, members: [alice], guild, voice, everyone } = await setUp(1);
    await setEveryone(owner, guild, everyone, DEFAULT_EVERYONE_PERMISSIONS & ~P.CREATE_EVENTS);
    expect((await create(alice, guild, external())).status).toBe(403);
    await setEveryone(owner, guild, everyone, DEFAULT_EVERYONE_PERMISSIONS & ~P.CONNECT);
    expect((await create(alice, guild, inVoice(voice))).status).toBe(403);
    expect((await create(alice, guild, external())).status).toBe(201);
  });

  it('lets the creator (with Create Events) and Manage Events edit, and nobody else', async () => {
    const { owner, members: [alice, bob], guild, everyone } = await setUp(2);
    const event = (await create(alice, guild, external())).body;
    const heard = listen(owner);
    const res = await api.patch(alice, `/guild-events/${event.id}`, { name: 'Big picnic', location: 'The beach' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Big picnic', location: 'The beach', description: 'Bring food' });
    expect(heard).toContainEqual(expect.objectContaining({ type: 'guild_event_update', event: expect.objectContaining({ name: 'Big picnic' }) }));
    expect((await api.patch(bob, `/guild-events/${event.id}`, { name: 'Mine now' })).status).toBe(403);
    expect((await api.delete(bob, `/guild-events/${event.id}`)).status).toBe(403);

    const mods = (await api.post(owner, `/guilds/${guild.id}/roles`, { name: 'Mods', permissions: P.MANAGE_EVENTS })).body;
    await api.put(owner, `/guilds/${guild.id}/members/${bob.id}/roles`, { roleIds: [mods.id] });
    expect((await api.patch(bob, `/guild-events/${event.id}`, { name: 'Moderated' })).status).toBe(200);

    // Without Create Events, even the creator can't.
    await setEveryone(owner, guild, everyone, DEFAULT_EVERYONE_PERMISSIONS & ~P.CREATE_EVENTS);
    expect((await api.patch(alice, `/guild-events/${event.id}`, { name: 'Again' })).status).toBe(403);
  });

  it('logs creating, editing and cancelling in the audit log', async () => {
    const { owner, guild } = await setUp(0);
    const event = (await create(owner, guild, external())).body;
    await api.patch(owner, `/guild-events/${event.id}`, { name: 'Renamed' });
    await api.delete(owner, `/guild-events/${event.id}`);
    const log = (await api.get(owner, `/guilds/${guild.id}/audit-log?actions=event_create,event_update,event_delete`)).body;
    expect(log.entries.map((e) => e.action)).toEqual(['event_delete', 'event_update', 'event_create']);
    expect(log.entries[1].details).toMatchObject({ name: 'Picnic', changes: { name: ['Picnic', 'Renamed'] } });
  });

  it('cancelling deletes it and tells everyone', async () => {
    const { owner, members: [alice], guild } = await setUp(1);
    const event = (await create(owner, guild, external())).body;
    const heard = listen(alice);
    expect((await api.delete(owner, `/guild-events/${event.id}`)).status).toBe(200);
    expect(heard).toContainEqual(expect.objectContaining({ type: 'guild_event_delete', event: expect.objectContaining({ id: event.id, status: 'canceled' }) }));
    expect(await listOf(alice, guild)).toEqual([]);
    expect((await api.get(alice, `/guild-events/${event.id}`)).status).toBe(404);
  });

  it('keeps who is interested, and tells everyone the count', async () => {
    const { owner, members: [alice, bob], guild } = await setUp(2);
    const event = (await create(owner, guild, external())).body;
    const heard = listen(bob);
    expect((await api.put(alice, `/guild-events/${event.id}/interest`)).status).toBe(200);
    await api.put(alice, `/guild-events/${event.id}/interest`); // twice is once
    expect(heard.filter((e) => e.type === 'guild_event_interest')).toEqual([
      {
        type: 'guild_event_interest', guildId: guild.id, eventId: event.id, userId: alice.id,
        interested: true, interestedAll: true, occurrences: {}, changed: true, userCount: 2,
      },
    ]);
    expect((await api.get(alice, `/guild-events/${event.id}`)).body).toMatchObject({ interested: true, user_count: 2 });
    expect((await api.get(bob, `/guild-events/${event.id}/users`)).body.sort()).toEqual([owner.id, alice.id].sort());
    await api.delete(alice, `/guild-events/${event.id}/interest`);
    expect((await api.get(alice, `/guild-events/${event.id}`)).body).toMatchObject({ interested: false, user_count: 1 });

    // Leaving the guild drops it.
    await api.put(bob, `/guild-events/${event.id}/interest`);
    await api.delete(bob, `/guilds/${guild.id}/members/me`);
    expect((await api.get(owner, `/guild-events/${event.id}`)).body.user_count).toBe(1);
  });

  it("hides a voice channel's events from those who can't see the channel", async () => {
    const { owner, members: [alice], guild, voice, everyone } = await setUp(1);
    await api.put(owner, `/guilds/${guild.id}/channels/${voice.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.VIEW_CHANNEL });
    const heard = listen(alice);
    const event = (await create(owner, guild, inVoice(voice))).body;
    expect(heard.some((e) => e.type === 'guild_event_create')).toBe(false);
    expect(await listOf(alice, guild)).toEqual([]);
    expect((await api.get(alice, `/guild-events/${event.id}`)).status).toBe(404);
    expect((await api.put(alice, `/guild-events/${event.id}/interest`)).status).toBe(404);
    expect(await listOf(owner, guild)).toHaveLength(1);
  });

  it('moving an event out of sight tells those who no longer see it', async () => {
    const { owner, members: [alice], guild, voice, everyone } = await setUp(1);
    const hidden = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'Staff', type: 'voice' })).body;
    await api.put(owner, `/guilds/${guild.id}/channels/${hidden.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.VIEW_CHANNEL });
    const event = (await create(owner, guild, inVoice(voice))).body;
    const heard = listen(alice);
    expect((await api.patch(owner, `/guild-events/${event.id}`, { channelId: hidden.id })).status).toBe(200);
    expect(heard.map((e) => e.type)).toEqual(['guild_event_delete']);
  });

  it('deleting its channel deletes a voice event', async () => {
    const { owner, members: [alice], guild, voice } = await setUp(1);
    const event = (await create(owner, guild, inVoice(voice))).body;
    const heard = listen(alice);
    await api.delete(owner, `/guilds/${guild.id}/channels/${voice.id}`);
    expect(await guildEvents.getEvent(event.id)).toBeFalsy();
    expect(heard).toContainEqual(expect.objectContaining({ type: 'guild_event_delete', event: expect.objectContaining({ id: event.id }) }));
  });

  it('deleting the guild deletes its events', async () => {
    const { owner, guild } = await setUp(0);
    const event = (await create(owner, guild, external())).body;
    await api.delete(owner, `/guilds/${guild.id}`);
    expect(await guildEvents.getEvent(event.id)).toBeFalsy();
    expect(await db.get('SELECT 1 FROM guild_event_users WHERE event_id = ?', [event.id])).toBeFalsy();
  });

  it('a guild holds at most 100 events', async () => {
    const { owner, guild } = await setUp(0);
    const at = now();
    for (let i = 0; i < guildEvents.MAX_EVENTS_PER_GUILD; i++) {
      await db.run(
        `INSERT INTO guild_events (guild_id, creator_id, name, entity_type, location, start_time, end_time, created_at, updated_at)
         VALUES (?, ?, 'x', 'external', 'y', ?, ?, ?, ?)`,
        [guild.id, owner.id, at + HOUR, at + 2 * HOUR, at, at]
      );
    }
    expect((await create(owner, guild, external())).body.error).toMatch(/at most 100/);
  });

  it('links its cover to the upload, and lets it go when the event does', async () => {
    const { owner, guild } = await setUp(0);
    const upload = (await api.get(owner, '/upload_file?type=image/png&size=100')).body;
    const event = (await create(owner, guild, external({ image: upload.fileUrl }))).body;
    expect(event.image).toBe(upload.fileUrl);
    const key = upload.fileUrl.split('/uploads/')[1];
    expect(await db.get("SELECT 1 FROM upload_refs WHERE kind = 'event' AND owner_id = ? AND key = ?", [event.id, key])).toBeTruthy();
    await api.delete(owner, `/guild-events/${event.id}`);
    await require('../uploads.js').cleanUpUploads();
    expect(await db.get('SELECT 1 FROM uploads WHERE key = ?', [key])).toBeFalsy();
  });

  describe('starting and ending', () => {
    it('starts an event somewhere else on time, tells the interested, and ends it on time', async () => {
      const { owner, members: [alice, bob], guild } = await setUp(2);
      const event = (await create(owner, guild, external())).body;
      await api.put(alice, `/guild-events/${event.id}/interest`);
      await subscribe(alice);
      await subscribe(bob);
      const heard = listen(bob);
      const before = sentPushes.length;
      await guildEvents.sweepEvents(event.start_time);
      expect((await guildEvents.getEvent(event.id)).status).toBe('active');
      expect(heard).toContainEqual(expect.objectContaining({ type: 'guild_event_update', event: expect.objectContaining({ status: 'active' }) }));
      await waitForPushes(1, before);
      const pushes = sentPushes.filter((p) => p.payload.tag === `event-${event.id}`);
      expect(pushes.map((p) => p.endpoint)).toEqual([`https://push.test/${alice.username}`]);
      expect(pushes[0].payload).toMatchObject({ type: 'event', title: 'Picnic', url: `/guild/${guild.id}?event=${event.id}` });
      expect(pushes[0].payload.body).toMatch(/Starting now · The park \(Events Guild\)/);

      await guildEvents.sweepEvents(event.end_time);
      expect(await guildEvents.getEvent(event.id)).toBeFalsy();
      expect(heard).toContainEqual(expect.objectContaining({ type: 'guild_event_update', event: expect.objectContaining({ id: event.id, status: 'completed' }) }));
    });

    it('starts a voice event at its time, or earlier by hand, and ends it by hand', async () => {
      const { owner, members: [alice], guild, voice } = await setUp(1);
      const timed = (await create(owner, guild, inVoice(voice))).body;
      await guildEvents.sweepEvents(timed.start_time - 1);
      expect((await guildEvents.getEvent(timed.id)).status).toBe('scheduled');
      await guildEvents.sweepEvents(timed.start_time);
      expect((await guildEvents.getEvent(timed.id)).status).toBe('active');

      const event = (await create(owner, guild, inVoice(voice, { startTime: now() + 2 * HOUR }))).body;
      expect((await api.post(alice, `/guild-events/${event.id}/start`)).status).toBe(403);
      expect((await api.post(owner, `/guild-events/${event.id}/end`)).status).toBe(400);
      const res = await api.post(owner, `/guild-events/${event.id}/start`);
      expect(res.body).toMatchObject({ status: 'active' });
      expect((await api.post(owner, `/guild-events/${event.id}/start`)).status).toBe(400);
      expect((await api.post(owner, `/guild-events/${event.id}/end`)).body).toMatchObject({ status: 'completed' });
      expect(await guildEvents.getEvent(event.id)).toBeFalsy();
    });

    it('ends a voice event without an end once its channel stays empty after someone came, or nobody did', async () => {
      const { owner, guild, voice: channel } = await setUp(0);
      const voice = require('../voice.js');
      const realMembers = voice.membersOf;
      let present = [];
      voice.membersOf = (id) => (id === channel.id ? present : realMembers(id));
      try {
        // Nobody comes: on for UNATTENDED_SECONDS (not ended 5 minutes in, before anyone could).
        const lonely = (await create(owner, guild, inVoice(channel))).body;
        await guildEvents.sweepEvents(lonely.start_time);
        const started = (await guildEvents.getEvent(lonely.id)).started_at;
        await guildEvents.sweepEvents(started + guildEvents.EMPTY_SECONDS * 2);
        expect((await guildEvents.getEvent(lonely.id)).status).toBe('active');
        await guildEvents.sweepEvents(started + guildEvents.UNATTENDED_SECONDS);
        expect(await guildEvents.getEvent(lonely.id)).toBeFalsy();

        // Someone comes, then leaves: ends EMPTY_SECONDS later.
        const party = (await create(owner, guild, inVoice(channel))).body;
        await api.post(owner, `/guild-events/${party.id}/start`);
        const t = now();
        present = [{ userId: owner.id }];
        await guildEvents.sweepEvents(t);
        present = [];
        await guildEvents.sweepEvents(t + 1);
        await guildEvents.sweepEvents(t + 1 + guildEvents.EMPTY_SECONDS - 1);
        expect((await guildEvents.getEvent(party.id)).status).toBe('active');
        await guildEvents.sweepEvents(t + 1 + guildEvents.EMPTY_SECONDS);
        expect(await guildEvents.getEvent(party.id)).toBeFalsy();
      } finally {
        voice.membersOf = realMembers;
      }
    });

    it('ends a voice event with an end at its end, empty or not', async () => {
      const { owner, guild, voice } = await setUp(0);
      const event = (await create(owner, guild, inVoice(voice, { endTime: now() + 3 * HOUR }))).body;
      await guildEvents.sweepEvents(event.start_time);
      await guildEvents.sweepEvents(event.start_time + guildEvents.EMPTY_SECONDS * 3);
      expect((await guildEvents.getEvent(event.id)).status).toBe('active');
      await guildEvents.sweepEvents(event.end_time);
      expect(await guildEvents.getEvent(event.id)).toBeFalsy();
    });

    it('just ends an occurrence whose end went by before it could start', async () => {
      const { owner, guild } = await setUp(0);
      const event = (await create(owner, guild, external())).body;
      await guildEvents.sweepEvents(event.end_time);
      expect(await guildEvents.getEvent(event.id)).toBeFalsy();
    });

    it("can't move a started event's start time", async () => {
      const { owner, guild, voice } = await setUp(0);
      const event = (await create(owner, guild, inVoice(voice))).body;
      await api.post(owner, `/guild-events/${event.id}/start`);
      expect((await api.patch(owner, `/guild-events/${event.id}`, { startTime: now() + 2 * HOUR })).body.error).toMatch(/started/);
      expect((await api.patch(owner, `/guild-events/${event.id}`, { name: 'Still on' })).status).toBe(200);
    });
  });

  describe('repeating events', () => {
    const zone = 'Europe/London';
    // Next Monday at 20:00 in London, at least a day away.
    function nextMonday() {
      let t = now() + 86400;
      while (wallClock(t * 1000, zone).hour !== 12 || new Date(t * 1000).getUTCDay() !== 1) t += 3600;
      const w = wallClock(t * 1000, zone);
      return Math.floor(fromWallClock({ ...w, hour: 20, minute: 0, second: 0 }, zone) / 1000);
    }
    const weekly = { frequency: 2, interval: 1, by_weekday: [0] };

    it('must start on one of its days', async () => {
      const { owner, guild } = await setUp(0);
      const monday = nextMonday();
      const res = await create(owner, guild, external({ startTime: monday + 86400, endTime: monday + 86400 + HOUR, recurrence: weekly, timezone: zone }));
      expect(res.body.error).toMatch(/days the event repeats/);
      const ok = await create(owner, guild, external({ startTime: monday, endTime: monday + HOUR, recurrence: weekly, timezone: zone }));
      expect(ok.body).toMatchObject({ recurrence: { ...weekly, by_n_weekday: null, by_month: null, by_month_day: null }, timezone: zone, occurrence_start: monday });
    });

    it('moves on to the next occurrence when one ends, keeping who is interested', async () => {
      const { owner, members: [alice], guild } = await setUp(1);
      const monday = nextMonday();
      const event = (await create(owner, guild, external({ startTime: monday, endTime: monday + 2 * HOUR, recurrence: weekly, timezone: zone }))).body;
      await api.put(alice, `/guild-events/${event.id}/interest`);
      await guildEvents.sweepEvents(monday);
      expect((await guildEvents.getEvent(event.id)).status).toBe('active');
      // Ended a week from now? Not yet; the occurrence ends at 22:00 and the next is a week on.
      const realNow = Date.now;
      Date.now = () => (monday + 2 * HOUR) * 1000;
      try {
        await guildEvents.sweepEvents(monday + 2 * HOUR);
      } finally {
        Date.now = realNow;
      }
      const next = await guildEvents.loadPublic(event.id);
      const expected = nextOccurrence(cleanRule(weekly), zone, monday);
      expect(next).toMatchObject({ status: 'scheduled', start_time: expected, end_time: expected + 2 * HOUR, occurrence_start: expected, user_count: 2 });
      expect(wallClock(expected * 1000, zone).hour).toBe(20);
    });

    it('takes interest in just the current occurrence, or all but it, until the series moves on', async () => {
      const { owner, members: [alice, bob, carol], guild } = await setUp(3);
      const monday = nextMonday();
      const event = (await create(owner, guild, external({ startTime: monday, endTime: monday + HOUR, recurrence: weekly, timezone: zone }))).body;
      const url = `/guild-events/${event.id}/interest`;
      const heard = listen(carol);

      // Alice: only this one. Bob: all of them, then not this one. Owner: none of them.
      expect((await api.put(alice, `${url}?occurrence=1`)).body).toMatchObject({ interested: true, interested_all: false });
      await api.put(bob, url);
      expect((await api.delete(bob, `${url}?occurrence=1`)).body).toMatchObject({ interested: false, interested_all: true });
      await api.delete(owner, url);
      expect((await api.get(alice, `/guild-events/${event.id}`)).body).toMatchObject({ interested: true, interested_all: false, user_count: 1 });
      expect((await api.get(bob, `/guild-events/${event.id}`)).body).toMatchObject({ interested: false, interested_all: true });
      expect((await api.get(carol, `/guild-events/${event.id}/users`)).body).toEqual([alice.id]);
      expect(heard.filter((e) => e.type === 'guild_event_interest').map((e) => [e.userId, e.interested, e.interestedAll, e.changed, e.userCount])).toEqual([
        [alice.id, true, false, true, 2], [bob.id, true, true, true, 3], [bob.id, false, true, true, 2], [owner.id, false, false, true, 1],
      ]);
      // Bob wants this one back after all; the owner takes all of them and drops all again.
      expect((await api.put(bob, `${url}?occurrence=1`)).body).toMatchObject({ interested: true, interested_all: true });
      await api.delete(bob, `${url}?occurrence=1`);
      await api.delete(alice, `${url}?occurrence=1`);
      await api.put(alice, `${url}?occurrence=1`);

      // Skipping the occurrence: Alice's interest went with it, Bob's series is back.
      const second = nextOccurrence(cleanRule(weekly), zone, monday);
      expect((await api.post(owner, `/guild-events/${event.id}/skip`)).body).toMatchObject({ occurrence_start: second, user_count: 1 });
      expect((await api.get(alice, `/guild-events/${event.id}`)).body).toMatchObject({ interested: false, interested_all: false });
      expect((await api.get(bob, `/guild-events/${event.id}`)).body).toMatchObject({ interested: true, interested_all: true });

      // One that doesn't repeat: just this one is all of it.
      const plain = (await create(owner, guild, external())).body;
      expect((await api.put(alice, `/guild-events/${plain.id}/interest?occurrence=1`)).body).toMatchObject({ interested: true, interested_all: true });
      expect((await api.delete(alice, `/guild-events/${plain.id}/interest?occurrence=1`)).body).toMatchObject({ interested: false, interested_all: false });
    });

    it('notifies only those interested in the occurrence that starts', async () => {
      const { owner, members: [alice, bob], guild } = await setUp(2);
      const monday = nextMonday();
      const event = (await create(owner, guild, external({ startTime: monday, endTime: monday + HOUR, recurrence: weekly, timezone: zone }))).body;
      await api.delete(owner, `/guild-events/${event.id}/interest`);
      const aliceEndpoint = await subscribe(alice);
      const bobEndpoint = await subscribe(bob);
      await api.put(alice, `/guild-events/${event.id}/interest`);
      await api.delete(alice, `/guild-events/${event.id}/interest?occurrence=1`);
      await api.put(bob, `/guild-events/${event.id}/interest?occurrence=1`);
      const before = sentPushes.length;
      await guildEvents.sweepEvents(monday);
      await waitForPushes(1, before);
      const pushes = sentPushes.filter((p) => p.payload.tag === `event-${event.id}`);
      expect(pushes.map((p) => p.endpoint)).toEqual([bobEndpoint]);
      expect(pushes.map((p) => p.endpoint)).not.toContain(aliceEndpoint);
      // The link is to this occurrence: its date.
      expect(pushes[0].payload.url).toBe(`/guild/${guild.id}?event=${event.id}&on=${dateKeyIn(monday, zone)}`);
    });

    it('skips or moves just the next occurrence', async () => {
      const { owner, guild } = await setUp(0);
      const monday = nextMonday();
      const event = (await create(owner, guild, external({ startTime: monday, endTime: monday + HOUR, recurrence: weekly, timezone: zone }))).body;
      const second = nextOccurrence(cleanRule(weekly), zone, monday);

      const moved = await api.put(owner, `/guild-events/${event.id}/occurrence`, { startTime: monday + 86400 });
      expect(moved.body).toMatchObject({ start_time: monday + 86400, end_time: monday + 86400 + HOUR, occurrence_start: monday });
      expect((await api.put(owner, `/guild-events/${event.id}/occurrence`, { startTime: second })).body.error).toMatch(/before the next/);

      const skipped = await api.post(owner, `/guild-events/${event.id}/skip`);
      expect(skipped.body).toMatchObject({ start_time: second, end_time: second + HOUR, occurrence_start: second });
      const plain = (await create(owner, guild, external())).body;
      expect((await api.post(owner, `/guild-events/${plain.id}/skip`)).body.error).toMatch(/doesn't repeat/);
    });

    it('a voice series nobody came to moves on', async () => {
      const { owner, guild, voice } = await setUp(0);
      const monday = nextMonday();
      const event = (await create(owner, guild, inVoice(voice, { startTime: monday, recurrence: { frequency: 3, interval: 1, by_weekday: null }, timezone: zone }))).body;
      await guildEvents.sweepEvents(monday);
      expect((await guildEvents.getEvent(event.id)).status).toBe('active');
      const realNow = Date.now;
      Date.now = () => (monday + guildEvents.UNATTENDED_SECONDS) * 1000;
      try {
        await guildEvents.sweepEvents(monday + guildEvents.UNATTENDED_SECONDS);
      } finally {
        Date.now = realNow;
      }
      const after = await guildEvents.getEvent(event.id);
      expect(after.status).toBe('scheduled');
      expect(after.start_time).toBeGreaterThan(monday + guildEvents.UNATTENDED_SECONDS);
      expect(after.start_time - monday).toBeLessThanOrEqual(86400 + HOUR);
    });
  });

  describe('single occurrences', () => {
    const zone = 'Europe/London';
    function nextMonday() {
      let t = now() + 86400;
      while (wallClock(t * 1000, zone).hour !== 12 || new Date(t * 1000).getUTCDay() !== 1) t += 3600;
      const w = wallClock(t * 1000, zone);
      return Math.floor(fromWallClock({ ...w, hour: 20, minute: 0, second: 0 }, zone) / 1000);
    }
    const weekly = { frequency: 2, interval: 1, by_weekday: [0] };
    // The weekly series' first `count` occurrences from `monday`.
    const dates = (monday, count) => {
      const list = [monday];
      while (list.length < count) list.push(nextOccurrence(cleanRule(weekly), zone, list[list.length - 1]));
      return list;
    };
    const series = (owner, guild, monday, overrides = {}) => create(owner, guild, external({
      startTime: monday, endTime: monday + HOUR, recurrence: weekly, timezone: zone, ...overrides,
    }));
    // Sweeps at `at` with the clock there too.
    async function sweepAt(at) {
      const realNow = Date.now;
      Date.now = () => at * 1000;
      try {
        await guildEvents.sweepEvents(at);
      } finally {
        Date.now = realNow;
      }
    }

    it('knows which dates are occurrences', () => {
      const monday = nextMonday();
      const [, second] = dates(monday, 2);
      expect(isOccurrence(cleanRule(weekly), zone, monday, second)).toBe(true);
      expect(isOccurrence(cleanRule(weekly), zone, monday, second + 60)).toBe(false);
      expect(isOccurrence(cleanRule(weekly), zone, monday, second + 86400)).toBe(false);
      expect(occurrenceOnDate(cleanRule(weekly), zone, monday, dateKeyIn(second, zone))).toBe(second);
      expect(occurrenceOnDate(cleanRule(weekly), zone, monday, dateKeyIn(second + 86400, zone))).toBeNull();
      expect(occurrenceOnDate(cleanRule(weekly), zone, monday, '2026-02-30')).toBeNull();
    });

    it('changes or cancels any occurrence still to come, and moves on past cancelled ones', async () => {
      const { owner, guild } = await setUp(0);
      const monday = nextMonday();
      const [, second, third, fourth] = dates(monday, 4);
      const { id } = (await series(owner, guild, monday)).body;
      const url = `/guild-events/${id}/occurrence`;

      const changed = await api.put(owner, url, { occurrence: third, startTime: third + 86400, name: 'Late picnic' });
      expect(changed.body).toMatchObject({ start_time: monday, occurrence_start: monday, name: 'Picnic' });
      expect(changed.body.occurrences).toEqual([{
        original_start: third, start_time: third + 86400, end_time: third + 86400 + HOUR, status: 'scheduled',
        name: 'Late picnic', description: null, location: null,
      }]);
      expect((await api.put(owner, url, { occurrence: third, startTime: fourth })).body.error).toMatch(/before the next/);
      expect((await api.put(owner, url, { occurrence: third, startTime: second })).body.error).toMatch(/after the one before/);
      expect((await api.put(owner, url, { occurrence: third + 60, startTime: third + HOUR })).body.error).toMatch(/isn't one of/);
      // The series' own name again is no change of its own.
      expect((await api.put(owner, url, { occurrence: fourth, name: 'Picnic' })).body.occurrences).toHaveLength(1);

      const skipped = await api.post(owner, `/guild-events/${id}/skip`, { occurrence: second });
      expect(skipped.body.occurrences.map((o) => [o.original_start, o.status])).toEqual([[second, 'canceled'], [third, 'scheduled']]);
      expect((await api.get(owner, `/guild-events/${id}?occurrence=${second}`)).body.occurrence).toEqual({ original_start: second, status: 'canceled' });
      expect((await api.get(owner, `/guild-events/${id}?on=${dateKeyIn(third, zone)}`)).body.occurrence).toMatchObject({
        original_start: third, start_time: third + 86400, name: 'Late picnic', status: 'scheduled', user_count: 1,
      });
      expect((await api.get(owner, `/guild-events/${id}?on=${dateKeyIn(monday + 86400, zone)}`)).body.occurrence).toBeNull();

      // The first takes place: it's kept, and the series moves on to the third (the second was
      // cancelled), at its own time, with its own name.
      await sweepAt(monday);
      await sweepAt(monday + HOUR);
      const next = await guildEvents.loadPublic(id);
      expect(next).toMatchObject({ occurrence_start: third, start_time: third + 86400, end_time: third + 86400 + HOUR, status: 'scheduled' });
      expect(next.occurrences.map((o) => o.original_start)).toEqual([third]);
      const history = (await api.get(owner, `/guilds/${guild.id}/event-history?from=${monday - 86400}&to=${monday + 86400}`)).body;
      expect(history).toEqual([expect.objectContaining({ id, original_start: monday, name: 'Picnic', status: 'completed', start_time: monday, end_time: monday + HOUR, user_count: 1 })]);
      expect((await api.get(owner, `/guild-events/${id}?on=${dateKeyIn(monday, zone)}`)).body.occurrence).toMatchObject({ status: 'completed', original_start: monday });
      expect((await api.get(owner, `/guilds/${guild.id}/event-history?from=0&to=${now()}`)).status).toBe(400);
    });

    it('takes interest in any occurrence to come, apart from the series', async () => {
      const { owner, members: [alice, bob], guild } = await setUp(2);
      const monday = nextMonday();
      const [, second, third] = dates(monday, 3);
      const { id } = (await series(owner, guild, monday)).body;
      const url = `/guild-events/${id}/interest`;
      const heard = listen(owner);

      // Alice: only the third. Bob: all but the second.
      expect((await api.put(alice, `${url}?occurrence=${third}`)).body).toEqual({ interested: true, interested_all: false, my_occurrences: { [third]: true } });
      await api.put(bob, url);
      expect((await api.delete(bob, `${url}?occurrence=${second}`)).body).toEqual({ interested: false, interested_all: true, my_occurrences: { [second]: false } });
      expect(heard.filter((e) => e.type === 'guild_event_interest').map((e) => [e.userId, e.interested, e.changed, e.userCount])).toEqual([
        [alice.id, false, false, 1], [bob.id, true, true, 2], [bob.id, true, false, 2],
      ]);
      const countOf = async (original) => (await api.get(owner, `/guild-events/${id}?occurrence=${original}`)).body.occurrence.user_count;
      expect([await countOf(monday), await countOf(second), await countOf(third)]).toEqual([2, 1, 3]);
      expect((await api.get(owner, `/guild-events/${id}/users?occurrence=${third}`)).body.sort()).toEqual([owner.id, alice.id, bob.id].sort());
      expect((await api.get(alice, `/guild-events/${id}`)).body).toMatchObject({ interested: false, interested_all: false, my_occurrences: { [third]: true }, user_count: 2 });

      // A cancelled one takes none; all of them replaces single ones.
      await api.post(owner, `/guild-events/${id}/skip`, { occurrence: second });
      expect((await api.get(bob, `/guild-events/${id}`)).body.my_occurrences).toEqual({});
      expect((await api.put(alice, `${url}?occurrence=${second}`)).body.error).toMatch(/cancelled/);
      expect((await api.put(alice, url)).body).toEqual({ interested: true, interested_all: true, my_occurrences: {} });
    });

    it('changes this and following as a new series, which old links follow once the old one ends', async () => {
      const { owner, members: [alice], guild } = await setUp(1);
      const monday = nextMonday();
      const [, second, third, fourth] = dates(monday, 4);
      const { id } = (await series(owner, guild, monday)).body;
      await api.put(alice, `/guild-events/${id}/interest`);
      await api.put(alice, `/guild-events/${id}/interest?occurrence=${fourth}`); // no change
      await api.delete(owner, `/guild-events/${id}/interest?occurrence=${fourth}`);
      await api.put(owner, `/guild-events/${id}/occurrence`, { occurrence: fourth, name: 'Fourth picnic' });

      const split = await api.patch(owner, `/guild-events/${id}?from=${third}`, { name: 'Bigger picnic', location: 'The beach' });
      expect(split.status).toBe(200);
      expect(split.body).toMatchObject({
        name: 'Bigger picnic', location: 'The beach', start_time: third, end_time: third + HOUR, occurrence_start: third,
        user_count: 2, interested: true, interested_all: true, my_occurrences: { [fourth]: false }, creator_id: owner.id,
      });
      expect(split.body.id).not.toBe(id);
      expect(split.body.occurrences.map((o) => [o.original_start, o.name])).toEqual([[fourth, 'Fourth picnic']]);
      const old = (await api.get(owner, `/guild-events/${id}`)).body;
      expect(old).toMatchObject({ name: 'Picnic', until: third, continued_as: split.body.id, occurrences: [] });
      expect(scheduledEventObject(old).recurrence_rule.end).toBe(new Date(third * 1000).toISOString());
      expect((await api.get(owner, `/guild-events/${id}?occurrence=${third}`)).body.occurrence).toBeNull();
      const log = (await api.get(owner, `/guilds/${guild.id}/audit-log?actions=event_update`)).body;
      expect(log.entries[0].details).toMatchObject({ repeat: 'split' });

      // The old one's two dates go by: it's gone, and its link opens the new one.
      await sweepAt(monday);
      await sweepAt(monday + HOUR);
      await sweepAt(second);
      await sweepAt(second + HOUR);
      expect(await guildEvents.getEvent(id)).toBeFalsy();
      expect((await api.get(alice, `/guild-events/${id}`)).body).toMatchObject({ id: split.body.id, name: 'Bigger picnic' });
      // Both took place under the old one's name.
      const history = (await api.get(owner, `/guilds/${guild.id}/event-history?from=${monday - 86400}&to=${second + 86400}`)).body;
      expect(history.map((h) => [h.id, h.original_start, h.name])).toEqual([[id, monday, 'Picnic'], [id, second, 'Picnic']]);

      // New times for the following ones drop their own changes.
      const retimed = await api.patch(owner, `/guild-events/${split.body.id}?from=${fourth}`, { startTime: fourth + HOUR, endTime: fourth + 2 * HOUR });
      expect(retimed.body).toMatchObject({ start_time: fourth + HOUR, name: 'Fourth picnic', occurrences: [], my_occurrences: {} });
    });

    it('cancels this and following', async () => {
      const { owner, guild } = await setUp(0);
      const monday = nextMonday();
      const [, , third] = dates(monday, 3);
      const { id } = (await series(owner, guild, monday)).body;
      const res = await api.delete(owner, `/guild-events/${id}?from=${third}`);
      expect(res.body).toMatchObject({ id, until: third });
      expect((await api.put(owner, `/guild-events/${id}/interest?occurrence=${third}`)).body.error).toMatch(/isn't one of/);
      // From the current one, that's all of it.
      expect((await api.delete(owner, `/guild-events/${id}?from=${monday}`)).body).toEqual({ success: true });
      expect((await api.get(owner, `/guild-events/${id}`)).status).toBe(404);
    });

    it('editing every occurrence anew drops single ones, a rename keeps them', async () => {
      const { owner, members: [alice], guild } = await setUp(1);
      const monday = nextMonday();
      const [, second] = dates(monday, 2);
      const { id } = (await series(owner, guild, monday)).body;
      await api.put(owner, `/guild-events/${id}/occurrence`, { occurrence: second, name: 'Second' });
      await api.put(alice, `/guild-events/${id}/interest?occurrence=${second}`);
      const renamed = await api.patch(owner, `/guild-events/${id}`, { name: 'Picnic!' });
      expect(renamed.body).toMatchObject({ revision: 0, occurrences: [expect.objectContaining({ original_start: second })] });
      const later = await api.patch(owner, `/guild-events/${id}`, { startTime: monday + HOUR, endTime: monday + 2 * HOUR });
      expect(later.body).toMatchObject({ revision: 1, occurrences: [], occurrence_start: monday + HOUR });
      expect((await api.get(alice, `/guild-events/${id}`)).body.my_occurrences).toEqual({});
    });

    it('keeps what took place where only those who can see it do', async () => {
      const { owner, members: [alice], guild, voice, everyone } = await setUp(1);
      const start = now() + HOUR;
      const { id } = (await create(owner, guild, inVoice(voice, { startTime: start }))).body;
      await sweepAt(start);
      await api.post(owner, `/guild-events/${id}/end`);
      const range = `from=${start - 86400}&to=${start + 86400}`;
      expect((await api.get(alice, `/guilds/${guild.id}/event-history?${range}`)).body).toEqual([
        expect.objectContaining({ id, channel_id: voice.id, original_start: null, status: 'completed', start_time: start }),
      ]);
      await api.put(owner, `/guilds/${guild.id}/channels/${voice.id}/overrides/role/${everyone.id}`, { allow: 0, deny: P.VIEW_CHANNEL });
      expect((await api.get(alice, `/guilds/${guild.id}/event-history?${range}`)).body).toEqual([]);
      await api.delete(owner, `/guilds/${guild.id}/channels/${voice.id}`);
      expect((await api.get(owner, `/guilds/${guild.id}/event-history?${range}`)).body).toEqual([]);
    });
  });
});

describe('all-day events, emoji and colour', () => {
  const zone = 'Europe/London';
  // Midnight in London `days` days from today.
  const midnight = (days) => {
    const w = wallClock(Date.now(), zone);
    return addDays(Math.floor(fromWallClock({ ...w, hour: 0, minute: 0, second: 0 }, zone) / 1000), days, zone);
  };
  const allDay = (overrides = {}) => external({ allDay: true, startTime: midnight(0), endTime: midnight(1), timezone: zone, ...overrides });

  it('keeps them, and may start on a day that has begun', async () => {
    const { owner, guild } = await setUp(0);
    const res = await create(owner, guild, allDay({ emoji: '🎲', color: 0x3498db }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ all_day: true, timezone: zone, emoji: '🎲', color: 0x3498db, start_time: midnight(0) });
    const custom = await api.patch(owner, `/guild-events/${res.body.id}`, { emoji: '<:dice:12>', color: null });
    expect(custom.body).toMatchObject({ emoji: '<:dice:12>', color: null });
    const log = (await api.get(owner, `/guilds/${guild.id}/audit-log?actions=event_update`)).body;
    expect(log.entries[0].details.changes).toMatchObject({ emoji: ['🎲', '<:dice:12>'], color: [0x3498db, null] });
    // Others are plain.
    expect((await create(owner, guild, external())).body).toMatchObject({ all_day: false, emoji: null, color: null });
  });

  it('checks what is sent', async () => {
    const { owner, guild } = await setUp(0);
    const bad = async (body, message) => {
      const res = await create(owner, guild, body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(message);
    };
    await bad(allDay({ startTime: midnight(-2), endTime: midnight(-1) }), /future/);
    await bad(allDay({ endTime: null }), /end/);
    await bad(allDay({ allDay: 'yes' }), /all-day/);
    await bad(external({ color: 0x1000000 }), /colour/);
    await bad(external({ emoji: 'a b' }), /emoji/);
    await bad(external({ emoji: 'x'.repeat(65) }), /emoji/);
  });

  it('starts at midnight without a push, and repeats on whole days', async () => {
    const { owner, members: [alice], guild } = await setUp(1);
    const start = midnight(2);
    const w = wallClock(start * 1000, zone);
    const weekday = (new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay() + 6) % 7; // Discord's: 0 Monday
    const weekly = { frequency: 2, interval: 1, by_weekday: [weekday] };
    const event = (await create(owner, guild, allDay({ startTime: start, endTime: addDays(start, 1, zone), recurrence: weekly }))).body;
    await api.put(alice, `/guild-events/${event.id}/interest`);
    await subscribe(alice);
    const before = sentPushes.length;
    await guildEvents.sweepEvents(start);
    expect((await guildEvents.getEvent(event.id)).status).toBe('active');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sentPushes.slice(before).filter((p) => p.payload.tag === `event-${event.id}`)).toEqual([]);
    // Its day ends at the next midnight: on to the same day next week, not the one after.
    const end = addDays(start, 1, zone);
    const realNow = Date.now;
    Date.now = () => end * 1000;
    try {
      await guildEvents.sweepEvents(end);
    } finally {
      Date.now = realNow;
    }
    const next = await guildEvents.loadPublic(event.id);
    expect(next).toMatchObject({ status: 'scheduled', start_time: addDays(start, 7, zone), end_time: addDays(start, 8, zone) });
  });

  it('a voice one is on from its first midnight until the one after its last day', async () => {
    const { owner, guild, voice } = await setUp(0);
    const start = midnight(1);
    const event = (await create(owner, guild, inVoice(voice, { allDay: true, startTime: start, endTime: addDays(start, 1, zone), timezone: zone }))).body;
    await guildEvents.sweepEvents(start - 1);
    expect((await guildEvents.getEvent(event.id)).status).toBe('scheduled');
    await guildEvents.sweepEvents(start);
    await guildEvents.sweepEvents(start + guildEvents.UNATTENDED_SECONDS);
    expect((await guildEvents.getEvent(event.id)).status).toBe('active');
    await guildEvents.sweepEvents(addDays(start, 1, zone));
    expect(await guildEvents.getEvent(event.id)).toBeFalsy();
  });

  it('moves midnight with the calendar across a clock change', () => {
    // Saturday 24 October 2026, 00:00 BST; the clocks go back on the 25th.
    const saturday = Date.UTC(2026, 9, 23, 23) / 1000;
    expect(new Date(addDays(saturday, 2, zone) * 1000).toISOString()).toBe('2026-10-26T00:00:00.000Z');
  });
});

describe('recurrence rules', () => {
  it("accepts only Discord's shapes", () => {
    expect(cleanRule({ frequency: 3, interval: 1 })).toBeTruthy();
    expect(cleanRule({ frequency: 3, interval: 1, by_weekday: [4, 0, 1, 2, 3] }).by_weekday).toEqual([0, 1, 2, 3, 4]);
    expect(cleanRule({ frequency: 3, interval: 2 })).toBeNull();
    expect(cleanRule({ frequency: 2, interval: 2, by_weekday: [3] })).toBeTruthy();
    expect(cleanRule({ frequency: 2, interval: 1, by_weekday: [1, 2] })).toBeNull();
    expect(cleanRule({ frequency: 1, interval: 1, by_n_weekday: [{ n: 2, day: 4 }] })).toBeTruthy();
    expect(cleanRule({ frequency: 1, interval: 1, by_n_weekday: [{ n: 6, day: 4 }] })).toBeNull();
    expect(cleanRule({ frequency: 0, interval: 1, by_month: [2], by_month_day: [29] })).toBeTruthy();
    expect(cleanRule({ frequency: 0, interval: 1, by_month: [4], by_month_day: [31] })).toBeNull();
    expect(cleanRule({ frequency: 7 })).toBeNull();
  });

  it('keeps the wall-clock time across clock changes', () => {
    const zone = 'Europe/London';
    // Monday 19 October 2026, 20:00 BST; the clocks go back on the 25th.
    const start = Date.UTC(2026, 9, 19, 19) / 1000;
    const rule = cleanRule({ frequency: 2, interval: 1, by_weekday: [0] });
    expect(startsOnRule(rule, start, zone)).toBe(true);
    const next = nextOccurrence(rule, zone, start);
    expect(new Date(next * 1000).toISOString()).toBe('2026-10-26T20:00:00.000Z');
  });

  it('every other week, the nth weekday of the month, and a yearly 29 February', () => {
    const start = Date.UTC(2026, 9, 19, 19) / 1000; // Monday
    const fortnightly = cleanRule({ frequency: 2, interval: 2, by_weekday: [0] });
    expect(new Date(nextOccurrence(fortnightly, 'UTC', start) * 1000).toISOString()).toBe('2026-11-02T19:00:00.000Z');
    const third = cleanRule({ frequency: 1, interval: 1, by_n_weekday: [{ n: 3, day: 0 }] });
    expect(new Date(nextOccurrence(third, 'UTC', start) * 1000).toISOString()).toBe('2026-11-16T19:00:00.000Z');
    const leap = cleanRule({ frequency: 0, interval: 1, by_month: [2], by_month_day: [29] });
    expect(new Date(nextOccurrence(leap, 'UTC', Date.UTC(2024, 1, 29, 10) / 1000) * 1000).toISOString()).toBe('2028-02-29T10:00:00.000Z');
  });
});

