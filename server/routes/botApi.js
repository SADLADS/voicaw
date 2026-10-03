const express = require('express');
const db = require('../db');
const config = require('../config');
const { PERMISSIONS, CHANNEL_PERMISSIONS, has } = require('../permissions');
const {
  getMember, getChannelAccess, getGuildLayout, getOverrides, getChannelViewers, removeMember,
} = require('../guilds');
const { sendToUserSockets, getStatus } = require('../sockets');
const { createLimiter } = require('../rateLimit');
const { ActionError } = require('../actionError');
const threads = require('../threads');
const bots = require('../bots');
const D = require('../discord');
const messages = require('./guildMessages');
const guildActions = require('./guilds');
const roleActions = require('./guildRoles');
const threadActions = require('./threads');
const webhooks = require('./webhooks');
const botMessages = require('../botMessages');
const commands = require('../commands');
const interactions = require('../interactions');

// The bot API: Discord's REST API (https://discord.com/developers/docs/reference), for bots made
// in the developer portal (bots.js, docs/bots.md), at /api/v10 (and /api/v9), so Discord's
// libraries work by changing their base URL. Requests carry `Authorization: Bot <token>`. Ids,
// permissions and objects are Discord's shapes (discord.js); errors are Discord's
// ({ message, code, errors? }). Every action goes through the same functions as the app's own
// routes, with the bot as the member doing it, so a bot can do exactly what its roles allow.
// Bots are only in guilds: no DMs (they're end-to-end encrypted). Commands and interactions
// (buttons, selects, forms) are here too (commands.js, interactions.js). Not here (yet):
// voice, webhooks by bot token, nicknames, timeouts,
// stickers, scheduled events, guild creation.
const router = express.Router();
const fail = webhooks.fail;

// JSON bodies (index.js leaves /api/v<n>/ paths to us, so bad JSON gets Discord's error below);
// webhooks (also under /api/v<n>/) parse their own.
const json = express.json({ limit: '1mb' });
router.use((req, res, next) => (/^\/webhooks(\/|$)/.test(req.path) ? next() : json(req, res, next)));

// JSON answers say `application/json` and nothing more, as Discord's do: discord.py only reads a
// body as JSON when the type is exactly that (Express would add "; charset=utf-8"). Webhooks'
// answers under /api/v<n>/ too.
router.use((req, res, next) => {
  res.json = (body) => {
    const data = Buffer.from(JSON.stringify(body));
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Length', String(data.length));
    res.end(data);
    return res;
  };
  next();
});

const now = () => Math.floor(Date.now() / 1000);
const API_VERSION = 10;

// ---- Auth and rate limits ----

// Per bot: 50 requests a second overall, and each route ("bucket") its own limit per channel or
// guild, with Discord's X-RateLimit-* headers so libraries pace themselves.
const globalLimiter = createLimiter({ windowMs: 1000, max: 50 });
const buckets = new Map();
function bucketLimiter(name, max, windowMs) {
  if (!buckets.has(name)) buckets.set(name, { limiter: createLimiter({ windowMs, max }), max });
  return buckets.get(name);
}

function rateLimited(res, retryAfterMs, global) {
  const seconds = retryAfterMs / 1000;
  res.set({ 'Retry-After': String(Math.ceil(seconds)), 'X-RateLimit-Scope': global ? 'global' : 'user' });
  if (global) res.set('X-RateLimit-Global', 'true');
  return res.status(429).json({ message: 'You are being rate limited.', retry_after: seconds, global, code: 0 });
}

async function botAuth(req, res, next) {
  const header = req.get('authorization') ?? '';
  if (!/^Bot\s+/i.test(header)) return fail(res, 401, 0, '401: Unauthorized');
  const bot = await bots.botForToken(header);
  if (!bot) return fail(res, 401, 0, '401: Unauthorized');
  if (config.rateLimitsEnabled) {
    const { allowed, retryAfterMs } = globalLimiter.hit(`bot:${bot.id}`);
    if (!allowed) return rateLimited(res, retryAfterMs, true);
  }
  req.bot = bot;
  next();
}

// A route's limit: `max` per `windowMs` per bot and per its channel or guild. Routes used with an
// interaction's token instead of the bot's (callbacks, follow-ups) count per application.
const limit = (name, max = 10, windowMs = 1000) => (req, res, next) => {
  if (!config.rateLimitsEnabled) return next();
  const major = req.params.channelId ?? req.params.guildId ?? '';
  const who = req.bot?.id ?? req.interaction?.application_id ?? `interaction:${req.params.interactionId ?? req.params.appId}`;
  const bucket = bucketLimiter(name, max, windowMs);
  const { allowed, retryAfterMs, remaining } = bucket.limiter.hit(`${who}:${major}`);
  res.set({
    'X-RateLimit-Limit': String(bucket.max),
    'X-RateLimit-Remaining': String(remaining),
    'X-RateLimit-Reset': ((Date.now() + retryAfterMs) / 1000).toFixed(3),
    'X-RateLimit-Reset-After': (retryAfterMs / 1000).toFixed(3),
    'X-RateLimit-Bucket': `${name}`,
  });
  if (!allowed) return rateLimited(res, retryAfterMs, false);
  next();
};

const auth = [botAuth];

// Runs a handler, answering refused actions, bad bodies and big uploads Discord's way.
const route = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    if (err instanceof ActionError) return fail(res, err.status, err.code, err.message);
    if (err instanceof webhooks.FormError) return webhooks.failForm(res, err);
    if (err.tooLarge) return fail(res, 413, 40005, 'Request entity too large');
    throw err;
  }
};

const missingPermissions = () => new ActionError(403, 'Missing Permissions', 50013);
const requirePermission = (permissions, bit) => {
  if (!has(permissions, bit)) throw missingPermissions();
};

// ---- Loading what the URL names ----

// req.member: the bot as a member of :guildId.
async function inGuild(req, res, next) {
  const guildId = D.ourId(req.params.guildId);
  const member = guildId != null && await getMember(guildId, req.bot.id);
  if (!member) return fail(res, 404, 10004, 'Unknown Guild');
  req.member = member;
  next();
}

// req.access ({ channel, member, permissions }) for :channelId, a text or voice channel or a
// thread the bot can see; or req.category for a category id.
async function inChannel(req, res, next) {
  if (D.isCategoryId(req.params.channelId)) {
    const category = await db.get('SELECT * FROM guild_categories WHERE id = ?', [D.ourId(req.params.channelId, 'category')]);
    const member = category && await getMember(category.guild_id, req.bot.id);
    if (!member) return fail(res, 404, 10003, 'Unknown Channel');
    req.category = category;
    req.member = member;
    return next();
  }
  const id = D.ourId(req.params.channelId);
  const access = id != null && await getChannelAccess(id, req.bot.id);
  if (!access || !D.isBotChannel(access.channel) || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) {
    return fail(res, 404, 10003, 'Unknown Channel');
  }
  req.access = access;
  req.member = access.member;
  next();
}

// As inChannel, but only text channels and threads (messages).
async function inTextChannel(req, res, next) {
  await inChannel(req, res, () => {
    if (!req.access || req.access.channel.type === 'voice') return fail(res, 400, 50024, 'Cannot execute action on this channel type');
    next();
  });
}

// req.message: :messageId in req.access's channel (the row the app's actions take).
async function inMessage(req, res, next) {
  const id = D.ourId(req.params.messageId);
  const message = id != null && await db.get(
    'SELECT id, channel_id, sender_id, content, timestamp, system, webhook_id, webhook_name, embeds, attachments, components, flags FROM guild_messages WHERE id = ? AND channel_id = ?',
    [id, req.access.channel.id]
  );
  if (!message) return fail(res, 404, 10008, 'Unknown Message');
  req.message = message;
  next();
}

// ---- Turning rows into Discord objects ----

async function everyoneRoleId(guildId) {
  return (await db.get('SELECT id FROM guild_roles WHERE guild_id = ? AND is_everyone = 1', [guildId]))?.id;
}

async function lastMessageId(channelId) {
  return (await db.get('SELECT MAX(id) AS id FROM guild_messages WHERE channel_id = ?', [channelId]))?.id ?? null;
}

// A channel (guild_channels row, or a thread) as Discord's.
async function channelOf(channel) {
  if (channel.type === 'thread') {
    const thread = await threads.getThread(channel.id);
    const members = await threads.memberIds(channel.id);
    return D.channelObject({ ...channel, ...thread, member_count: members.length }, { lastMessageId: await lastMessageId(channel.id) });
  }
  const row = await db.get('SELECT * FROM guild_channels WHERE id = ?', [channel.id]);
  const overrides = (await getOverrides({ channelIds: [channel.id] })).get(channel.id) ?? [];
  return D.channelObject(row, {
    everyoneRoleId: await everyoneRoleId(row.guild_id),
    overrides,
    lastMessageId: row.type === 'voice' ? null : await lastMessageId(row.id),
  });
}

// Messages (MESSAGE_SELECT rows) as Discord's, for this bot.
async function messageObjects(req, rows) {
  return D.messageObjects(await messages.withReactions(rows), { botId: req.bot.id });
}

async function loadMessage(req, id) {
  const row = await db.get(`${messages.MESSAGE_SELECT} WHERE m.id = ?`, [id]);
  return row ? (await messageObjects(req, [row]))[0] : null;
}

async function userRow(id) {
  return db.get(`SELECT ${D.USER_COLUMNS} FROM users u WHERE u.id = ?`, [id]);
}

// Whether the bot shares a guild with `userId` (bots only see people through their guilds).
async function sharesGuild(botId, userId) {
  return Boolean(await db.get(
    'SELECT 1 FROM guild_members a JOIN guild_members b ON a.guild_id = b.guild_id WHERE a.user_id = ? AND b.user_id = ?',
    [botId, userId]
  ));
}

function gatewayUrl(req) {
  const host = req.get('host') ?? '';
  const secure = req.get('x-forwarded-proto') === 'https' || !/^(localhost|127\.|\[::1\])/.test(host);
  return `${secure ? 'wss' : 'ws'}://${host}/api/gateway`;
}

async function applicationObject(app) {
  const owner = await userRow(app.owner_id);
  const bot = await userRow(app.id);
  const { count } = await db.get('SELECT COUNT(*) AS count FROM guild_members WHERE user_id = ?', [app.id]);
  return {
    id: String(app.id),
    name: app.name,
    icon: bot.avatar ?? null,
    description: app.description ?? '',
    summary: '',
    type: null,
    bot_public: Boolean(app.public),
    bot_require_code_grant: false,
    verify_key: '',
    flags: 0,
    team: null,
    owner: D.userObject(owner),
    bot: D.userObject(bot),
    approximate_guild_count: count,
    install_params: { scopes: ['bot'], permissions: '0' },
    redirect_uris: [],
    tags: [],
  };
}

// ---- Gateway, users, applications ----

router.get('/gateway', (req, res) => res.json({ url: gatewayUrl(req) }));

router.get('/gateway/bot', auth, (req, res) => {
  res.json({
    url: gatewayUrl(req),
    shards: 1,
    session_start_limit: { total: 1000, remaining: 1000, reset_after: 86400000, max_concurrency: 1 },
  });
});

router.get('/users/@me', auth, route(async (req, res) => {
  res.json({ ...D.userObject(await userRow(req.bot.id)), verified: true, mfa_enabled: false, email: null, locale: 'en-GB' });
}));

// `username` (the application's name) and `avatar` (image data, or null).
// Name changes are limited to 2 an hour, as in Discord; pictures aren't.
const usernameLimit = limit('username', 2, 60 * 60 * 1000);
router.patch('/users/@me', auth, webhooks.parseBody, (req, res, next) => (req.body?.username !== undefined ? usernameLimit(req, res, next) : next()), route(async (req, res) => {
  const body = req.body ?? {};
  if (body.username !== undefined) {
    const error = await bots.updateApplication(req.bot.application, { name: body.username });
    if (error) throw new webhooks.FormError(['username'], error, 'BASE_TYPE_BAD_LENGTH');
  }
  if (body.avatar !== undefined) {
    const { setAvatarFrom, removeAvatar } = require('../avatars');
    if (body.avatar === null) {
      await removeAvatar(req.bot.id);
    } else {
      const match = typeof body.avatar === 'string' && body.avatar.match(/^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i);
      if (!match) throw new webhooks.FormError(['avatar'], 'Invalid image data', 'IMAGE_INVALID');
      try {
        await setAvatarFrom(req.bot.id, Buffer.from(match[1], 'base64'));
      } catch (err) {
        if (err.name === 'AvatarImageError') throw new webhooks.FormError(['avatar'], err.message, 'IMAGE_INVALID');
        throw err;
      }
    }
    await bots.announceProfile(req.bot.id);
  }
  res.json(D.userObject(await userRow(req.bot.id)));
}));

router.get('/users/@me/guilds', auth, route(async (req, res) => {
  const max = Math.min(Math.max(Number(req.query.limit) || 200, 1), 200);
  const after = D.ourId(req.query.after) ?? 0;
  const rows = await db.all(
    `SELECT g.id, g.name, g.owner, g.icon_version FROM guilds g JOIN guild_members gm ON gm.guild_id = g.id
     WHERE gm.user_id = ? AND g.id > ? ORDER BY g.id LIMIT ?`,
    [req.bot.id, after, max]
  );
  const result = [];
  for (const guild of rows) {
    const member = await getMember(guild.id, req.bot.id);
    result.push({
      id: String(guild.id),
      name: guild.name,
      icon: guild.icon_version > 0 ? `v${guild.icon_version}` : null,
      banner: null,
      owner: false,
      permissions: D.toDiscordPermissions(member.permissions),
      features: [],
    });
  }
  res.json(result);
}));

router.delete('/users/@me/guilds/:guildId', auth, inGuild, route(async (req, res) => {
  await removeMember(req.member.guild.id, req.bot.id);
  res.status(204).end();
}));

// Anyone the bot shares a guild with (or itself).
router.get('/users/:userId', auth, route(async (req, res) => {
  const id = D.ourId(req.params.userId);
  const user = id != null && await userRow(id);
  if (!user || (id !== req.bot.id && !(await sharesGuild(req.bot.id, id)))) return fail(res, 404, 10013, 'Unknown User');
  res.json(D.userObject(user));
}));

// DMs are end-to-end encrypted: bots can't have any.
router.post('/users/@me/channels', auth, (req, res) => {
  fail(res, 403, 50007, 'Cannot send messages to this user: bots can only be in guilds on Voicaw (direct messages are end-to-end encrypted)');
});

router.get(['/applications/@me', '/oauth2/applications/@me'], auth, route(async (req, res) => {
  res.json(await applicationObject(req.bot.application));
}));

// ---- Application commands (commands.js) ----

// The bot's own application, and for guild commands a guild it's in: req.commandGuildId (0 for
// its commands everywhere).
async function ownCommands(req, res, next) {
  if (req.params.appId !== String(req.bot.id)) return fail(res, 403, 50001, 'Missing Access');
  req.commandGuildId = 0;
  if (req.params.guildId !== undefined) {
    const guildId = D.ourId(req.params.guildId);
    if (guildId == null || !(await getMember(guildId, req.bot.id))) return fail(res, 403, 50001, 'Missing Access');
    req.commandGuildId = guildId;
  }
  next();
}

const COMMANDS = ['/applications/:appId/commands', '/applications/:appId/guilds/:guildId/commands'];
const COMMAND = COMMANDS.map((p) => `${p}/:commandId`);
const commandBucket = limit('commands', 10, 20000);

async function commandOr404(req) {
  const row = await commands.getCommand(req.bot.id, req.commandGuildId, D.ourId(req.params.commandId) ?? -1);
  if (!row) throw new ActionError(404, 'Unknown application command', 10063);
  return row;
}

router.get(COMMANDS, auth, ownCommands, route(async (req, res) => {
  res.json((await commands.listCommands(req.bot.id, req.commandGuildId)).map(commands.commandObject));
}));

// Discord's create: replaces the command with the same type and name if there is one (200), else 201.
router.post(COMMANDS, auth, commandBucket, ownCommands, route(async (req, res) => {
  const { row, created } = await commands.saveCommand(req.bot.id, req.commandGuildId, commands.cleanCommand(req.body));
  res.status(created ? 201 : 200).json(commands.commandObject(row));
}));

// Bulk overwrite: the commands become exactly these (discord.js's commands.set()).
router.put(COMMANDS, auth, commandBucket, ownCommands, route(async (req, res) => {
  const rows = await commands.overwriteCommands(req.bot.id, req.commandGuildId, req.body);
  res.json(rows.map(commands.commandObject));
}));

// Per-command permission overrides (a guild's Integrations settings in Discord) aren't in
// Voicaw: none are listed. (Before /:commandId, which would take "permissions".)
router.get('/applications/:appId/guilds/:guildId/commands/permissions', auth, ownCommands, (req, res) => res.json([]));

router.get(COMMAND, auth, ownCommands, route(async (req, res) => {
  res.json(commands.commandObject(await commandOr404(req)));
}));

router.patch(COMMAND, auth, commandBucket, ownCommands, route(async (req, res) => {
  const row = await commandOr404(req);
  const base = commands.commandObject(row);
  const cleaned = commands.cleanCommand(req.body, { ...base, default_member_permissions: base.default_member_permissions });
  res.json(commands.commandObject(await commands.updateCommand(row, cleaned)));
}));

router.delete(COMMAND, auth, commandBucket, ownCommands, route(async (req, res) => {
  await commands.deleteCommand(await commandOr404(req));
  res.status(204).end();
}));


// ---- Interactions (interactions.js) ----

// The bot's answer to an interaction, with its token (no bot token, as in Discord), within 3
// seconds. `?with_response=true` answers with what it made.
router.post('/interactions/:interactionId/:token/callback', limit('callback', 20, 1000), webhooks.parseBody, route(async (req, res) => {
  const row = await interactions.findInteraction(req.params.interactionId, req.params.token);
  if (!row || row.expired) return fail(res, 404, 10062, 'Unknown interaction');
  const result = await interactions.callback(row, req);
  if (!['true', '1'].includes(String(req.query.with_response).toLowerCase())) return res.status(204).end();
  const message = result.message ? await D.messageObjects([result.message], { botId: row.application_id }) : [];
  res.json({
    interaction: {
      id: String(row.id),
      type: row.type,
      activity_instance_id: null,
      response_message_id: result.message ? String(result.message.id) : null,
      response_message_loading: Boolean(result.message && result.message.flags & (1 << 7)),
      response_message_ephemeral: Boolean(result.message?.ephemeral),
    },
    resource: { type: Number(row.response_type), ...(message[0] ? { message: message[0] } : {}) },
  });
}));

// Follow-ups and the reply, on the interaction's webhook (/webhooks/<app id>/<interaction
// token>), for 15 minutes. Anything else on /webhooks/ is a real webhook (routes/webhooks.js).
async function byInteractionToken(req, res, next) {
  if (!String(req.params.token).startsWith(interactions.TOKEN_PREFIX)) return next('route');
  const row = await interactions.interactionByToken(D.ourId(req.params.appId) ?? -1, req.params.token);
  if (!row) return fail(res, 404, 10015, 'Unknown Webhook');
  if (row.expired) return fail(res, 401, 50027, 'Invalid Webhook Token');
  req.interaction = row;
  next();
}

const INTERACTION_HOOK = '/webhooks/:appId/:token';

// A follow-up (needs the interaction answered first). After a "thinking…" reply, the first
// follow-up becomes that reply, as in Discord.
router.post(INTERACTION_HOOK, byInteractionToken, limit('followup', 5, 2000), webhooks.parseBody, route(async (req, res) => {
  const row = req.interaction;
  if (row.response_type == null) return fail(res, 404, 10015, 'Unknown Webhook');
  const original = row.response_message_id && await interactions.interactionMessage(row, '@original').catch(() => null);
  const loading = original && (original.ephemeral ? original.ephemeral.message.flags & (1 << 7) : (await db.get('SELECT flags FROM guild_messages WHERE id = ?', [original.id]))?.flags & (1 << 7));
  const message = loading
    ? await interactions.editInteractionMessage(row, '@original', req)
    : await interactions.postMessage(row, await readBody(() => botMessages.readNewMessage(req, { allowEphemeral: true })), { followup: true });
  res.json((await D.messageObjects([message], { botId: row.application_id }))[0]);
}));

router.get(`${INTERACTION_HOOK}/messages/:messageId`, byInteractionToken, route(async (req, res) => {
  const found = await interactions.interactionMessage(req.interaction, req.params.messageId);
  res.json(await interactions.messageForBot(req.interaction, found));
}));

router.patch(`${INTERACTION_HOOK}/messages/:messageId`, byInteractionToken, limit('followup-edit', 5, 2000), webhooks.parseBody, route(async (req, res) => {
  const message = await interactions.editInteractionMessage(req.interaction, req.params.messageId, req);
  res.json((await D.messageObjects([message], { botId: req.interaction.application_id }))[0]);
}));

router.delete(`${INTERACTION_HOOK}/messages/:messageId`, byInteractionToken, route(async (req, res) => {
  await interactions.deleteInteractionMessage(req.interaction, req.params.messageId);
  res.status(204).end();
}));

// ---- Guilds ----

async function guildObject(guildId, { counts = false } = {}) {
  const guild = await db.get('SELECT id, name, owner, icon_version, created_at FROM guilds WHERE id = ?', [guildId]);
  const roles = await db.all('SELECT * FROM guild_roles WHERE guild_id = ? ORDER BY position, id', [guildId]);
  const emojis = await db.all('SELECT id, name, animated, available FROM guild_emojis WHERE guild_id = ? AND available = 1 ORDER BY id', [guildId]);
  const object = D.guildObject(guild, { roles, emojis });
  if (counts) {
    const memberIds = (await db.all('SELECT user_id FROM guild_members WHERE guild_id = ?', [guildId])).map((r) => r.user_id);
    object.approximate_member_count = memberIds.length;
    object.approximate_presence_count = memberIds.filter((id) => getStatus(id) !== 'offline').length;
  }
  return object;
}

router.get('/guilds/:guildId', auth, inGuild, route(async (req, res) => {
  res.json(await guildObject(req.member.guild.id, { counts: ['true', '1'].includes(String(req.query.with_counts)) }));
}));

// The guild's channels the bot can see, and their categories.
async function guildChannels(guildId, botId) {
  const layout = await getGuildLayout(guildId, botId);
  const overrides = await getOverrides({ guildId });
  const everyone = await everyoneRoleId(guildId);
  const rows = await db.all("SELECT * FROM guild_channels WHERE guild_id = ? AND type IN ('text', 'voice')", [guildId]);
  const visible = new Set(layout.channels.map((c) => c.id));
  const channels = [];
  for (const row of rows) {
    if (!visible.has(row.id)) continue;
    channels.push(D.channelObject(row, {
      everyoneRoleId: everyone,
      overrides: overrides.get(row.id) ?? [],
      lastMessageId: row.type === 'voice' ? null : await lastMessageId(row.id),
    }));
  }
  return [...layout.categories.map((c) => D.categoryObject(c, guildId)), ...channels];
}

router.get('/guilds/:guildId/channels', auth, inGuild, route(async (req, res) => {
  res.json(await guildChannels(req.member.guild.id, req.bot.id));
}));

// Text (0) or voice (2) channels; `parent_id` a category; `permission_overwrites` set after.
router.post('/guilds/:guildId/channels', auth, limit('channel-create', 5, 5000), inGuild, route(async (req, res) => {
  const body = req.body ?? {};
  const type = { 0: 'text', 2: 'voice' }[body.type ?? 0];
  if (!type) throw new webhooks.FormError(['type'], 'Only text (0) and voice (2) channels can be made on Voicaw.', 'BASE_TYPE_CHOICES');
  const categoryId = body.parent_id != null ? D.ourId(body.parent_id, 'category') : null;
  if (body.parent_id != null && categoryId == null) throw new webhooks.FormError(['parent_id'], 'Unknown category.', 'CHANNEL_PARENT_INVALID');
  const id = await guildActions.createChannel(req.member, {
    name: body.name, type, topic: body.topic ?? null, categoryId, nsfw: Boolean(body.nsfw),
  });
  await applyOverwrites(req, id, body.permission_overwrites);
  const channel = await db.get('SELECT * FROM guild_channels WHERE id = ?', [id]);
  res.status(201).json(await channelOf(channel));
}));

// Discord's permission_overwrites ([{ id, type: 0 role / 1 member, allow, deny }]) on channel `channelId`.
async function applyOverwrites(req, channelId, overwrites) {
  if (!Array.isArray(overwrites)) return;
  for (const o of overwrites) await setOverwrite(req, channelId, o.id, o);
}

async function setOverwrite(req, channelId, targetId, { type, allow = '0', deny = '0' }) {
  const access = await getChannelAccess(channelId, req.bot.id);
  const guildId = access.channel.guild_id;
  const isRole = Number(type) === 0 || type === 'role';
  const target = isRole ? await D.roleIdFromDiscord(guildId, targetId) : D.ourId(targetId);
  if (target == null) throw new ActionError(404, isRole ? 'Unknown Role' : 'Unknown Member', isRole ? 10011 : 10007);
  let bits;
  try {
    bits = { allow: D.fromDiscordPermissions(allow ?? '0') & CHANNEL_PERMISSIONS, deny: D.fromDiscordPermissions(deny ?? '0') & CHANNEL_PERMISSIONS };
  } catch {
    throw new webhooks.FormError(['allow'], 'Invalid permissions.', 'BASE_TYPE_INVALID');
  }
  await roleActions.setOverride(access.member, access.channel, access.permissions, isRole ? 'role' : 'member', target, bits);
}

router.get('/guilds/:guildId/roles', auth, inGuild, route(async (req, res) => {
  res.json(req.member.allRoles.slice().reverse().map((r) => D.roleObject(r, req.member.guild.id)));
}));

router.get('/guilds/:guildId/roles/:roleId', auth, inGuild, route(async (req, res) => {
  const roleId = await D.roleIdFromDiscord(req.member.guild.id, req.params.roleId);
  const role = req.member.allRoles.find((r) => r.id === roleId);
  if (!role) return fail(res, 404, 10011, 'Unknown Role');
  res.json(D.roleObject(role, req.member.guild.id));
}));

// Discord's role fields as the app's.
function roleBody(body) {
  const out = {};
  if (body.name !== undefined) out.name = body.name;
  if (body.color !== undefined) out.color = body.color || null;
  if (body.colors?.primary_color !== undefined) out.color = body.colors.primary_color || null;
  if (body.hoist !== undefined) out.hoist = Boolean(body.hoist);
  if (body.mentionable !== undefined) out.mentionable = Boolean(body.mentionable);
  if (body.permissions !== undefined && body.permissions !== null) {
    try {
      out.permissions = D.fromDiscordPermissions(body.permissions);
    } catch {
      throw new webhooks.FormError(['permissions'], 'Invalid permissions.', 'BASE_TYPE_INVALID');
    }
  }
  return out;
}

router.post('/guilds/:guildId/roles', auth, limit('role-create', 5, 5000), inGuild, route(async (req, res) => {
  const role = await roleActions.createRole(req.member, roleBody(req.body ?? {}));
  res.json(D.roleObject(role, req.member.guild.id));
}));

// New positions for some roles ([{ id, position }]); the rest keep their order around them.
// Answers with every role.
router.patch('/guilds/:guildId/roles', auth, limit('role-order', 5, 5000), inGuild, route(async (req, res) => {
  const guildId = req.member.guild.id;
  if (!Array.isArray(req.body)) throw new webhooks.FormError(['_'], 'Must be an array.', 'BASE_TYPE_ARRAY');
  const roles = req.member.allRoles.filter((r) => !r.is_everyone).map((r) => ({ id: r.id, position: r.position }));
  for (const { id, position } of req.body) {
    if (String(id) === String(guildId)) continue; // @everyone stays at the bottom
    const roleId = await D.roleIdFromDiscord(guildId, id);
    const role = roles.find((r) => r.id === roleId);
    if (!role) throw new ActionError(404, 'Unknown Role', 10011);
    if (!Number.isInteger(position) || position < 1) throw new webhooks.FormError(['position'], 'Invalid position.', 'NUMBER_TYPE_MIN');
    role.position = position + 0.5; // ahead of a role already at that position (it moved there)
  }
  roles.sort((a, b) => b.position - a.position);
  await roleActions.reorderRoles(req.member, roles.map((r) => r.id));
  const fresh = await require('../guilds').getRoles(guildId);
  res.json(fresh.slice().reverse().map((r) => D.roleObject(r, guildId)));
}));

router.patch('/guilds/:guildId/roles/:roleId', auth, limit('role-update', 5, 5000), inGuild, route(async (req, res) => {
  const roleId = await D.roleIdFromDiscord(req.member.guild.id, req.params.roleId);
  if (roleId == null) return fail(res, 404, 10011, 'Unknown Role');
  const role = await roleActions.updateRole(req.member, roleId, roleBody(req.body ?? {}));
  res.json(D.roleObject(role, req.member.guild.id));
}));

router.delete('/guilds/:guildId/roles/:roleId', auth, inGuild, route(async (req, res) => {
  const roleId = await D.roleIdFromDiscord(req.member.guild.id, req.params.roleId);
  if (roleId == null) return fail(res, 404, 10011, 'Unknown Role');
  await roleActions.deleteRole(req.member, roleId);
  res.status(204).end();
}));

router.get('/guilds/:guildId/emojis', auth, inGuild, route(async (req, res) => {
  const emojis = await db.all('SELECT id, name, animated, available FROM guild_emojis WHERE guild_id = ? AND available = 1 ORDER BY id', [req.member.guild.id]);
  res.json(emojis.map(D.emojiObject));
}));

router.get('/guilds/:guildId/emojis/:emojiId', auth, inGuild, route(async (req, res) => {
  const emoji = await db.get('SELECT id, name, animated, available FROM guild_emojis WHERE guild_id = ? AND id = ? AND available = 1', [req.member.guild.id, D.ourId(req.params.emojiId)]);
  if (!emoji) return fail(res, 404, 10014, 'Unknown Emoji');
  res.json(D.emojiObject(emoji));
}));

// ---- Members ----

router.get('/guilds/:guildId/members', auth, inGuild, route(async (req, res) => {
  const max = Math.min(Math.max(Number(req.query.limit) || 1, 1), 1000);
  res.json(await D.guildMembers(req.member.guild.id, { limit: max, after: D.ourId(req.query.after) ?? 0 }));
}));

router.get('/guilds/:guildId/members/search', auth, inGuild, route(async (req, res) => {
  if (typeof req.query.query !== 'string') throw new webhooks.FormError(['query'], 'This field is required', 'BASE_TYPE_REQUIRED');
  const max = Math.min(Math.max(Number(req.query.limit) || 1, 1), 1000);
  res.json(await D.guildMembers(req.member.guild.id, { query: req.query.query, limit: max }));
}));

async function memberOr404(guildId, userId) {
  const [member] = userId == null ? [] : await D.guildMembers(guildId, { userIds: [userId] });
  if (!member) throw new ActionError(404, 'Unknown Member', 10007);
  return member;
}

router.get('/guilds/:guildId/members/:userId', auth, inGuild, route(async (req, res) => {
  const userId = req.params.userId === '@me' ? req.bot.id : D.ourId(req.params.userId);
  res.json(await memberOr404(req.member.guild.id, userId));
}));

// Only `roles` can change: nicknames, server mute and deafen, moving and timeouts aren't in Voicaw.
async function modifyMember(req, res) {
  const userId = req.params.userId === '@me' ? req.bot.id : D.ourId(req.params.userId);
  const guildId = req.member.guild.id;
  const target = await memberOr404(guildId, userId);
  const body = req.body ?? {};
  for (const field of ['nick', 'mute', 'deaf', 'channel_id', 'communication_disabled_until']) {
    if (body[field] !== undefined && body[field] !== null) {
      throw new webhooks.FormError([field], `${field} isn't supported on Voicaw.`, 'BASE_TYPE_INVALID');
    }
  }
  if (body.roles !== undefined) {
    if (!Array.isArray(body.roles)) throw new webhooks.FormError(['roles'], 'Must be an array.', 'BASE_TYPE_ARRAY');
    const roleIds = [];
    for (const raw of body.roles) {
      const roleId = await D.roleIdFromDiscord(guildId, raw);
      if (roleId == null || String(raw) === String(guildId)) throw new ActionError(404, 'Unknown Role', 10011);
      roleIds.push(roleId);
    }
    // The bot's own role stays (it can't be given or taken), whether it's listed or not.
    const botRoles = target.roles.map(Number).filter((id) => req.member.allRoles.some((r) => r.id === id && r.bot_id));
    await roleActions.setMemberRoles(req.member, userId, [...new Set([...roleIds, ...botRoles])]);
  }
  res.json(await memberOr404(guildId, userId));
}

router.patch('/guilds/:guildId/members/:userId', auth, limit('member-update', 10, 10000), inGuild, route(modifyMember));

async function changeMemberRole(req, res, add) {
  const guildId = req.member.guild.id;
  const userId = D.ourId(req.params.userId);
  const target = await memberOr404(guildId, userId);
  const roleId = await D.roleIdFromDiscord(guildId, req.params.roleId);
  if (roleId == null || String(req.params.roleId) === String(guildId)) return fail(res, 404, 10011, 'Unknown Role');
  const current = target.roles.map(Number);
  const next = add ? [...new Set([...current, roleId])] : current.filter((id) => id !== roleId);
  if (next.length !== current.length) await roleActions.setMemberRoles(req.member, userId, next);
  res.status(204).end();
}

router.put('/guilds/:guildId/members/:userId/roles/:roleId', auth, limit('member-role', 10, 10000), inGuild, route((req, res) => changeMemberRole(req, res, true)));
router.delete('/guilds/:guildId/members/:userId/roles/:roleId', auth, limit('member-role', 10, 10000), inGuild, route((req, res) => changeMemberRole(req, res, false)));

router.delete('/guilds/:guildId/members/:userId', auth, limit('member-kick', 5, 5000), inGuild, route(async (req, res) => {
  await guildActions.kickMember(req.member, D.ourId(req.params.userId));
  res.status(204).end();
}));

// ---- Bans ----

async function banObjects(guildId, where = '', params = []) {
  const rows = await db.all(
    `SELECT ${D.USER_COLUMNS} FROM guild_bans b JOIN users u ON u.id = b.user_id WHERE b.guild_id = ? ${where} ORDER BY b.user_id`,
    [guildId, ...params]
  );
  return rows.map((u) => ({ reason: null, user: D.userObject(u) }));
}

router.get('/guilds/:guildId/bans', auth, inGuild, route(async (req, res) => {
  requirePermission(req.member.permissions, PERMISSIONS.BAN_MEMBERS);
  res.json(await banObjects(req.member.guild.id));
}));

router.get('/guilds/:guildId/bans/:userId', auth, inGuild, route(async (req, res) => {
  requirePermission(req.member.permissions, PERMISSIONS.BAN_MEMBERS);
  const [ban] = await banObjects(req.member.guild.id, 'AND b.user_id = ?', [D.ourId(req.params.userId)]);
  if (!ban) return fail(res, 404, 10026, 'Unknown Ban');
  res.json(ban);
}));

router.put('/guilds/:guildId/bans/:userId', auth, limit('ban', 5, 5000), inGuild, route(async (req, res) => {
  await guildActions.banMember(req.member, D.ourId(req.params.userId));
  res.status(204).end();
}));

router.delete('/guilds/:guildId/bans/:userId', auth, limit('ban', 5, 5000), inGuild, route(async (req, res) => {
  if (!(await guildActions.unbanMember(req.member, D.ourId(req.params.userId)))) return fail(res, 404, 10026, 'Unknown Ban');
  res.status(204).end();
}));

// ---- Invites ----

async function inviteObject(invite, channel) {
  const guild = await db.get('SELECT id, name, icon_version FROM guilds WHERE id = ?', [invite.guild_id]);
  const inviter = await userRow(invite.creator_id);
  return {
    type: 0,
    code: invite.code,
    guild: { id: String(guild.id), name: guild.name, icon: guild.icon_version > 0 ? `v${guild.icon_version}` : null, features: [] },
    channel: channel ? { id: String(channel.id), name: channel.name, type: D.CHANNEL_TYPES[channel.type] } : null,
    inviter: inviter ? D.userObject(inviter) : null,
    max_age: invite.expires_at ? invite.expires_at - invite.created_at : 0,
    max_uses: invite.max_uses ?? 0,
    uses: invite.uses,
    temporary: false,
    created_at: D.iso(invite.created_at),
    expires_at: invite.expires_at ? D.iso(invite.expires_at) : null,
  };
}

router.get('/guilds/:guildId/invites', auth, inGuild, route(async (req, res) => {
  requirePermission(req.member.permissions, PERMISSIONS.MANAGE_GUILD);
  const invites = await db.all(
    `${guildActions.INVITE_SELECT} WHERE i.guild_id = ? AND ${guildActions.INVITE_VALID} ORDER BY i.created_at DESC`,
    [req.member.guild.id]
  );
  res.json(await Promise.all(invites.map((i) => inviteObject(i, null))));
}));

// Voicaw's invites are to a guild, not a channel; the channel is only echoed back.
router.post('/channels/:channelId/invites', auth, limit('invite', 5, 5000), inChannel, route(async (req, res) => {
  if (req.category) throw new ActionError(400, 'Cannot execute action on this channel type', 50024);
  const maxAge = req.body?.max_age ?? 86400;
  const maxUses = req.body?.max_uses ?? 0;
  const invite = await guildActions.createInvite(req.member, { maxAge: Number(maxAge), maxUses: Number(maxUses) });
  res.json(await inviteObject(invite, req.access.channel));
}));

// ---- Channels ----

router.get('/channels/:channelId', auth, inChannel, route(async (req, res) => {
  if (req.category) return res.json(D.categoryObject(req.category, req.category.guild_id));
  res.json(await channelOf(req.access.channel));
}));

// Threads: `name`, `archived`. Channels: `name`, `topic`, `nsfw`, `parent_id`.
router.patch('/channels/:channelId', auth, limit('channel-update', 5, 10000), inChannel, route(async (req, res) => {
  if (req.category) throw new ActionError(400, "Categories can't be changed through the bot API yet", 50024);
  const { channel, permissions, member } = req.access;
  const body = req.body ?? {};
  if (channel.type === 'thread') {
    const thread = await threads.getThread(channel.id);
    await threadActions.updateThread({ thread, channel, permissions, userId: req.bot.id }, { name: body.name, archived: body.archived });
  } else {
    const changes = {};
    if (body.name !== undefined) changes.name = body.name;
    if (body.topic !== undefined) changes.topic = body.topic;
    if (body.nsfw !== undefined) changes.nsfw = Boolean(body.nsfw);
    if (body.parent_id !== undefined) {
      changes.categoryId = body.parent_id === null ? null : D.ourId(body.parent_id, 'category');
      if (changes.categoryId === undefined || (body.parent_id !== null && changes.categoryId == null)) {
        throw new webhooks.FormError(['parent_id'], 'Unknown category.', 'CHANNEL_PARENT_INVALID');
      }
    }
    // Manage Channels counts in the channel (overrides), as in Discord.
    await guildActions.updateChannel({ ...member, permissions }, channel, changes);
    await applyOverwrites(req, channel.id, body.permission_overwrites);
  }
  res.json(await channelOf(channel));
}));

router.delete('/channels/:channelId', auth, limit('channel-delete', 5, 10000), inChannel, route(async (req, res) => {
  if (req.category) throw new ActionError(400, "Categories can't be deleted through the bot API yet", 50024);
  const { channel, permissions, member } = req.access;
  const object = await channelOf(channel);
  if (channel.type === 'thread') {
    await threadActions.deleteThread({ thread: await threads.getThread(channel.id), permissions, userId: req.bot.id });
  } else {
    await guildActions.deleteChannel({ ...member, permissions }, channel);
  }
  res.json(object);
}));

router.put('/channels/:channelId/permissions/:overwriteId', auth, limit('overwrite', 10, 10000), inChannel, route(async (req, res) => {
  if (req.category || req.access.channel.type === 'thread') throw new ActionError(400, 'Cannot execute action on this channel type', 50024);
  await setOverwrite(req, req.access.channel.id, req.params.overwriteId, req.body ?? {});
  res.status(204).end();
}));

router.delete('/channels/:channelId/permissions/:overwriteId', auth, limit('overwrite', 10, 10000), inChannel, route(async (req, res) => {
  if (req.category || req.access.channel.type === 'thread') throw new ActionError(400, 'Cannot execute action on this channel type', 50024);
  const { channel } = req.access;
  const guildId = channel.guild_id;
  const roleId = await D.roleIdFromDiscord(guildId, req.params.overwriteId);
  const userId = D.ourId(req.params.overwriteId);
  const role = roleId != null && await db.get("SELECT 1 FROM guild_channel_overrides WHERE channel_id = ? AND target_type = 'role' AND target_id = ?", [channel.id, roleId]);
  const member = await db.get("SELECT 1 FROM guild_channel_overrides WHERE channel_id = ? AND target_type = 'member' AND target_id = ?", [channel.id, userId]);
  if (role) await setOverwrite(req, channel.id, req.params.overwriteId, { type: 0 });
  else if (member) await setOverwrite(req, channel.id, req.params.overwriteId, { type: 1 });
  res.status(204).end();
}));

// "<bot> is typing…" for a few seconds, as people's.
router.post('/channels/:channelId/typing', auth, limit('typing', 5, 5000), inTextChannel, route(async (req, res) => {
  const { channel, permissions } = req.access;
  requirePermission(permissions, PERMISSIONS.SEND_MESSAGES);
  const event = { type: 'typing', chatId: `channel-${channel.id}`, userId: req.bot.id };
  for (const userId of await getChannelViewers(channel)) if (userId !== req.bot.id) sendToUserSockets(userId, event);
  res.status(204).end();
}));

// ---- Messages ----

// Newest first, as Discord: `limit` (1–100, default 50), and `before`, `after` or `around`.
router.get('/channels/:channelId/messages', auth, limit('messages-get', 10, 1000), inTextChannel, route(async (req, res) => {
  const max = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const channelId = req.access.channel.id;
  const select = (where, params, order, count) => db.all(
    `${messages.MESSAGE_SELECT} WHERE m.channel_id = ? AND m.document_id IS NULL ${where} ORDER BY m.id ${order} LIMIT ?`,
    [channelId, ...params, count]
  );
  let rows;
  if (req.query.around != null) {
    const around = D.ourId(req.query.around) ?? 0;
    const older = await select('AND m.id <= ?', [around], 'DESC', Math.ceil(max / 2));
    const newer = await select('AND m.id > ?', [around], 'ASC', Math.floor(max / 2));
    rows = [...newer.reverse(), ...older];
  } else if (req.query.after != null) {
    rows = (await select('AND m.id > ?', [D.ourId(req.query.after) ?? 0], 'ASC', max)).reverse();
  } else if (req.query.before != null) {
    rows = await select('AND m.id < ?', [D.ourId(req.query.before) ?? 0], 'DESC', max);
  } else {
    rows = await select('', [], 'DESC', max);
  }
  res.json(await messageObjects(req, rows));
}));

// The pinned messages: Discord's newer form ({ items: [{ pinned_at, message }], has_more }).
router.get('/channels/:channelId/messages/pins', auth, inTextChannel, route(async (req, res) => {
  const max = Math.min(Math.max(Number(req.query.limit) || 50, 1), 50);
  const before = req.query.before ? Math.floor(new Date(req.query.before).getTime() / 1000) : null;
  const rows = await db.all(
    `${messages.MESSAGE_SELECT} WHERE m.channel_id = ? AND m.pinned_at IS NOT NULL ${before ? 'AND m.pinned_at < ?' : ''}
     ORDER BY m.pinned_at DESC, m.id DESC LIMIT ?`,
    [req.access.channel.id, ...(before ? [before] : []), max + 1]
  );
  const objects = await messageObjects(req, rows.slice(0, max));
  res.json({ items: objects.map((message, i) => ({ pinned_at: D.iso(rows[i].pinned_at), message })), has_more: rows.length > max });
}));

router.get('/channels/:channelId/pins', auth, inTextChannel, route(async (req, res) => {
  const rows = await db.all(
    `${messages.MESSAGE_SELECT} WHERE m.channel_id = ? AND m.pinned_at IS NOT NULL ORDER BY m.pinned_at DESC, m.id DESC`,
    [req.access.channel.id]
  );
  res.json(await messageObjects(req, rows));
}));

router.get('/channels/:channelId/messages/:messageId', auth, inTextChannel, inMessage, route(async (req, res) => {
  res.json(await loadMessage(req, req.message.id));
}));

// A new message or an edit, Discord's body (botMessages.js); an empty one is Discord's 50006.
async function readBody(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.empty) throw new ActionError(400, 'Cannot send an empty message', 50006);
    throw err;
  }
}

router.post('/channels/:channelId/messages', auth, limit('message-create', 5, 5000), webhooks.parseBody, inTextChannel, route(async (req, res) => {
  const { channel, permissions } = req.access;
  requirePermission(permissions, PERMISSIONS.SEND_MESSAGES);
  const { body: raw } = await webhooks.readBody(req);
  // A reply, to a message in this same channel (checked before any file is uploaded).
  let parentMessageId = null;
  const reference = raw.message_reference;
  if (reference != null && reference.message_id != null) {
    if (reference.type === 1) throw new webhooks.FormError(['message_reference', 'type'], "Forwarding isn't supported on Voicaw.", 'BASE_TYPE_CHOICES');
    const parentId = D.ourId(reference.message_id);
    const parent = parentId != null && await db.get(
      'SELECT id FROM guild_messages WHERE id = ? AND channel_id = ? AND document_id IS NULL',
      [parentId, channel.id]
    );
    if (parent) parentMessageId = parent.id;
    else if (reference.fail_if_not_exists !== false) {
      throw new webhooks.FormError(['message_reference'], 'Unknown message', 'MESSAGE_REFERENCE_UNKNOWN_MESSAGE');
    }
  }
  const built = await readBody(() => botMessages.readNewMessage(req));
  const message = await messages.createMessage({
    channel, permissions, senderId: req.bot.id, parentMessageId, ...built,
    silent: Boolean(built.flags & webhooks.FLAGS.SUPPRESS_NOTIFICATIONS),
  });
  const [object] = await D.messageObjects([message], { botId: req.bot.id });
  res.json({ ...object, ...(built.body.nonce != null ? { nonce: built.body.nonce } : {}) });
}));

// Only the bot's own messages: content, embeds, flags, components, attachments (those listed
// are kept, new files added), as for webhooks.
router.patch('/channels/:channelId/messages/:messageId', auth, limit('message-edit', 5, 5000), webhooks.parseBody, inTextChannel, inMessage, route(async (req, res) => {
  const old = req.message;
  if (old.sender_id !== req.bot.id || old.webhook_id) return fail(res, 403, 50005, 'Cannot edit a message authored by another user');
  if (old.system) return fail(res, 400, 50021, 'Cannot execute action on a system message');
  const { channel, permissions } = req.access;
  const edit = await readBody(() => botMessages.readEdit(req, old));
  const row = await botMessages.saveEdit(old.id, channel, req.bot.id, permissions, edit);
  res.json((await D.messageObjects([row], { botId: req.bot.id }))[0]);
}));

router.delete('/channels/:channelId/messages/:messageId', auth, limit('message-delete', 5, 1000), inTextChannel, inMessage, route(async (req, res) => {
  await messages.deleteMessage(req.message, req.access.channel, req.bot.id, req.access.permissions);
  res.status(204).end();
}));

// 2–100 message ids (Manage Messages).
router.post('/channels/:channelId/messages/bulk-delete', auth, limit('bulk-delete', 1, 1000), inTextChannel, route(async (req, res) => {
  const { channel, permissions } = req.access;
  requirePermission(permissions, PERMISSIONS.MANAGE_MESSAGES);
  const ids = req.body?.messages;
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > 100) {
    throw new webhooks.FormError(['messages'], 'Must be between 2 and 100 in length.', 'BASE_TYPE_BAD_LENGTH');
  }
  for (const raw of new Set(ids.map(String))) {
    const message = await db.get(
      'SELECT id, channel_id, sender_id, content, timestamp, system, webhook_id, webhook_name FROM guild_messages WHERE id = ? AND channel_id = ?',
      [D.ourId(raw), channel.id]
    );
    if (message) await messages.deleteMessage(message, channel, req.bot.id, permissions);
  }
  res.status(204).end();
}));

// ---- Reactions ----

async function emojiFromUrl(req) {
  const emoji = await D.reactionText(req.params.emoji);
  if (!emoji) throw new ActionError(400, 'Unknown Emoji', 10014);
  return emoji;
}

const reactionRows = (messageId, where = '', params = []) => db.all(
  `SELECT r.id, r.message_id, r.user_id, r.emoji, m.content, m.timestamp FROM guild_reactions r
   JOIN guild_messages m ON m.id = r.message_id WHERE r.message_id = ? ${where} ORDER BY r.id`,
  [messageId, ...params]
);

router.put('/channels/:channelId/messages/:messageId/reactions/:emoji/@me', auth, limit('reaction', 4, 1000), inTextChannel, inMessage, route(async (req, res) => {
  const emoji = await emojiFromUrl(req);
  try {
    await messages.addReaction(req.message, req.access.channel, req.bot.id, req.access.permissions, emoji);
  } catch (err) {
    if (!(err instanceof ActionError && err.status === 409)) throw err; // already there: fine, as in Discord
  }
  res.status(204).end();
}));

// Removes reactions with `emoji` (all emoji if null) by `userId` (everyone's if null).
async function removeReactions(req, { emoji = null, userId = null }) {
  const where = [];
  const params = [];
  if (emoji) { where.push('AND r.emoji = ?'); params.push(emoji); }
  if (userId != null) { where.push('AND r.user_id = ?'); params.push(userId); }
  for (const reaction of await reactionRows(req.message.id, where.join(' '), params)) {
    await messages.removeReaction(reaction, req.access.channel);
  }
}

router.delete('/channels/:channelId/messages/:messageId/reactions/:emoji/@me', auth, limit('reaction', 4, 1000), inTextChannel, inMessage, route(async (req, res) => {
  await removeReactions(req, { emoji: await emojiFromUrl(req), userId: req.bot.id });
  res.status(204).end();
}));

router.delete('/channels/:channelId/messages/:messageId/reactions/:emoji/:userId', auth, limit('reaction', 4, 1000), inTextChannel, inMessage, route(async (req, res) => {
  const userId = D.ourId(req.params.userId);
  if (userId !== req.bot.id) requirePermission(req.access.permissions, PERMISSIONS.MANAGE_MESSAGES);
  await removeReactions(req, { emoji: await emojiFromUrl(req), userId });
  res.status(204).end();
}));

router.delete('/channels/:channelId/messages/:messageId/reactions/:emoji', auth, limit('reaction', 4, 1000), inTextChannel, inMessage, route(async (req, res) => {
  requirePermission(req.access.permissions, PERMISSIONS.MANAGE_MESSAGES);
  await removeReactions(req, { emoji: await emojiFromUrl(req) });
  res.status(204).end();
}));

router.delete('/channels/:channelId/messages/:messageId/reactions', auth, limit('reaction', 4, 1000), inTextChannel, inMessage, route(async (req, res) => {
  requirePermission(req.access.permissions, PERMISSIONS.MANAGE_MESSAGES);
  await removeReactions(req, {});
  res.status(204).end();
}));

// Who reacted with `emoji`: `limit` (1–100, default 25) users `after` a user id.
router.get('/channels/:channelId/messages/:messageId/reactions/:emoji', auth, inTextChannel, inMessage, route(async (req, res) => {
  const emoji = await emojiFromUrl(req);
  const max = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const rows = await db.all(
    `SELECT ${D.USER_COLUMNS} FROM guild_reactions r JOIN users u ON u.id = r.user_id
     WHERE r.message_id = ? AND r.emoji = ? AND r.user_id > ? ORDER BY r.user_id LIMIT ?`,
    [req.message.id, emoji, D.ourId(req.query.after) ?? 0, max]
  );
  res.json(rows.map(D.userObject));
}));

// ---- Pins ----

const pinRoute = (pinned) => route(async (req, res) => {
  await messages.setMessagePinned(req.message, req.access.channel, req.bot.id, req.access.permissions, pinned);
  res.status(204).end();
});

router.put(['/channels/:channelId/pins/:messageId', '/channels/:channelId/messages/pins/:messageId'], auth, limit('pin', 5, 5000), inTextChannel, inMessage, pinRoute(true));
router.delete(['/channels/:channelId/pins/:messageId', '/channels/:channelId/messages/pins/:messageId'], auth, limit('pin', 5, 5000), inTextChannel, inMessage, pinRoute(false));

// ---- Threads ----

async function startThread(req, res, messageId) {
  const { channel, permissions } = req.access;
  if (channel.type !== 'text') throw new ActionError(400, 'Cannot execute action on this channel type', 50024);
  const thread = await threadActions.startThread({ channel, permissions, userId: req.bot.id }, { name: req.body?.name, messageId });
  const row = await db.get('SELECT * FROM guild_channels WHERE id = ?', [thread.id]);
  res.status(201).json(await channelOf(row));
}

router.post('/channels/:channelId/messages/:messageId/threads', auth, limit('thread-create', 5, 5000), inTextChannel, inMessage, route((req, res) => startThread(req, res, req.message.id)));
router.post('/channels/:channelId/threads', auth, limit('thread-create', 5, 5000), inTextChannel, route((req, res) => startThread(req, res, null)));

async function threadMembership(req, res, joined) {
  if (req.access.channel.type !== 'thread') throw new ActionError(400, 'Cannot execute action on this channel type', 50024);
  await threadActions.setThreadMembership(req.access.channel.id, req.bot.id, joined);
  res.status(204).end();
}

router.put('/channels/:channelId/thread-members/@me', auth, inTextChannel, route((req, res) => threadMembership(req, res, true)));
router.delete('/channels/:channelId/thread-members/@me', auth, inTextChannel, route((req, res) => threadMembership(req, res, false)));

function threadMemberObject(threadId, row) {
  return { id: String(threadId), user_id: String(row.user_id), join_timestamp: D.iso(row.joined_at), flags: 0 };
}

router.get('/channels/:channelId/thread-members', auth, inTextChannel, route(async (req, res) => {
  if (req.access.channel.type !== 'thread') throw new ActionError(400, 'Cannot execute action on this channel type', 50024);
  const rows = await db.all('SELECT user_id, joined_at FROM guild_thread_members WHERE thread_id = ? ORDER BY user_id', [req.access.channel.id]);
  res.json(rows.map((r) => threadMemberObject(req.access.channel.id, r)));
}));

// A channel's archived threads.
router.get('/channels/:channelId/threads/archived/public', auth, inTextChannel, route(async (req, res) => {
  const all = await threads.channelThreads(req.access.channel.id, req.bot.id);
  const archived = all.filter((t) => t.archived);
  const objects = [];
  for (const thread of archived) objects.push(await channelOf({ ...thread, type: 'thread' }));
  res.json({ threads: objects, members: [], has_more: false });
}));

// The guild's active threads in channels the bot can see.
router.get('/guilds/:guildId/threads/active', auth, inGuild, route(async (req, res) => {
  const layout = await getGuildLayout(req.member.guild.id, req.bot.id);
  const objects = [];
  for (const thread of layout.threads) objects.push(await channelOf({ ...thread, type: 'thread' }));
  const members = layout.threads.filter((t) => t.joined)
    .map((t) => ({ id: String(t.id), user_id: String(req.bot.id), join_timestamp: D.iso(t.created_at), flags: 0 }));
  res.json({ threads: objects, members });
}));

// Bodies too big or not JSON, answered Discord's way.
router.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return fail(res, 413, 40005, 'Request entity too large');
  if (err.type === 'entity.parse.failed') return fail(res, 400, 50109, 'The request body contains invalid JSON.');
  next(err);
});

// ---- Discord's CDN ----

// Libraries build picture links from Discord's CDN; pointing their CDN address at
// https://<api>/api/cdn makes those links work (redirects to our pictures).
const cdn = express.Router();
cdn.get('/avatars/:userId/:file', async (req, res) => {
  const user = await db.get('SELECT id, avatar FROM users WHERE id = ?', [D.ourId(req.params.userId)]);
  if (!user?.avatar) return res.status(404).end();
  res.redirect(302, `${config.s3Endpoint}/profile-pics/${user.id}/${user.avatar}.webp`);
});
cdn.get('/icons/:guildId/:file', async (req, res) => {
  const guild = await db.get('SELECT id, icon_version FROM guilds WHERE id = ?', [D.ourId(req.params.guildId)]);
  if (!guild?.icon_version) return res.status(404).end();
  res.redirect(302, `${config.s3Endpoint}/guild-icons/${guild.id}?v=${guild.icon_version}`);
});
cdn.get('/emojis/:file', (req, res) => {
  const id = D.ourId(String(req.params.file).split('.')[0]);
  if (id == null) return res.status(404).end();
  res.redirect(302, `${config.s3Endpoint}/emojis/${id}`);
});

// Any other path under the bot API: Discord's 404.
const notFound = (req, res) => fail(res, 404, 0, '404: Not Found');

module.exports = router;
module.exports.cdn = cdn;
module.exports.notFound = notFound;
module.exports.API_VERSION = API_VERSION;
module.exports.guildChannels = guildChannels;
module.exports.guildObject = guildObject;
module.exports.channelOf = channelOf;
module.exports.now = now;
