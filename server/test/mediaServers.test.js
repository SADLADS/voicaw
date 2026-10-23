import './helpers/mockS3.js';
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createHash } from 'crypto';
import { AccessToken } from 'livekit-server-sdk';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const voice = require('../voice.js');
const mediaServers = require('../mediaServers.js');
const db = require('../db.js');

voice.livekit.roomService = { removeParticipant: async () => {}, updateParticipant: async () => {} };

// A pretend Jellyfin (or Emby, under /emby) at https://media.example: one account, "guild"
// (password "pw"), and "admin", an administrator. Every request is kept in `requests`.
const requests = [];
const server = { kind: 'jellyfin', loggedOut: [], tokens: 0 };
const ITEMS = {
  film1: { Id: 'film1', Name: 'A Film', Type: 'Movie', ProductionYear: 2020, RunTimeTicks: 60 * 10_000_000, ImageTags: { Primary: 'tag1' } },
  show1: { Id: 'show1', Name: 'A Show', Type: 'Series' },
  ep1: { Id: 'ep1', Name: 'Pilot', Type: 'Episode', SeriesName: 'A Show', ParentIndexNumber: 1, IndexNumber: 1, RunTimeTicks: 90 * 10_000_000 },
};
const json = (status, body) => ({ status, body: Buffer.from(body === undefined ? '' : JSON.stringify(body)), contentType: 'application/json' });

mediaServers.transport.fetch = async (href, options) => {
  const url = new URL(href);
  requests.push({ url, ...options });
  if (url.hostname !== 'media.example') throw new Error('unreachable');
  // Emby answers with or without /emby; Jellyfin 12 only without.
  if (server.kind === 'jellyfin' && url.pathname.startsWith('/emby/')) return json(404);
  const path = url.pathname.replace(/^\/emby/, '');
  // As Jellyfin 12: only the standard Authorization header (Emby's is refused with a 400);
  // Emby: its own headers.
  if (server.kind === 'jellyfin' && options.headers['X-Emby-Authorization']) return json(400);
  const token = server.kind === 'jellyfin'
    ? /Token="([^"]+)"/.exec(options.headers.Authorization ?? '')?.[1]
    : options.headers['X-Emby-Token'];
  const live = token && !server.loggedOut.includes(token);
  if (path === '/System/Info/Public') {
    if (options.headers.Authorization || options.headers['X-Emby-Authorization']) return json(500); // asked as nobody
    return json(200, { Id: 'srv', ServerName: 'Home Media', ...(server.kind === 'jellyfin' && { ProductName: 'Jellyfin Server' }) });
  }
  if (path === '/Users/AuthenticateByName' && options.method === 'POST') {
    const { Username, Pw } = JSON.parse(options.body);
    if (!['guild', 'admin'].includes(Username) || Pw !== 'pw') return json(401);
    return json(200, {
      AccessToken: `token-${++server.tokens}`,
      User: { Id: `user-${Username}`, Name: Username, Policy: { IsAdministrator: Username === 'admin' } },
    });
  }
  if (path === '/Sessions/Logout') {
    server.loggedOut.push(token);
    return json(204);
  }
  if (!live) return json(401);
  if (path === '/Items') return json(200, { Items: [ITEMS.film1, ITEMS.show1] });
  if (path === '/Shows/show1/Episodes') return json(200, { Items: [ITEMS.ep1] });
  const item = /^\/Users\/user-guild\/Items\/(\w+)$/.exec(path);
  if (item) return ITEMS[item[1]] ? json(200, ITEMS[item[1]]) : json(404);
  const playback = /^\/Items\/(\w+)\/PlaybackInfo$/.exec(path);
  if (playback && options.method === 'POST') {
    const id = playback[1];
    return json(200, {
      PlaySessionId: `session-${id}`,
      MediaSources: [id === 'film1'
        ? { Id: id, SupportsDirectPlay: true }
        : { Id: id, SupportsDirectPlay: false, TranscodingUrl: `/videos/${id}/master.m3u8?PlaySessionId=session-${id}&ApiKey=${token}` }],
    });
  }
  if (path === '/Videos/ActiveEncodings' && options.method === 'DELETE') return json(204);
  return json(404);
};

let userCount = 0;
async function makeUser(prefix = 'ms-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-media-123';
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  return { id: regRes.body.id, username, token: loginRes.body.token };
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
  delete: (user, url) => request(app).delete(`/api${url}`).set(authed(user)),
};

async function setUp() {
  const owner = await makeUser('owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Film Club' })).body;
  const alice = await makeUser('member');
  const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
  await api.post(alice, `/invites/${invite.body.code}`);
  const lounge = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'Cinema', type: 'voice' })).body;
  return { owner, alice, guild, lounge, base: `/guilds/${guild.id}/channels/${lounge.id}/watch-party`, settings: `/guilds/${guild.id}/media-server` };
}

const connect = (user, settings, body = {}) => api.put(user, settings, {
  kind: 'jellyfin', url: 'https://media.example/web/', username: 'guild', password: 'pw', ...body,
});

let sidCount = 0;
async function enter(user, channel) {
  const body = JSON.stringify({
    event: 'participant_joined',
    id: `EV_${++sidCount}`,
    createdAt: String(Math.floor(Date.now() / 1000)),
    room: { name: `channel-${channel.id}` },
    participant: { sid: `PA_${sidCount}`, identity: String(user.id), name: user.username },
  });
  const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
  token.sha256 = createHash('sha256').update(body).digest('base64');
  const res = await request(app).post('/api/livekit/webhook')
    .set('Authorization', await token.toJwt())
    .set('Content-Type', 'application/webhook+json')
    .send(body);
  expect(res.status).toBe(200);
}

beforeEach(() => {
  requests.length = 0;
  server.kind = 'jellyfin';
});

describe('Guild media servers', () => {
  it('connects with Manage Guild, keeping the token and never the password', async () => {
    const { owner, alice, guild, settings } = await setUp();
    expect((await connect(alice, settings)).status).toBe(403);
    expect((await api.get(alice, settings)).status).toBe(403);

    const res = await connect(owner, settings);
    expect(res.status).toBe(200);
    expect(res.body.server).toMatchObject({ kind: 'jellyfin', name: 'Home Media', url: 'https://media.example', username: 'guild', connected_by: owner.id });
    expect(JSON.stringify(res.body)).not.toMatch(/token-/);
    const row = await db.get('SELECT * FROM guild_media_servers WHERE guild_id = ?', [guild.id]);
    expect(row.token).toMatch(/^token-/);
    expect(JSON.stringify(row)).not.toMatch(/"pw"/);
    // The login says who's asking.
    const login = requests.find((r) => r.url.pathname === '/Users/AuthenticateByName');
    expect(login.headers.Authorization).toMatch(/^MediaBrowser Client="Voicaw", Device="Voicaw: Film Club", DeviceId="voicaw-[0-9a-f]{16}"/);
    expect(login.headers['X-Emby-Authorization']).toBeUndefined();

    // Members see what it is (the layout), not the account.
    const layout = (await api.get(alice, `/guilds/${guild.id}`)).body;
    expect(layout.media_server).toEqual({ kind: 'jellyfin', name: 'Home Media', url: 'https://media.example' });

    const log = (await api.get(owner, `/guilds/${guild.id}/audit-log`)).body;
    expect(log.entries.find((e) => e.action === 'media_server_connect').details).toMatchObject({ kind: 'jellyfin', username: 'guild' });
  });

  it('refuses wrong logins, administrators, other servers and plain http', async () => {
    const { owner, settings } = await setUp();
    expect((await connect(owner, settings, { password: 'nope' })).body.error).toMatch(/Wrong username or password/);
    const admin = await connect(owner, settings, { username: 'admin' });
    expect(admin.body.error).toMatch(/administrator/);
    // …and its login was ended there.
    expect(server.loggedOut).toContain(`token-${server.tokens}`);
    expect((await connect(owner, settings, { url: 'http://media.example' })).status).toBe(400);
    expect((await connect(owner, settings, { url: 'https://elsewhere.example' })).status).toBe(502);
    expect((await connect(owner, settings, { kind: 'emby' })).body.error).toMatch(/Jellyfin server, not Emby/);
    expect((await connect(owner, settings, { kind: 'plex' })).status).toBe(400);
    expect((await api.get(owner, settings)).body.server).toBeNull();
  });

  it('talks to Emby under /emby', async () => {
    server.kind = 'emby';
    const { owner, settings } = await setUp();
    const res = await connect(owner, settings, { kind: 'emby', url: 'https://media.example/emby' });
    expect(res.status).toBe(200);
    expect(res.body.server.url).toBe('https://media.example');
    const login = requests.find((r) => r.url.pathname === '/emby/Users/AuthenticateByName');
    expect(login.headers['X-Emby-Authorization']).toMatch(/^Emby /);
  });

  it('disconnects, ending its login there', async () => {
    const { owner, guild, settings } = await setUp();
    await connect(owner, settings);
    const { token } = await db.get('SELECT token FROM guild_media_servers WHERE guild_id = ?', [guild.id]);
    expect((await api.delete(owner, settings)).status).toBe(200);
    expect(server.loggedOut).toContain(token);
    expect((await api.get(owner, settings)).body.server).toBeNull();
    expect((await api.delete(owner, settings)).status).toBe(404);
  });

  it('searches and queues its videos for people in the channel, giving them its addresses', async () => {
    const { owner, alice, lounge, base, settings } = await setUp();
    expect((await api.get(alice, `${base}/media-search?q=film`)).status).toBe(403);
    await enter(alice, lounge);
    expect((await api.get(alice, `${base}/media-search?q=film`)).status).toBe(404); // no server yet
    await connect(owner, settings);

    const found = (await api.get(alice, `${base}/media-search?q=film`)).body.results;
    expect(found[0]).toEqual({
      media_id: 'film1', type: 'Movie', title: 'A Film', series: null, season: null, episode: null, year: 2020, duration: 60,
      image_url: 'https://media.example/Items/film1/Images/Primary?maxHeight=180&quality=80&tag=tag1',
    });
    expect(found[1].type).toBe('Series');
    const search = requests.find((r) => r.url.pathname === '/Items');
    expect(search.url.searchParams.get('userId')).toBe('user-guild');
    // As the device it logged in as, with the token in Jellyfin's own header.
    const { device_id: deviceId, token } = await db.get('SELECT device_id, token FROM guild_media_servers ORDER BY connected_at DESC, guild_id DESC LIMIT 1');
    expect(search.headers.Authorization).toContain(`DeviceId="${deviceId}"`);
    expect(search.headers.Authorization).toContain(`Token="${token}"`);
    expect(search.url.searchParams.get('SearchTerm')).toBe('film');
    const episodes = (await api.get(alice, `${base}/media-episodes/show1`)).body.results;
    expect(episodes[0]).toMatchObject({ media_id: 'ep1', series: 'A Show', season: 1, episode: 1 });

    // A show isn't a video; something missing isn't found.
    expect((await api.post(alice, `${base}/queue`, { mediaId: 'show1' })).status).toBe(400);
    expect((await api.post(alice, `${base}/queue`, { mediaId: 'gone' })).status).toBe(404);
    expect((await api.post(alice, `${base}/queue`, { mediaId: '../x' })).status).toBe(400);

    const added = await api.post(alice, `${base}/queue`, { mediaId: 'film1' });
    expect(added.status).toBe(200);
    expect(added.body.party.current).toMatchObject({ source: 'media', media_id: 'film1', title: 'A Film', duration: 60, video_id: null });
    expect(JSON.stringify(added.body)).not.toMatch(/token-/);
    await api.post(alice, `${base}/queue`, { mediaId: 'ep1' });

    // The file straight from the server, with the token.
    const item = added.body.party.current.id;
    const stream = (await api.get(alice, `${base}/stream/${item}`)).body;
    expect(stream.type).toBe('file');
    const url = new URL(stream.url);
    expect(url.origin + url.pathname).toBe('https://media.example/Videos/film1/stream');
    expect(url.searchParams.get('static')).toBe('true');
    expect(url.searchParams.get('ApiKey')).toMatch(/^token-/);
    // Asked of the media server once, however many players ask.
    await api.get(alice, `${base}/stream/${item}`);
    expect(requests.filter((r) => r.url.pathname.endsWith('/PlaybackInfo'))).toHaveLength(1);
    // Only the video playing, only for people in the channel.
    expect((await api.get(alice, `${base}/stream/${item + 1}`)).status).toBe(409);
    expect((await api.get(owner, `${base}/stream/${item}`)).status).toBe(403);

    // The next one is transcoded: HLS, its token taken out and put back once.
    await api.post(alice, `${base}/skip`, { itemId: item });
    const hls = (await api.get(alice, `${base}/stream/${item + 1}`)).body;
    expect(hls.type).toBe('hls');
    expect(hls.url.match(/ApiKey=/g)).toHaveLength(1);
    expect(hls.url).toMatch(/^https:\/\/media\.example\/videos\/ep1\/master\.m3u8\?PlaySessionId=session-ep1&ApiKey=token-/);
    // Skipping it stops its transcode there.
    await api.post(alice, `${base}/skip`, { itemId: item + 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stop = requests.find((r) => r.url.pathname === '/Videos/ActiveEncodings');
    expect(stop.method).toBe('DELETE');
    expect(stop.url.searchParams.get('playSessionId')).toBe('session-ep1');
  });

  it('takes its videos out of the queues when the server is disconnected', async () => {
    const { owner, alice, lounge, base, settings } = await setUp();
    await enter(alice, lounge);
    await connect(owner, settings);
    await api.post(alice, `${base}/queue`, { mediaId: 'film1' });
    await api.post(alice, `${base}/queue`, { mediaId: 'ep1' });
    await api.delete(owner, settings);
    const { party, log } = (await api.get(alice, base)).body;
    expect(party).toBeNull();
    expect(log.at(-1)).toMatchObject({ action: 'ended', media_id: 'film1', user_id: null });
  });
});
