const crypto = require('crypto');
const express = require('express');
const sharp = require('sharp');
const db = require('../db');
const config = require('../config');
const { authenticateJWT } = require('../auth');
const { PERMISSIONS, has } = require('../permissions');
const { getChannelAccess, getMember, sendToChannel } = require('../guilds');
const { saveMentions, notifyNewMessage } = require('../mentions');
const { putObject } = require('../s3');
const { registerUpload, releaseUploads } = require('../uploads');
const { processAvatar, AvatarImageError, MAX_AVATAR_UPLOAD_BYTES } = require('../avatarImage');
const { createLimiter } = require('../rateLimit');
const { MESSAGE_SELECT, withReactions, logMessageDelete } = require('./guildMessages');
const { logAudit, diff } = require('../auditLog');

// Webhooks, with Discord's API (https://discord.com/developers/docs/resources/webhook), so
// anything that posts to a Discord webhook URL can post to ours by swapping the start of the
// URL: https://<api>/api/webhooks/<id>/<token> (also under /api/v<n>/, as Discord's are).
// - With the token (no login; the URL is the secret): execute (POST, JSON, form or multipart
//   with files; `?wait=true` returns the message), get / modify / delete the webhook, and get /
//   edit / delete the messages it sent.
// - Logged in, with Manage Webhooks (and View Channel): create in a channel, list a channel's or
//   a guild's, modify (name, avatar, channel), delete. Our app's Webhooks tab uses these.
// Errors are Discord's shape ({ message, code, errors }) plus our usual `error`.
// A webhook's messages have no user (sender_id 0); see db.js. Like Discord, they may ping
// @everyone, @here and any role, narrowed by `allowed_mentions`; images in embeds and an
// `avatar_url` override are other sites' images, loaded by readers' devices (no referrer).
const router = express.Router();

const MAX_NAME_LENGTH = 80;
const MAX_WEBHOOKS_PER_CHANNEL = 15;
const MAX_URL_LENGTH = 2048;
const MAX_FILES = 10;
const MAX_FILES_BYTES = 25 * 1024 * 1024;
const EMBED_LIMITS = { embeds: 10, total: 6000, title: 256, description: 4096, fields: 25, fieldName: 256, fieldValue: 1024, footer: 2048, author: 256 };
const FLAGS = { SUPPRESS_EMBEDS: 1 << 2, SUPPRESS_NOTIFICATIONS: 1 << 12 };
const AVATAR_BUCKET = 'profile-pics';
const FILE_BUCKET = 'uploads';
// Served as themselves; anything else is served as a download (application/octet-stream).
const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm|quicktime)|audio\/(mpeg|ogg|wav|webm|mp4|flac))$/;

const now = () => Math.floor(Date.now() / 1000);

// Discord's error shape, plus `error` (what our app reads).
function fail(res, status, code, message, errors) {
  return res.status(status).json({ message, code, ...(errors ? { errors } : {}), error: message });
}

// A 50035 "Invalid Form Body" error for one field: `path` like ['embeds', 0, 'title'].
class FormError extends Error {
  constructor(path, message, code = 'BASE_TYPE_INVALID') {
    super(message);
    this.path = path;
    this.errorCode = code;
  }
}

function failForm(res, err) {
  const errors = {};
  let at = errors;
  for (const key of err.path) at = at[key] = {};
  at._errors = [{ code: err.errorCode, message: err.message }];
  return fail(res, 400, 50035, 'Invalid Form Body', errors);
}

// ---- The webhook object ----

const avatarKey = (hookId, avatar) => `webhooks/${hookId}/${avatar}.webp`;
const avatarUrlOf = (hook) => (hook.avatar ? `${config.s3Endpoint}/${AVATAR_BUCKET}/${avatarKey(hook.id, hook.avatar)}` : null);
// nginx doesn't say whether the visitor used https; anything but this machine is.
function webhookUrl(req, hook) {
  const host = req.get('host') ?? '';
  const protocol = req.get('x-forwarded-proto') ?? (/^(localhost|127\.|\[::1\])/.test(host) ? req.protocol : 'https');
  return `${protocol}://${host}/api/webhooks/${hook.id}/${hook.token}`;
}

// As Discord sends it (ids as strings); `avatar_url` and `created_at` are ours.
function webhookObject(req, hook, { creator } = {}) {
  return {
    type: 1,
    id: String(hook.id),
    guild_id: String(hook.guild_id),
    channel_id: String(hook.channel_id),
    name: hook.name,
    avatar: hook.avatar,
    application_id: null,
    token: hook.token,
    url: webhookUrl(req, hook),
    ...(creator ? { user: { id: String(creator.id), username: creator.username, global_name: creator.display_name ?? null, avatar: creator.avatar ?? null } } : {}),
    avatar_url: avatarUrlOf(hook),
    created_at: hook.created_at,
  };
}

async function withCreators(req, hooks) {
  const ids = [...new Set(hooks.map((h) => h.creator_id).filter(Boolean))];
  const users = ids.length
    ? await db.all(`SELECT id, username, display_name, avatar FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  return hooks.map((h) => webhookObject(req, h, { creator: byId.get(h.creator_id) }));
}

// ---- Checking what's sent ----

function cleanName(value, path = ['name']) {
  if (typeof value !== 'string') throw new FormError(path, 'This field is required', 'BASE_TYPE_REQUIRED');
  const name = value.trim();
  if (name.length < 1 || name.length > MAX_NAME_LENGTH) {
    throw new FormError(path, `Must be between 1 and ${MAX_NAME_LENGTH} in length.`, 'BASE_TYPE_BAD_LENGTH');
  }
  return name;
}

function isWebUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return false;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

// An http(s) URL, or `attachment://<filename>` for a file sent with the message.
function cleanUrl(value, path, files = []) {
  if (value == null) return undefined;
  if (typeof value === 'string' && value.startsWith('attachment://')) {
    const file = files.find((f) => f.filename === value.slice('attachment://'.length));
    if (file) return file.url;
  }
  if (!isWebUrl(value)) throw new FormError(path, 'Not a well formed URL.', 'URL_TYPE_INVALID_URL');
  return value;
}

function cleanText(value, max, path, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw new FormError(path, 'This field is required', 'BASE_TYPE_REQUIRED');
    return undefined;
  }
  const text = String(value);
  if (text.length > max) throw new FormError(path, `Must be ${max} or fewer in length.`, 'BASE_TYPE_MAX_LENGTH');
  return text;
}

// Discord's embed, checked and cut down to the parts we keep. Throws FormError.
function cleanEmbed(raw, i, files) {
  const at = (...keys) => ['embeds', i, ...keys];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new FormError(at(), 'Must be an object.', 'MODEL_TYPE_CONVERT');
  const embed = { type: 'rich' };
  const set = (key, value) => { if (value !== undefined) embed[key] = value; };
  set('title', cleanText(raw.title, EMBED_LIMITS.title, at('title')));
  set('description', cleanText(raw.description, EMBED_LIMITS.description, at('description')));
  set('url', cleanUrl(raw.url, at('url'), files));
  if (raw.timestamp != null) {
    const time = new Date(raw.timestamp);
    if (Number.isNaN(time.getTime())) throw new FormError(at('timestamp'), 'Could not parse timestamp.', 'DATE_TIME_TYPE_PARSE');
    embed.timestamp = time.toISOString();
  }
  if (raw.color != null) {
    const color = Number(raw.color);
    if (!Number.isInteger(color) || color < 0 || color > 0xFFFFFF) throw new FormError(at('color'), 'Int value should be between 0 and 16777215.', 'NUMBER_TYPE_MAX');
    embed.color = color;
  }
  if (raw.footer != null) {
    embed.footer = { text: cleanText(raw.footer.text, EMBED_LIMITS.footer, at('footer', 'text'), { required: true }) };
    const icon = cleanUrl(raw.footer.icon_url, at('footer', 'icon_url'), files);
    if (icon) embed.footer.icon_url = icon;
  }
  for (const key of ['image', 'thumbnail']) {
    if (raw[key] != null) {
      const url = cleanUrl(raw[key].url, at(key, 'url'), files);
      if (!url) throw new FormError(at(key, 'url'), 'This field is required', 'BASE_TYPE_REQUIRED');
      const file = files.find((f) => f.url === url);
      embed[key] = { url, ...(file?.width ? { width: file.width, height: file.height } : {}) };
    }
  }
  if (raw.author != null) {
    embed.author = { name: cleanText(raw.author.name, EMBED_LIMITS.author, at('author', 'name'), { required: true }) };
    const url = cleanUrl(raw.author.url, at('author', 'url'), files);
    const icon = cleanUrl(raw.author.icon_url, at('author', 'icon_url'), files);
    if (url) embed.author.url = url;
    if (icon) embed.author.icon_url = icon;
  }
  if (raw.provider != null) {
    embed.provider = {};
    const name = cleanText(raw.provider.name, EMBED_LIMITS.author, at('provider', 'name'));
    const url = cleanUrl(raw.provider.url, at('provider', 'url'), files);
    if (name) embed.provider.name = name;
    if (url) embed.provider.url = url;
  }
  if (raw.fields != null) {
    if (!Array.isArray(raw.fields)) throw new FormError(at('fields'), 'Must be an array.', 'BASE_TYPE_ARRAY');
    if (raw.fields.length > EMBED_LIMITS.fields) throw new FormError(at('fields'), `Must be ${EMBED_LIMITS.fields} or fewer in length.`, 'BASE_TYPE_MAX_LENGTH');
    embed.fields = raw.fields.map((field, f) => ({
      name: cleanText(field?.name, EMBED_LIMITS.fieldName, at('fields', f, 'name'), { required: true }),
      value: cleanText(field?.value, EMBED_LIMITS.fieldValue, at('fields', f, 'value'), { required: true }),
      inline: Boolean(field?.inline),
    }));
  }
  return embed;
}

const embedLength = (e) => [e.title, e.description, e.footer?.text, e.author?.name, ...(e.fields ?? []).flatMap((f) => [f.name, f.value])]
  .reduce((sum, text) => sum + (text?.length ?? 0), 0);

function cleanEmbeds(raw, files) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new FormError(['embeds'], 'Must be an array.', 'BASE_TYPE_ARRAY');
  if (raw.length > EMBED_LIMITS.embeds) throw new FormError(['embeds'], `Must be ${EMBED_LIMITS.embeds} or fewer in length.`, 'BASE_TYPE_MAX_LENGTH');
  const embeds = raw.map((e, i) => cleanEmbed(e, i, files));
  if (embeds.reduce((sum, e) => sum + embedLength(e), 0) > EMBED_LIMITS.total) {
    throw new FormError(['embeds'], `Embed size exceeds maximum size of ${EMBED_LIMITS.total}`, 'MAX_EMBED_SIZE_EXCEEDED');
  }
  // An embed with nothing to show is dropped.
  return embeds.filter((e) => Object.keys(e).length > 1);
}

// `allowed_mentions` for mentions.js, or undefined (everything the text asks for).
function cleanAllowedMentions(raw) {
  if (raw == null) return undefined;
  if (typeof raw !== 'object') throw new FormError(['allowed_mentions'], 'Must be an object.', 'MODEL_TYPE_CONVERT');
  const parse = new Set(Array.isArray(raw.parse) ? raw.parse : []);
  for (const kind of parse) {
    if (!['users', 'roles', 'everyone'].includes(kind)) throw new FormError(['allowed_mentions', 'parse'], `Value "${kind}" is not a valid enum value.`, 'BASE_TYPE_CHOICES');
  }
  const ids = (kind) => {
    const list = raw[kind] ?? [];
    if (!Array.isArray(list) || list.length > 100) throw new FormError(['allowed_mentions', kind], 'Must be 100 or fewer in length.', 'BASE_TYPE_MAX_LENGTH');
    if (list.length && parse.has(kind)) {
      throw new FormError(['allowed_mentions', kind], `parse:["${kind}"] and ${kind}: [ids...] are mutually exclusive.`, 'MUTUALLY_EXCLUSIVE');
    }
    return new Set(list.map(Number).filter(Number.isInteger));
  };
  return { parse, users: ids('users'), roles: ids('roles') };
}

// A file's name as it's stored and linked (Discord's rule: only letters, digits, . _ -).
function cleanFilename(name, index) {
  const clean = String(name ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 100);
  return clean || `file${index}`;
}

// Uploads the files (unencrypted, like the rest of a guild) and returns Discord attachment
// objects. `meta` is the body's `attachments` ([{ id, filename, description }]).
async function storeFiles(files, meta = []) {
  const stored = [];
  for (const [index, { field, file }] of files.entries()) {
    const n = field.match(/\d+/)?.[0];
    const info = (Array.isArray(meta) ? meta : []).find((m) => m && String(m.id) === n) ?? {};
    const filename = cleanFilename(info.filename ?? file.name, index);
    const body = Buffer.from(await file.arrayBuffer());
    const contentType = INLINE_TYPES.test(file.type) ? file.type : 'application/octet-stream';
    const id = crypto.randomUUID();
    const key = `webhooks/${id}/${filename}`;
    let size = {};
    if (contentType.startsWith('image/')) {
      try {
        const meta2 = await sharp(body, { limitInputPixels: 100_000_000 }).metadata();
        size = { width: meta2.width, height: meta2.pageHeight ?? meta2.height };
      } catch {
        // Not readable as an image: still a file.
      }
    }
    await putObject(FILE_BUCKET, key, body, contentType);
    await registerUpload(key, null);
    const url = `${config.s3Endpoint}/${FILE_BUCKET}/${key}`;
    stored.push({
      id, filename, size: body.length, url, proxy_url: url, content_type: contentType, ...size,
      ...(typeof info.description === 'string' && info.description ? { description: info.description.slice(0, 1024) } : {}),
    });
  }
  return stored;
}

// The request's fields and files, whichever way they were sent: JSON, a form, or multipart
// with `payload_json` and files as `files[n]` (or any other name).
async function readBody(req) {
  if (!req.is('multipart/form-data')) return { body: req.body && typeof req.body === 'object' ? req.body : {}, files: [] };
  let form;
  try {
    form = await new Response(req.body, { headers: { 'content-type': req.get('content-type') } }).formData();
  } catch {
    throw new FormError(['_'], 'The request body could not be read.', 'MULTIPART_INVALID');
  }
  let body = {};
  const files = [];
  for (const [name, value] of form) {
    if (typeof value !== 'string') {
      files.push({ field: name, file: value });
    } else if (name === 'payload_json') {
      try {
        body = { ...body, ...JSON.parse(value) };
      } catch {
        throw new FormError(['payload_json'], 'Invalid JSON.', 'JSON_INVALID');
      }
    } else {
      body[name] = value;
    }
  }
  if (files.length > MAX_FILES) throw new FormError(['files'], `Must be ${MAX_FILES} or fewer in length.`, 'BASE_TYPE_MAX_LENGTH');
  if (files.reduce((sum, f) => sum + f.file.size, 0) > MAX_FILES_BYTES) throw Object.assign(new Error('too large'), { tooLarge: true });
  return { body, files };
}

function cleanContent(value) {
  if (value == null) return '';
  const content = String(value).trim();
  if (content.length > config.maxPlaintextLength) {
    throw new FormError(['content'], `Must be ${config.maxPlaintextLength} or fewer in length.`, 'BASE_TYPE_MAX_LENGTH');
  }
  return content;
}

// A data URI (Discord's "image data") as a processed picture, stored for `hookId`; returns the
// new avatar id.
async function storeAvatar(hookId, dataUri) {
  const match = typeof dataUri === 'string' && dataUri.match(/^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) throw new FormError(['avatar'], 'Invalid image data', 'IMAGE_INVALID');
  const original = Buffer.from(match[1], 'base64');
  if (original.length > MAX_AVATAR_UPLOAD_BYTES) throw new FormError(['avatar'], 'File cannot be larger than 8 MB.', 'BINARY_TYPE_MAX_SIZE');
  let image;
  try {
    image = await processAvatar(original);
  } catch (err) {
    if (err instanceof AvatarImageError) throw new FormError(['avatar'], err.message, 'IMAGE_INVALID');
    throw err;
  }
  const avatar = crypto.randomUUID();
  await putObject(AVATAR_BUCKET, avatarKey(hookId, avatar), image.buffer, image.contentType);
  return avatar;
}

// ---- Loading a webhook ----

const findHook = (id) => (/^\d+$/.test(String(id)) ? db.get('SELECT * FROM guild_webhooks WHERE id = ?', [Number(id)]) : null);

function tokenMatches(hook, token) {
  const a = Buffer.from(String(token));
  const b = Buffer.from(hook.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Per webhook, like Discord: 5 requests per 2 seconds (headers included, so clients pace
// themselves).
const limiter = createLimiter({ windowMs: 2000, max: 5 });

// Loads req.hook from :webhookId + :token (no login).
async function byToken(req, res, next) {
  const hook = await findHook(req.params.webhookId);
  if (!hook) return fail(res, 404, 10015, 'Unknown Webhook');
  if (!tokenMatches(hook, req.params.token)) return fail(res, 401, 50027, 'Invalid Webhook Token');
  if (config.rateLimitsEnabled) {
    const { allowed, retryAfterMs, remaining } = limiter.hit(`hook:${hook.id}`);
    res.set({
      'X-RateLimit-Limit': '5',
      'X-RateLimit-Remaining': String(remaining),
      'X-RateLimit-Reset-After': (retryAfterMs / 1000).toFixed(3),
      'X-RateLimit-Bucket': `webhook-${hook.id}`,
    });
    if (!allowed) {
      res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      return res.status(429).json({ message: 'You are being rate limited.', retry_after: retryAfterMs / 1000, global: false, code: 0, error: 'You are being rate limited.' });
    }
  }
  req.hook = hook;
  next();
}

// Logged in: loads req.hook and req.access (its channel) if the caller may manage it.
async function byLogin(req, res, next) {
  const hook = await findHook(req.params.webhookId);
  const access = hook && await getChannelAccess(hook.channel_id, req.user.id);
  if (!access || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) return fail(res, 404, 10015, 'Unknown Webhook');
  if (!has(access.permissions, PERMISSIONS.MANAGE_WEBHOOKS)) return fail(res, 403, 50013, 'Missing Permissions');
  req.hook = hook;
  req.access = access;
  next();
}

// A text channel (:channelId) the caller may manage webhooks in: req.access.
async function manageableChannel(req, res, next) {
  const access = await getChannelAccess(Number(req.params.channelId), req.user.id);
  if (!access || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) return fail(res, 404, 10003, 'Unknown Channel');
  if (!has(access.permissions, PERMISSIONS.MANAGE_WEBHOOKS)) return fail(res, 403, 50013, 'Missing Permissions');
  if (access.channel.type !== 'text') return fail(res, 400, 50024, 'Cannot execute action on this channel type');
  req.access = access;
  next();
}

// Body parsers for these routes only (the app's own JSON parser skips webhook paths, see
// index.js): JSON up to an avatar's size, forms, and multipart kept raw for readBody.
const parseBody = [
  express.json({ limit: '12mb' }),
  express.urlencoded({ extended: false, limit: '1mb' }),
  express.raw({ type: 'multipart/form-data', limit: MAX_FILES_BYTES + 1024 * 1024 }),
];

// Runs a handler, answering FormErrors (and oversized uploads) Discord's way.
const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    if (err instanceof FormError) return failForm(res, err);
    if (err.tooLarge) return fail(res, 413, 40005, 'Request entity too large');
    throw err;
  }
};

// ---- Managing (logged in) ----

async function createWebhook(req, res) {
  const { channel } = req.access;
  const name = cleanName(req.body?.name);
  const { count } = await db.get('SELECT COUNT(*) AS count FROM guild_webhooks WHERE channel_id = ?', [channel.id]);
  if (count >= MAX_WEBHOOKS_PER_CHANNEL) return fail(res, 400, 30007, `Maximum number of webhooks reached (${MAX_WEBHOOKS_PER_CHANNEL})`);
  const token = crypto.randomBytes(51).toString('base64url'); // 68 characters, like Discord's
  const { lastID } = await db.run(
    'INSERT INTO guild_webhooks (guild_id, channel_id, name, token, creator_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [channel.guild_id, channel.id, name, token, req.user.id, now()]
  );
  if (req.body?.avatar) {
    try {
      const avatar = await storeAvatar(lastID, req.body.avatar);
      await db.run('UPDATE guild_webhooks SET avatar = ? WHERE id = ?', [avatar, lastID]);
    } catch (err) {
      await db.run('DELETE FROM guild_webhooks WHERE id = ?', [lastID]);
      throw err;
    }
  }
  await logAudit({
    guildId: channel.guild_id,
    action: 'webhook_create',
    actorId: req.user.id,
    targetType: 'webhook',
    targetId: lastID,
    channelId: channel.id,
    details: { name, channelName: channel.name },
  });
  const [hook] = await withCreators(req, [await findHook(lastID)]);
  res.status(200).json(hook);
}

router.post('/channels/:channelId/webhooks', authenticateJWT, parseBody, manageableChannel, handle(createWebhook));

router.get('/channels/:channelId/webhooks', authenticateJWT, manageableChannel, async (req, res) => {
  const hooks = await db.all('SELECT * FROM guild_webhooks WHERE channel_id = ? ORDER BY id', [req.access.channel.id]);
  res.json(await withCreators(req, hooks));
});

// Every webhook in the guild, in channels the caller can see (Manage Webhooks).
router.get('/guilds/:guildId/webhooks', authenticateJWT, async (req, res) => {
  const member = await getMember(Number(req.params.guildId), req.user.id);
  if (!member) return fail(res, 404, 10004, 'Unknown Guild');
  if (!has(member.permissions, PERMISSIONS.MANAGE_WEBHOOKS)) return fail(res, 403, 50013, 'Missing Permissions');
  const hooks = await db.all('SELECT * FROM guild_webhooks WHERE guild_id = ? ORDER BY id', [member.guild.id]);
  const visible = [];
  for (const hook of hooks) {
    const access = await getChannelAccess(hook.channel_id, req.user.id);
    if (access && has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) visible.push(hook);
  }
  res.json(await withCreators(req, visible));
});

// Audit log entry for something done to req.hook, logged in (by the user) or with its token
// (by the webhook itself).
async function logWebhookAction(req, action, details) {
  const channel = await db.get('SELECT id, name FROM guild_channels WHERE id = ?', [req.hook.channel_id]);
  await logAudit({
    guildId: req.hook.guild_id,
    action,
    actorId: req.user?.id ?? null,
    webhookId: req.user ? null : req.hook.id,
    targetType: 'webhook',
    targetId: req.hook.id,
    channelId: req.hook.channel_id,
    details: { ...details, channelName: channel?.name ?? null },
  });
}

// Changes name, avatar (image data, or null for the default) and, logged in, channel_id.
async function modifyWebhook(req, res, { canMove }) {
  const body = req.body ?? {};
  const updates = {};
  if (body.name !== undefined) updates.name = cleanName(body.name);
  if (body.channel_id !== undefined) {
    if (!canMove) throw new FormError(['channel_id'], 'Cannot change the channel with a webhook token.', 'BASE_TYPE_INVALID');
    const target = await getChannelAccess(Number(body.channel_id), req.user.id);
    if (!target || target.channel.guild_id !== req.hook.guild_id || !has(target.permissions, PERMISSIONS.VIEW_CHANNEL)) {
      return fail(res, 404, 10003, 'Unknown Channel');
    }
    if (!has(target.permissions, PERMISSIONS.MANAGE_WEBHOOKS)) return fail(res, 403, 50013, 'Missing Permissions');
    if (target.channel.type !== 'text') return fail(res, 400, 50024, 'Cannot execute action on this channel type');
    updates.channel_id = target.channel.id;
  }
  // Old pictures stay: messages sent with them still show them.
  if (body.avatar !== undefined) updates.avatar = body.avatar === null ? null : await storeAvatar(req.hook.id, body.avatar);
  const keys = Object.keys(updates);
  if (keys.length) {
    await db.run(`UPDATE guild_webhooks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => updates[k]), req.hook.id]);
  }
  const hook = await findHook(req.hook.id);
  const changes = diff(req.hook, { name: updates.name, channel_id: updates.channel_id });
  if (changes.channel_id) {
    const names = await db.all('SELECT id, name FROM guild_channels WHERE id IN (?, ?)', changes.channel_id);
    changes.channel = changes.channel_id.map((id) => names.find((c) => c.id === id)?.name ?? null);
    delete changes.channel_id;
  }
  if (updates.avatar !== undefined) changes.avatar = updates.avatar === null ? 'removed' : 'changed';
  if (Object.keys(changes).length) await logWebhookAction(req, 'webhook_update', { name: hook.name, changes });
  res.json(canMove ? (await withCreators(req, [hook]))[0] : webhookObject(req, hook));
}

// Messages it sent stay (with the name and picture they were sent with), as in Discord.
async function deleteWebhook(req, res) {
  await db.transaction(async () => {
    await logWebhookAction(req, 'webhook_delete', { name: req.hook.name });
    await db.run('DELETE FROM guild_webhooks WHERE id = ?', [req.hook.id]);
  });
  res.status(204).end();
}

router.get('/webhooks/:webhookId', authenticateJWT, byLogin, async (req, res) => {
  res.json((await withCreators(req, [req.hook]))[0]);
});
router.patch('/webhooks/:webhookId', authenticateJWT, parseBody, byLogin, handle((req, res) => modifyWebhook(req, res, { canMove: true })));
router.delete('/webhooks/:webhookId', authenticateJWT, byLogin, deleteWebhook);

// ---- With the token ----

router.get('/webhooks/:webhookId/:token', byToken, (req, res) => res.json(webhookObject(req, req.hook)));
router.patch('/webhooks/:webhookId/:token', byToken, parseBody, handle((req, res) => modifyWebhook(req, res, { canMove: false })));
router.delete('/webhooks/:webhookId/:token', byToken, deleteWebhook);

// The message as Discord sends it (ids as strings, ISO times, the webhook as a bot author).
async function discordMessage(row) {
  const mentioned = await db.all(
    'SELECT u.id, u.username, u.display_name FROM guild_mentions gm JOIN users u ON u.id = gm.user_id WHERE gm.message_id = ?',
    [row.id]
  );
  return {
    id: String(row.id),
    type: row.parent_message_id ? 19 : 0,
    content: row.content,
    channel_id: String(row.channel_id),
    author: { id: String(row.webhook_id), username: row.webhook_name, avatar: null, discriminator: '0000', global_name: null, bot: true },
    attachments: row.attachments,
    embeds: row.flags & FLAGS.SUPPRESS_EMBEDS ? [] : row.embeds,
    mentions: mentioned.map((u) => ({ id: String(u.id), username: u.username, global_name: u.display_name ?? null })),
    mention_roles: row.mention_roles.map(String),
    mention_everyone: Boolean(row.mention_everyone),
    pinned: false,
    tts: false,
    timestamp: new Date(row.timestamp * 1000).toISOString(),
    edited_timestamp: row.edited_at ? new Date(row.edited_at * 1000).toISOString() : null,
    flags: row.flags,
    components: [],
    webhook_id: String(row.webhook_id),
  };
}

async function loadMessage(id) {
  const row = await db.get(`${MESSAGE_SELECT} WHERE m.id = ?`, [id]);
  return row ? (await withReactions([row]))[0] : null;
}

// What to keep of `flags` (Discord ignores the rest when sending).
const cleanFlags = (value) => (Number(value) || 0) & (FLAGS.SUPPRESS_EMBEDS | FLAGS.SUPPRESS_NOTIFICATIONS);

router.post('/webhooks/:webhookId/:token', byToken, parseBody, handle(async (req, res) => {
  if (req.query.thread_id !== undefined) return fail(res, 400, 10003, 'Unknown Channel');
  const channel = await db.get('SELECT id, guild_id, name, type FROM guild_channels WHERE id = ?', [req.hook.channel_id]);
  if (!channel) return fail(res, 404, 10003, 'Unknown Channel');
  const { body, files } = await readBody(req);

  const content = cleanContent(body.content);
  const username = body.username != null && body.username !== '' ? cleanName(body.username, ['username']) : req.hook.name;
  let avatar = avatarUrlOf(req.hook);
  if (body.avatar_url != null && body.avatar_url !== '') {
    if (!isWebUrl(body.avatar_url)) throw new FormError(['avatar_url'], 'Not a well formed URL.', 'URL_TYPE_INVALID_URL');
    avatar = body.avatar_url;
  }
  const allowed = cleanAllowedMentions(body.allowed_mentions);
  const flags = cleanFlags(body.flags);
  // Check the embeds (with placeholders for the files) before uploading anything.
  const pending = files.map(({ file }, i) => ({ filename: cleanFilename(file.name, i), url: `pending:${i}` }));
  cleanEmbeds(body.embeds, pending);
  if (!content && !files.length && !(Array.isArray(body.embeds) && body.embeds.length)) {
    return fail(res, 400, 50006, 'Cannot send an empty message');
  }
  const attachments = await storeFiles(files, body.attachments);
  const embeds = cleanEmbeds(body.embeds, attachments);
  if (!content && !attachments.length && !embeds.length) return fail(res, 400, 50006, 'Cannot send an empty message');

  const { id, mentions } = await db.transaction(async () => {
    const { lastID } = await db.run(
      `INSERT INTO guild_messages (channel_id, sender_id, content, timestamp, webhook_id, webhook_name, webhook_avatar, embeds, attachments, flags)
       VALUES (?, 0, ?, strftime('%s','now'), ?, ?, ?, ?, ?, ?)`,
      [channel.id, content, req.hook.id, username, avatar, embeds.length ? JSON.stringify(embeds) : null,
        attachments.length ? JSON.stringify(attachments) : null, flags]
    );
    const found = await saveMentions({ id: lastID, content, sender_id: 0 }, channel, PERMISSIONS.MENTION_EVERYONE, allowed);
    await db.indexGuildMessage(lastID);
    return { id: lastID, mentions: found };
  });
  const message = await loadMessage(id);
  await sendToChannel(channel, { type: 'guild_message_new', guildId: channel.guild_id, message });
  notifyNewMessage(message, channel, mentions, { silent: Boolean(flags & FLAGS.SUPPRESS_NOTIFICATIONS) })
    .catch((err) => console.error('Guild push failed:', err.message));

  if (['true', '1'].includes(String(req.query.wait).toLowerCase())) return res.json(await discordMessage(message));
  res.status(204).end();
}));

// Loads req.message: one of this webhook's messages.
async function ownMessage(req, res, next) {
  const message = /^\d+$/.test(req.params.messageId) && await loadMessage(Number(req.params.messageId));
  if (!message || message.webhook_id !== req.hook.id) return fail(res, 404, 10008, 'Unknown Message');
  req.message = message;
  next();
}

router.get('/webhooks/:webhookId/:token/messages/:messageId', byToken, ownMessage, async (req, res) => {
  res.json(await discordMessage(req.message));
});

// Changes content, embeds, flags and attachments (`attachments` lists the ones to keep, by id;
// new files are added), like Discord. The name and picture stay as sent.
router.patch('/webhooks/:webhookId/:token/messages/:messageId', byToken, ownMessage, parseBody, handle(async (req, res) => {
  const { body, files } = await readBody(req);
  const old = req.message;
  const content = body.content !== undefined ? cleanContent(body.content) : old.content;
  const allowed = cleanAllowedMentions(body.allowed_mentions);
  let kept = old.attachments;
  if (body.attachments !== undefined) {
    const keepIds = new Set((Array.isArray(body.attachments) ? body.attachments : []).map((a) => String(a?.id)));
    kept = old.attachments.filter((a) => keepIds.has(String(a.id)));
  }
  const pending = files.map(({ file }, i) => ({ filename: cleanFilename(file.name, i), url: `pending:${i}` }));
  if (body.embeds !== undefined) cleanEmbeds(body.embeds, [...kept, ...pending]);
  const added = await storeFiles(files, body.attachments);
  const attachments = [...kept, ...added];
  const embeds = body.embeds !== undefined ? cleanEmbeds(body.embeds, attachments) : old.embeds;
  const flags = body.flags !== undefined ? cleanFlags(body.flags) : old.flags;
  if (!content && !attachments.length && !embeds.length) return fail(res, 400, 50006, 'Cannot send an empty message');

  const channel = await db.get('SELECT id, guild_id, name, type FROM guild_channels WHERE id = ?', [old.channel_id]);
  await db.transaction(async () => {
    await db.run(
      `UPDATE guild_messages SET content = ?, embeds = ?, attachments = ?, flags = ?, edited = 1, edited_at = strftime('%s','now') WHERE id = ?`,
      [content, embeds.length ? JSON.stringify(embeds) : null, attachments.length ? JSON.stringify(attachments) : null, flags, old.id]
    );
    await saveMentions({ id: old.id, content, sender_id: 0 }, channel, PERMISSIONS.MENTION_EVERYONE, allowed);
    await db.indexGuildMessage(old.id);
  });
  releaseUploads();
  const message = await loadMessage(old.id);
  await sendToChannel(channel, {
    type: 'guild_message_edit',
    guildId: channel.guild_id,
    channelId: channel.id,
    messageId: message.id,
    content: message.content,
    embeds: message.embeds,
    attachments: message.attachments,
    flags: message.flags,
    mention_everyone: message.mention_everyone,
    mention_roles: message.mention_roles,
  });
  res.json(await discordMessage(message));
}));

router.delete('/webhooks/:webhookId/:token/messages/:messageId', byToken, ownMessage, async (req, res) => {
  const { id, channel_id: channelId } = req.message;
  const channel = await db.get('SELECT id, guild_id, name FROM guild_channels WHERE id = ?', [channelId]);
  await db.transaction(async () => {
    if (channel) await logMessageDelete(req.message, channel, { webhookId: req.hook.id });
    await db.run('DELETE FROM guild_reactions WHERE message_id = ?', [id]);
    await db.run('DELETE FROM guild_mentions WHERE message_id = ?', [id]);
    await db.run('DELETE FROM guild_messages WHERE id = ?', [id]);
  });
  releaseUploads();
  if (channel) await sendToChannel(channel, { type: 'guild_message_delete', guildId: channel.guild_id, channelId, messageId: id });
  res.status(204).end();
});

// Bodies that are too big or aren't JSON, answered Discord's way.
router.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return fail(res, 413, 40005, 'Request entity too large');
  if (err.type === 'entity.parse.failed') return fail(res, 400, 50109, 'The request body contains invalid JSON.');
  next(err);
});

module.exports = router;
module.exports.FLAGS = FLAGS;
// Shared with the bot API (routes/botApi.js), which takes the same message bodies.
Object.assign(module.exports, {
  fail, FormError, failForm, parseBody, readBody, cleanContent, cleanEmbeds, cleanAllowedMentions,
  cleanFilename, cleanFlags, storeFiles, isWebUrl,
});
