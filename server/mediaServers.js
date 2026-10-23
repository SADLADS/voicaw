const db = require('./db');
const { PERMISSIONS, has } = require('./permissions');
const { ActionError } = require('./actionError');
const { logAudit } = require('./auditLog');
const { safeFetch } = require('./safeFetch');

// Guild media servers (docs/voice-and-calls.md, Media servers): a guild's own Jellyfin or Emby
// server, for Watch Together (watchParty.js). Manage Guild connects one in Guild Settings →
// Watch Together with its address and an account's username and password; this API logs in
// once and keeps only the access token (guild_media_servers), never the password. Accounts that
// are the server's administrators are refused: people watching get the token (below).
//
// This API asks the server for searches, a show's episodes, an item's details and how to play
// it (PlaybackInfo, with a device profile of what every browser plays: H.264/AAC MP4 or WebM
// straight from the file, anything else transcoded by the media server to HLS), always through
// safeFetch, so only public addresses (any port), and only https:// (the web app can't load
// http:// media). The video itself never comes through here: people in the voice channel get
// its address with the token in it (`streamUrl`) and load it from the media server themselves,
// so it sees their IP address, and the token can be read off by them (what the account can
// see, they could browse). Pictures load from it too, without the token (Jellyfin and Emby
// don't ask for one). One transcode is shared by everyone watching (the same PlaySessionId),
// and stopped when its video stops being the one playing.
//
// Jellyfin and Emby are one API (Jellyfin is Emby's fork): Emby's lives under /emby and wants
// its own word in the authorisation header.

const KINDS = {
  jellyfin: { prefix: '', scheme: 'MediaBrowser', name: 'Jellyfin' },
  emby: { prefix: '/emby', scheme: 'Emby', name: 'Emby' },
};
const MAX_URL = 300;
const MAX_USERNAME = 100;
const MAX_PASSWORD = 1000;
const MEDIA_ID = /^[\w-]{1,64}$/;
// What can be watched: films, episodes, music videos and other videos (and shows, for their
// episodes).
const PLAYABLE = new Set(['Movie', 'Episode', 'Video', 'MusicVideo']);
const SEARCHED = [...PLAYABLE, 'Series'];
const MAX_RESULTS = 30;
const MAX_EPISODES = 500;
const MAX_BITRATE = 12_000_000;
const TICKS = 10_000_000; // the servers count time in 100 ns ticks

// What every browser plays as it is; anything else is transcoded to H.264/AAC in HLS.
const DEVICE_PROFILE = {
  MaxStreamingBitrate: MAX_BITRATE,
  MaxStaticBitrate: MAX_BITRATE,
  DirectPlayProfiles: [
    { Container: 'mp4,m4v', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac,mp3,opus,flac' },
    { Container: 'webm', Type: 'Video', VideoCodec: 'vp8,vp9,av1', AudioCodec: 'vorbis,opus' },
  ],
  TranscodingProfiles: [
    {
      Container: 'ts', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac', Protocol: 'hls',
      Context: 'Streaming', BreakOnNonKeyFrames: true, MaxAudioChannels: '2',
    },
  ],
  ContainerProfiles: [],
  CodecProfiles: [],
  SubtitleProfiles: [],
};

// The requests this API makes; replaceable by tests (they have no network).
const transport = { fetch: (href, options) => safeFetch(href, options) };

const allowPrivate = () => process.env.LINK_PREVIEWS_ALLOW_PRIVATE === '1';

// The server's address as typed (or its web app's, or Emby's API's) as its base: https, no
// path but one the server lives under, no query. Null if it isn't one.
function normalizeUrl(input, kind) {
  if (typeof input !== 'string' || !input.trim() || input.length > MAX_URL) return null;
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  // http:// only for tests and the e2e harness (as safeFetch's private addresses).
  if (url.protocol !== 'https:' && !(allowPrivate() && url.protocol === 'http:')) return null;
  if (url.username || url.password) return null;
  let path = url.pathname.replace(/\/+$/, '');
  path = path.replace(/\/web(\/index\.html)?$/i, '');
  if (kind === 'emby') path = path.replace(/\/emby$/i, '');
  return `${url.origin}${path}`;
}

const apiBase = (server) => `${server.url}${KINDS[server.kind].prefix}`;

// The authorisation header: who's asking (the guild), and the token once logged in.
function authHeader(kind, guildId, guildName, token = null) {
  const quote = (value) => String(value).replace(/["\\\r\n]/g, '');
  const parts = [
    `Client="Voicaw"`,
    `Device="${quote(`Voicaw: ${guildName}`).slice(0, 100)}"`,
    `DeviceId="voicaw-guild-${guildId}"`,
    'Version="1.0.0"',
    ...(token ? [`Token="${quote(token)}"`] : []),
  ];
  return `${KINDS[kind].scheme} ${parts.join(', ')}`;
}

const unreachable = (kind) => new ActionError(502, `The ${KINDS[kind].name} server couldn't be reached`);

// One request to the server's API: the JSON answer, or { status } for an error status. Throws
// ActionError when it can't be reached.
async function call(server, path, { method = 'GET', body = null, token = server.token, guildName = '', timeoutMs = 10000 } = {}) {
  const headers = {
    Accept: 'application/json',
    'X-Emby-Authorization': authHeader(server.kind, server.guild_id, guildName, token),
    ...(token && { 'X-Emby-Token': token }),
    ...(body && { 'Content-Type': 'application/json' }),
  };
  let res;
  try {
    res = await transport.fetch(`${apiBase(server)}${path}`, {
      method,
      body: body && JSON.stringify(body),
      headers,
      timeoutMs,
      maxBytes: 4 * 1024 * 1024,
      anyPort: true,
    });
  } catch {
    throw unreachable(server.kind);
  }
  if (res.status < 200 || res.status >= 300) return { status: res.status };
  if (!res.body?.length) return {};
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    throw unreachable(server.kind);
  }
}

const getServer = (guildId) => db.get('SELECT * FROM guild_media_servers WHERE guild_id = ?', [guildId]);

// What the guild's members see (the guild layout): { kind, name, url }, or null.
async function summaryOf(guildId) {
  const server = await getServer(guildId);
  return server ? { kind: server.kind, name: server.server_name || KINDS[server.kind].name, url: server.url } : null;
}

// What Guild Settings shows (Manage Guild): the summary and the account, never the token.
async function detailsOf(guildId) {
  const server = await getServer(guildId);
  if (!server) return null;
  return {
    kind: server.kind,
    name: server.server_name || KINDS[server.kind].name,
    url: server.url,
    username: server.username,
    connected_by: server.connected_by,
    connected_at: server.connected_at,
  };
}

// Ends a login there (best effort: the token is forgotten here either way).
async function logOut(server) {
  await call(server, '/Sessions/Logout', { method: 'POST' }).catch(() => {});
}

function requireManage(actor) {
  if (!has(actor.permissions, PERMISSIONS.MANAGE_GUILD)) throw new ActionError(403, "You don't have permission to do that");
}

// `actor` (a member context with Manage Guild) connects the guild to a Jellyfin or Emby server:
// { kind, url, username, password }. Replaces any server it had (whose videos leave the queues:
// the caller tells watchParty.js). Logged as media_server_connect. Throws ActionError.
async function connect(actor, { kind, url, username, password }) {
  requireManage(actor);
  if (!Object.hasOwn(KINDS, kind)) throw new ActionError(400, 'Choose Jellyfin or Emby');
  const base = normalizeUrl(url, kind);
  if (!base) throw new ActionError(400, 'Give the server\'s https:// address');
  if (typeof username !== 'string' || !username.trim() || username.length > MAX_USERNAME) throw new ActionError(400, 'Give the account\'s username');
  if (typeof (password ?? '') !== 'string' || (password ?? '').length > MAX_PASSWORD) throw new ActionError(400, 'Invalid password');
  const guildId = actor.guild.id;
  const { name: productName } = KINDS[kind];
  const server = { guild_id: guildId, kind, url: base, token: null };

  const info = await call(server, '/System/Info/Public', { guildName: actor.guild.name });
  if (info.status || !info.Id) throw new ActionError(400, `There's no ${productName} server at that address`);
  // Jellyfin says it's Jellyfin; Emby says nothing.
  const isJellyfin = /jellyfin/i.test(String(info.ProductName ?? ''));
  if (isJellyfin !== (kind === 'jellyfin')) {
    throw new ActionError(400, `That's a${isJellyfin ? ' Jellyfin' : 'n Emby'} server, not ${productName}`);
  }
  const login = await call(server, '/Users/AuthenticateByName', {
    method: 'POST',
    body: { Username: username.trim(), Pw: password ?? '' },
    guildName: actor.guild.name,
  });
  if (login.status === 401 || login.status === 403) throw new ActionError(400, 'Wrong username or password');
  if (login.status || !login.AccessToken || !login.User?.Id) throw unreachable(kind);
  const connected = { ...server, token: login.AccessToken };
  if (login.User.Policy?.IsAdministrator) {
    await logOut(connected);
    throw new ActionError(400, 'That account is an administrator of the server. Use an account made for the guild: everyone watching gets its access.');
  }

  const previous = await getServer(guildId);
  const serverName = String(info.ServerName ?? '').slice(0, 100);
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO guild_media_servers (guild_id, kind, url, server_name, username, remote_user_id, token, connected_by, connected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
       ON CONFLICT(guild_id) DO UPDATE SET kind = excluded.kind, url = excluded.url, server_name = excluded.server_name,
         username = excluded.username, remote_user_id = excluded.remote_user_id, token = excluded.token,
         connected_by = excluded.connected_by, connected_at = excluded.connected_at`,
      [guildId, kind, base, serverName, String(login.User.Name ?? username.trim()).slice(0, MAX_USERNAME), String(login.User.Id), login.AccessToken, actor.userId]
    );
    await logAudit({
      guildId, actorId: actor.userId, action: 'media_server_connect',
      details: { kind, name: serverName || productName, url: base, username: username.trim() },
    });
  });
  if (previous && previous.token !== login.AccessToken) await logOut(previous);
  return detailsOf(guildId);
}

// `actor` (Manage Guild) disconnects the guild's server. Logged as media_server_disconnect.
// Throws ActionError.
async function disconnect(actor) {
  requireManage(actor);
  const guildId = actor.guild.id;
  const server = await getServer(guildId);
  if (!server) throw new ActionError(404, 'No media server is connected');
  await db.transaction(async () => {
    await db.run('DELETE FROM guild_media_servers WHERE guild_id = ?', [guildId]);
    await logAudit({
      guildId, actorId: actor.userId, action: 'media_server_disconnect',
      details: { kind: server.kind, name: server.server_name || KINDS[server.kind].name },
    });
  });
  await logOut(server);
}

// The guild's server, or ActionError 404.
async function requireServer(guildId) {
  const server = await getServer(guildId);
  if (!server) throw new ActionError(404, 'This guild has no media server');
  return server;
}

// A server's answer that should have worked: a 401 means the account's login was ended there.
function check(server, answer) {
  if (answer.status === 401) throw new ActionError(502, `The ${KINDS[server.kind].name} server no longer accepts this guild's login: connect it again in Guild Settings`);
  if (answer.status === 404 || answer.status === 400) throw new ActionError(404, 'Not found on the media server');
  if (answer.status) throw unreachable(server.kind);
  return answer;
}

// An item as results and queues show it: { media_id, type, title, series, season, episode,
// year, duration (seconds; null: not known), image_url (null: none) }.
function itemOf(server, item) {
  const imageTag = item.ImageTags?.Primary;
  return {
    media_id: String(item.Id),
    type: String(item.Type ?? ''),
    title: String(item.Name ?? '').slice(0, 200) || null,
    series: item.SeriesName ? String(item.SeriesName).slice(0, 200) : null,
    season: Number.isInteger(item.ParentIndexNumber) ? item.ParentIndexNumber : null,
    episode: Number.isInteger(item.IndexNumber) ? item.IndexNumber : null,
    year: Number.isInteger(item.ProductionYear) ? item.ProductionYear : null,
    duration: item.RunTimeTicks > 0 ? Math.round(item.RunTimeTicks / TICKS) : null,
    image_url: imageTag
      ? `${apiBase(server)}/Items/${encodeURIComponent(item.Id)}/Images/Primary?maxHeight=180&quality=80&tag=${encodeURIComponent(imageTag)}`
      : null,
  };
}

const FIELDS = 'ProductionYear,SeriesName,ParentIndexNumber,IndexNumber,RunTimeTicks';

// What the account can see matching `query`: videos and shows (a show's episodes come from
// `episodes`), at most MAX_RESULTS.
async function search(guildId, query) {
  const server = await requireServer(guildId);
  const params = new URLSearchParams({
    userId: server.remote_user_id,
    Recursive: 'true',
    SearchTerm: query,
    IncludeItemTypes: SEARCHED.join(','),
    Fields: FIELDS,
    Limit: String(MAX_RESULTS),
    EnableTotalRecordCount: 'false',
  });
  const answer = check(server, await call(server, `/Items?${params}`));
  return (answer.Items ?? []).slice(0, MAX_RESULTS).map((item) => itemOf(server, item));
}

// A show's episodes, in order.
async function episodes(guildId, seriesId) {
  if (typeof seriesId !== 'string' || !MEDIA_ID.test(seriesId)) throw new ActionError(400, 'Not a show');
  const server = await requireServer(guildId);
  const params = new URLSearchParams({ userId: server.remote_user_id, Fields: FIELDS });
  const answer = check(server, await call(server, `/Shows/${encodeURIComponent(seriesId)}/Episodes?${params}`));
  return (answer.Items ?? []).slice(0, MAX_EPISODES).map((item) => itemOf(server, item));
}

// A video the account can see, to add to a queue (itemOf); ActionError if it isn't one.
async function videoInfo(guildId, mediaId) {
  if (typeof mediaId !== 'string' || !MEDIA_ID.test(mediaId)) throw new ActionError(400, 'Not a video on the media server');
  const server = await requireServer(guildId);
  const item = check(server, await call(server, `/Users/${encodeURIComponent(server.remote_user_id)}/Items/${encodeURIComponent(mediaId)}`));
  if (!PLAYABLE.has(item.Type)) throw new ActionError(400, 'That isn\'t a video');
  return itemOf(server, item);
}

// The address's path without its token: the servers put it in the addresses they give.
function withoutToken(path) {
  const url = new URL(path, 'http://x');
  for (const key of [...url.searchParams.keys()]) {
    if (/^api_?key$/i.test(key)) url.searchParams.delete(key);
  }
  return `${url.pathname}${url.search}`;
}

// How a video plays: { type: 'file' | 'hls', path (under the API, no token), playSessionId }.
async function playbackOf(guildId, mediaId) {
  const server = await requireServer(guildId);
  const params = new URLSearchParams({ UserId: server.remote_user_id, AutoOpenLiveStream: 'false', MaxStreamingBitrate: String(MAX_BITRATE) });
  const answer = check(server, await call(server, `/Items/${encodeURIComponent(mediaId)}/PlaybackInfo?${params}`, {
    method: 'POST',
    body: { DeviceProfile: DEVICE_PROFILE },
  }));
  const source = answer.MediaSources?.[0];
  const playSessionId = String(answer.PlaySessionId ?? '');
  // `token` marks which login it came from (a reconnected server's addresses are no good).
  if (source?.SupportsDirectPlay) {
    // Emby gives the file's address; Jellyfin's is made from the item.
    const path = source.DirectStreamUrl
      ? withoutToken(source.DirectStreamUrl)
      : `/Videos/${encodeURIComponent(mediaId)}/stream?${new URLSearchParams({
        static: 'true', MediaSourceId: String(source.Id ?? mediaId), PlaySessionId: playSessionId, DeviceId: `voicaw-guild-${guildId}`,
      })}`;
    return { type: 'file', path, playSessionId, token: server.token };
  }
  if (!source?.TranscodingUrl) throw new ActionError(400, 'The media server can\'t play that');
  return { type: 'hls', path: withoutToken(source.TranscodingUrl), playSessionId, token: server.token };
}

// The full address someone in the voice channel loads `playback` from (with the token), or
// null when the guild's server changed since.
async function streamUrl(guildId, playback) {
  const server = await getServer(guildId);
  if (!server || server.token !== playback.token) return null;
  const separator = playback.path.includes('?') ? '&' : '?';
  return `${apiBase(server)}${playback.path}${separator}api_key=${encodeURIComponent(server.token)}`;
}

// The transcode for `playback` is no longer wanted (best effort; the server ends idle ones
// itself too).
async function stopPlayback(guildId, playback) {
  if (playback?.type !== 'hls') return;
  const server = await getServer(guildId);
  if (!server || server.token !== playback.token) return;
  const params = new URLSearchParams({ deviceId: `voicaw-guild-${guildId}`, playSessionId: playback.playSessionId });
  await call(server, `/Videos/ActiveEncodings?${params}`, { method: 'DELETE' }).catch(() => {});
}

module.exports = {
  KINDS,
  MEDIA_ID,
  transport,
  normalizeUrl,
  summaryOf,
  detailsOf,
  connect,
  disconnect,
  search,
  episodes,
  videoInfo,
  playbackOf,
  streamUrl,
  stopPlayback,
};
