const crypto = require('crypto');
const db = require('./db');
const { PERMISSIONS, has } = require('./permissions');
const { getMember, getChannelAccess, getOverrides } = require('./guilds');
const { sendToUserSockets } = require('./sockets');
const { ActionError } = require('./actionError');
const D = require('./discord');
const C = require('./components');
const commands = require('./commands');
const { botUploadLimitBytes } = require('./appSettings');

// Interactions (docs/bots.md), Discord's
// (https://discord.com/developers/docs/interactions/receiving-and-responding): someone uses a
// bot's command (type 2), clicks a button or picks from a select on its message (3), types in
// an autocomplete option (4) or submits the form it opened (5). The app posts it
// (routes/interactions.js); it goes to the bot's gateway as INTERACTION_CREATE, and the bot must
// answer within 3 seconds (POST /interactions/:id/:token/callback, routes/botApi.js), else the
// person is told it didn't respond. The token then works for 15 minutes for follow-ups and
// editing the reply (/webhooks/:appId/:token, as Discord's).
//
// Ephemeral messages ("Only you can see this") are never stored for the channel: they live
// here in memory for 15 minutes (for edits and their components) and go only to the person's
// sockets (`guild_ephemeral_message` / `_edit` / `_delete`); their app keeps them until reload,
// as Discord does. Their ids are EPHEMERAL_ID_BASE + a counter (never a guild message's id).

const TYPE = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3, AUTOCOMPLETE: 4, MODAL_SUBMIT: 5 };
const CALLBACK = {
  CHANNEL_MESSAGE: 4, DEFERRED_CHANNEL_MESSAGE: 5, DEFERRED_UPDATE_MESSAGE: 6, UPDATE_MESSAGE: 7,
  AUTOCOMPLETE_RESULT: 8, MODAL: 9,
};
// Which answers each kind of interaction can have.
const ALLOWED_CALLBACKS = {
  [TYPE.APPLICATION_COMMAND]: [4, 5, 9],
  [TYPE.MESSAGE_COMPONENT]: [4, 5, 6, 7, 9],
  [TYPE.AUTOCOMPLETE]: [8],
  [TYPE.MODAL_SUBMIT]: [4, 5, 6, 7],
};
const RESPONSE_MS = 3000;
const TOKEN_MS = 15 * 60 * 1000;
const TOKEN_PREFIX = 'aW50ZXJhY3Rpb246'; // base64 of "interaction:", as Discord's tokens start
const EPHEMERAL_ID_BASE = 2 ** 52;
const LOADING = 1 << 7;

const now = () => Math.floor(Date.now() / 1000);
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const waiting = new Map(); // interaction id -> { resolve, timer } until the bot answers
const ephemeral = new Map(); // message id -> { message, userId, channel, interactionId, applicationId, at }
const modals = new Map(); // modal id -> { modal, applicationId, userId, channelId, guildId, messageId, at }
let ephemeralCounter = Date.now();

const isEphemeralId = (id) => Number(id) >= EPHEMERAL_ID_BASE;

function forget() {
  const old = Date.now() - TOKEN_MS;
  for (const [id, entry] of ephemeral) if (entry.at < old) ephemeral.delete(id);
  for (const [id, entry] of modals) if (entry.at < old) modals.delete(id);
}

// ---- What the bot is sent ----

async function botPermissions(botId, channel) {
  const access = await getChannelAccess(channel.id, botId);
  return access?.permissions ?? 0;
}

// The interaction object for the gateway (`data` is the type's own).
async function interactionPayload({ row, token, member, permissions, channel, data, message = null }) {
  const [memberObject] = await D.guildMembers(channel.guild_id, { userIds: [member.userId] });
  const overrides = channel.type === 'thread' ? [] : (await getOverrides({ channelIds: [channel.id] })).get(channel.id) ?? [];
  const full = await db.get('SELECT * FROM guild_channels WHERE id = ?', [channel.id]);
  return {
    id: String(row.id),
    application_id: String(row.application_id),
    type: row.type,
    data,
    guild: { id: String(channel.guild_id), locale: 'en-GB', features: [] },
    guild_id: String(channel.guild_id),
    channel: D.channelObject({ ...full, nsfw: channel.nsfw }, { everyoneRoleId: member.everyone.id, overrides }),
    channel_id: String(channel.id),
    member: { ...memberObject, permissions: D.toDiscordPermissions(permissions) },
    token,
    version: 1,
    ...(message ? { message } : {}),
    app_permissions: D.toDiscordPermissions(await botPermissions(row.application_id, channel)),
    locale: 'en-GB',
    guild_locale: 'en-GB',
    entitlements: [],
    authorizing_integration_owners: { 0: String(channel.guild_id) },
    context: 0,
    attachment_size_limit: await botUploadLimitBytes(),
  };
}

// Starts an interaction for `member` (a member context with `permissions` in `channel`) with
// the bot `applicationId`: stores it, delivers it, and resolves to the bot's answer
// ({ type, data }) or throws ActionError (504) if it didn't answer in time.
async function run({ type, applicationId, member, permissions, channel, data, message = null, messageId = null, commandName = null }) {
  forget();
  const token = `${TOKEN_PREFIX}${crypto.randomBytes(48).toString('base64url')}`;
  const commandType = type === TYPE.APPLICATION_COMMAND ? data.type : null;
  const targetId = data.target_id != null ? Number(data.target_id) : null;
  const { lastID } = await db.run(
    `INSERT INTO bot_interactions (application_id, token_hash, type, user_id, guild_id, channel_id, message_id, command_name, command_type, target_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [applicationId, hashToken(token), type, member.userId, channel.guild_id, channel.id, messageId, commandName, commandType, targetId, now()]
  );
  // Old interactions go now and then (their tokens are dead after 15 minutes).
  if (lastID % 100 === 0) await db.run('DELETE FROM bot_interactions WHERE created_at < ?', [now() - 24 * 60 * 60]);
  const row = await db.get('SELECT * FROM bot_interactions WHERE id = ?', [lastID]);
  const payload = await interactionPayload({ row, token, member, permissions, channel, data, message });
  const answer = new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(row.id);
      resolve(null);
    }, RESPONSE_MS);
    waiting.set(row.id, { resolve, timer });
  });
  if (!require('./gateway').deliverInteraction(applicationId, channel.guild_id, payload)) {
    clearTimeout(waiting.get(row.id)?.timer);
    waiting.delete(row.id);
    throw new ActionError(504, 'The application did not respond', 0);
  }
  const result = await answer;
  if (!result) throw new ActionError(504, 'The application did not respond', 0);
  return result;
}

// ---- Commands ----

// The option values for `definition` (a command's options) from `given` (Discord's shape, from
// the app), checked; collects mentioned ids into `resolved`. `focusedOk` (autocomplete) lets the
// focused option be anything typed so far and skips required checks.
async function checkOptions(definition, given, ctx, focusedOk) {
  if (given != null && !Array.isArray(given)) throw new ActionError(400, 'Invalid options');
  const list = given ?? [];
  const out = [];
  const sub = definition.filter((o) => o.type === commands.OPTION.SUB_COMMAND || o.type === commands.OPTION.SUB_COMMAND_GROUP);
  if (sub.length) {
    const [choice] = list;
    const spec = choice && sub.find((o) => o.name === choice.name && o.type === choice.type);
    if (!spec || list.length !== 1) throw new ActionError(400, 'Choose a subcommand');
    ctx.path.push(spec.name);
    return [{ name: spec.name, type: spec.type, options: await checkOptions(spec.options ?? [], choice.options, ctx, focusedOk) }];
  }
  for (const spec of definition) {
    const value = list.find((o) => o?.name === spec.name);
    if (!value) {
      if (spec.required && !focusedOk) throw new ActionError(400, `${spec.name} is required`);
      continue;
    }
    const option = { name: spec.name, type: spec.type };
    if (value.focused && focusedOk) {
      option.value = String(value.value ?? '').slice(0, 6000);
      option.focused = true;
      out.push(option);
      continue;
    }
    option.value = await checkValue(spec, value.value, ctx);
    out.push(option);
  }
  if (list.some((o) => !definition.some((s) => s.name === o?.name))) throw new ActionError(400, 'Unknown option');
  return out;
}

async function checkValue(spec, value, ctx) {
  const { OPTION } = commands;
  const bad = () => new ActionError(400, `Invalid value for ${spec.name}`);
  const fromChoices = (v) => {
    if (spec.choices && !spec.choices.some((c) => c.value === v)) throw bad();
    return v;
  };
  switch (spec.type) {
    case OPTION.STRING: {
      if (typeof value !== 'string' || !value.length) throw bad();
      if (value.length < (spec.min_length ?? 0) || value.length > (spec.max_length ?? 6000)) throw bad();
      return fromChoices(value);
    }
    case OPTION.INTEGER:
    case OPTION.NUMBER: {
      const n = Number(value);
      if (!Number.isFinite(n) || (spec.type === OPTION.INTEGER && !Number.isInteger(n))) throw bad();
      if ((spec.min_value != null && n < spec.min_value) || (spec.max_value != null && n > spec.max_value)) throw bad();
      return fromChoices(n);
    }
    case OPTION.BOOLEAN:
      if (typeof value !== 'boolean') throw bad();
      return value;
    case OPTION.USER:
      if (!(await addUser(ctx, value))) throw bad();
      return String(value);
    case OPTION.ROLE:
      if (!(await addRole(ctx, value))) throw bad();
      return String(value);
    case OPTION.MENTIONABLE:
      if (!(await addUser(ctx, value)) && !(await addRole(ctx, value))) throw bad();
      return String(value);
    case OPTION.CHANNEL:
      if (!(await addChannel(ctx, value, spec.channel_types))) throw bad();
      return String(value);
    case OPTION.ATTACHMENT: {
      const attachment = ctx.attachments?.[Number(value)];
      if (!attachment) throw bad();
      ctx.resolved.attachments ??= {};
      ctx.resolved.attachments[attachment.id] = attachment;
      return attachment.id;
    }
    default:
      throw bad();
  }
}

// Adds user `value` (anyone who shares the guild: a member) to `resolved`; false if there's none.
async function addUser(ctx, value) {
  const userId = D.ourId(value);
  if (userId == null) return false;
  const [member] = await D.guildMembers(ctx.guildId, { userIds: [userId] });
  if (!member) return false;
  const permissions = (await getChannelAccess(ctx.channel.id, userId))?.permissions ?? 0;
  ctx.resolved.users ??= {};
  ctx.resolved.members ??= {};
  ctx.resolved.users[member.user.id] = member.user;
  const { user, ...rest } = member;
  ctx.resolved.members[user.id] = { ...rest, permissions: D.toDiscordPermissions(permissions) };
  return true;
}

async function addRole(ctx, value) {
  const roleId = await D.roleIdFromDiscord(ctx.guildId, value);
  if (roleId == null) return false;
  const role = await db.get('SELECT * FROM guild_roles WHERE id = ?', [roleId]);
  ctx.resolved.roles ??= {};
  const object = D.roleObject(role, ctx.guildId);
  ctx.resolved.roles[object.id] = object;
  return true;
}

// A channel the person can see (a text or voice channel, thread or category), of an allowed type.
async function addChannel(ctx, value, channelTypes) {
  let object;
  let permissions = 0;
  if (D.isCategoryId(value)) {
    const category = await db.get('SELECT * FROM guild_categories WHERE id = ? AND guild_id = ?', [D.ourId(value, 'category'), ctx.guildId]);
    if (!category) return false;
    object = D.categoryObject(category, ctx.guildId);
  } else {
    const access = await getChannelAccess(D.ourId(value) ?? -1, ctx.member.userId);
    if (!access || access.channel.guild_id !== ctx.guildId || !D.isBotChannel(access.channel) || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) return false;
    const row = await db.get('SELECT * FROM guild_channels WHERE id = ?', [access.channel.id]);
    object = D.channelObject({ ...row, nsfw: access.channel.nsfw });
    permissions = access.permissions;
  }
  if (Array.isArray(channelTypes) && channelTypes.length && !channelTypes.includes(object.type)) return false;
  ctx.resolved.channels ??= {};
  ctx.resolved.channels[object.id] = {
    id: object.id, name: object.name, type: object.type, permissions: D.toDiscordPermissions(permissions),
    ...(object.parent_id ? { parent_id: object.parent_id } : {}),
    ...(object.thread_metadata ? { thread_metadata: object.thread_metadata } : {}),
  };
  return true;
}

// Someone (`member`, `permissions` in `access.channel`) uses command `commandId` with `options`
// (Discord's shape), or a context-menu command on `targetId`; `attachments` are the files given
// for attachment options (stored like webhook files). `autocomplete` asks for suggestions
// instead (one option is focused). Resolves to what the app shows: { ok } , { modal }, { choices }.
async function useCommand({ access, commandId, options, targetId, attachments = [], autocomplete = false }) {
  const { channel, member, permissions } = access;
  const row = await db.get('SELECT * FROM bot_commands WHERE id = ?', [Number(commandId)]);
  const usable = row && (row.guild_id === 0 || row.guild_id === channel.guild_id) && await getMember(channel.guild_id, row.application_id);
  if (!usable) throw new ActionError(404, 'Unknown command', 10063);
  if (!commands.mayUse(row, member, permissions, channel)) throw new ActionError(403, "You can't use this command here");
  const ctx = { guildId: channel.guild_id, channel, member, resolved: {}, attachments, path: [row.name] };
  const data = { id: String(row.id), name: row.name, type: row.type, ...(row.guild_id ? { guild_id: String(row.guild_id) } : {}) };
  if (row.type === commands.TYPES.CHAT_INPUT) {
    const definition = commands.parse(row.options, []);
    const checked = await checkOptions(definition, options, ctx, autocomplete);
    if (autocomplete && !JSON.stringify(checked).includes('"focused":true')) throw new ActionError(400, 'No option is focused');
    if (checked.length) data.options = checked;
  } else if (autocomplete) {
    throw new ActionError(400, 'Not a slash command');
  } else if (row.type === commands.TYPES.USER) {
    if (!(await addUser(ctx, targetId))) throw new ActionError(404, 'Unknown user', 10013);
    data.target_id = String(targetId);
  } else {
    const messageId = D.ourId(targetId);
    const target = messageId != null && await db.get(
      `${require('./routes/guildMessages').MESSAGE_SELECT} WHERE m.id = ? AND m.channel_id = ?`,
      [messageId, channel.id]
    );
    if (!target) throw new ActionError(404, 'Unknown message', 10008);
    const [object] = await D.messageObjects(await require('./routes/guildMessages').withReactions([target]), { botId: row.application_id });
    ctx.resolved.messages = { [object.id]: object };
    data.target_id = object.id;
  }
  if (Object.keys(ctx.resolved).length) data.resolved = ctx.resolved;
  const answer = await run({
    type: autocomplete ? TYPE.AUTOCOMPLETE : TYPE.APPLICATION_COMMAND,
    applicationId: row.application_id, member, permissions, channel, data,
    commandName: ctx.path.join(' '),
  });
  return answerForApp(answer);
}

// ---- Components ----

// The message a component was used on, with its components: a guild message (visible to the
// person) or one of their ephemeral ones. { message (app shape), channel, ephemeralEntry? }.
async function componentMessage(messageId, userId) {
  if (isEphemeralId(messageId)) {
    const entry = ephemeral.get(Number(messageId));
    if (!entry || entry.userId !== userId) throw new ActionError(404, 'Unknown message', 10008);
    return { message: entry.message, channelId: entry.channel.id, entry };
  }
  const { MESSAGE_SELECT, withReactions } = require('./routes/guildMessages');
  const row = await db.get(`${MESSAGE_SELECT} WHERE m.id = ?`, [Number(messageId)]);
  if (!row) throw new ActionError(404, 'Unknown message', 10008);
  const [message] = await withReactions([row]);
  return { message, channelId: row.channel_id };
}

// Checks a select's chosen `values` against `component`, collecting what they name.
async function checkSelect(component, values, ctx) {
  if (!Array.isArray(values) || values.length < (component.min_values ?? 1) || values.length > (component.max_values ?? 1)) {
    throw new ActionError(400, 'Invalid selection');
  }
  if (new Set(values).size !== values.length) throw new ActionError(400, 'Invalid selection');
  const bad = () => new ActionError(400, 'Invalid selection');
  for (const value of values) {
    if (component.type === C.TYPE.STRING_SELECT) {
      if (!component.options.some((o) => o.value === value)) throw bad();
    } else if (component.type === C.TYPE.USER_SELECT) {
      if (!(await addUser(ctx, value))) throw bad();
    } else if (component.type === C.TYPE.ROLE_SELECT) {
      if (!(await addRole(ctx, value))) throw bad();
    } else if (component.type === C.TYPE.MENTIONABLE_SELECT) {
      if (!(await addUser(ctx, value)) && !(await addRole(ctx, value))) throw bad();
    } else if (component.type === C.TYPE.CHANNEL_SELECT) {
      if (!(await addChannel(ctx, value, component.channel_types))) throw bad();
    }
  }
  return values.map(String);
}

// Someone clicks button `customId` (or chooses `values` in that select) on message `messageId`.
async function useComponent({ userId, messageId, customId, values }) {
  const { message, channelId } = await componentMessage(messageId, userId);
  const access = await getChannelAccess(channelId, userId);
  if (!access || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) throw new ActionError(404, 'Unknown message', 10008);
  if (!message.sender_bot && !message.ephemeral) throw new ActionError(400, 'Not a bot message');
  const component = C.findComponent(message.components, customId);
  if (!component || component.disabled || component.style === C.BUTTON_STYLE.LINK) throw new ActionError(400, 'Unknown component', 10100);
  const applicationId = message.sender_id;
  if (!(await getMember(access.channel.guild_id, applicationId))) throw new ActionError(404, 'Unknown application', 10002);
  const ctx = { guildId: access.channel.guild_id, channel: access.channel, member: access.member, resolved: {} };
  const data = { custom_id: customId, component_type: component.type };
  if (C.SELECTS.includes(component.type)) {
    data.values = await checkSelect(component, values, ctx);
    if (Object.keys(ctx.resolved).length) data.resolved = ctx.resolved;
  }
  const [messageObject] = await D.messageObjects([message], { botId: applicationId });
  const answer = await run({
    type: TYPE.MESSAGE_COMPONENT, applicationId, member: access.member, permissions: access.permissions,
    channel: access.channel, data, message: messageObject, messageId: message.id,
  });
  return answerForApp(answer);
}

// ---- Forms ----

// The person submits form `modalId` (opened for them) with `answers` ({ [custom_id]: value }).
async function submitModal({ userId, modalId, answers }) {
  forget();
  const entry = modals.get(String(modalId));
  if (!entry || entry.userId !== userId) throw new ActionError(404, 'This form has expired', 10062);
  const access = await getChannelAccess(entry.channelId, userId);
  if (!access || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) throw new ActionError(404, 'Unknown channel', 10003);
  const components = C.modalSubmission(entry.modal, answers);
  if (!components) throw new ActionError(400, 'Fill in the form');
  modals.delete(String(modalId));
  let message = null;
  if (entry.messageId) {
    const source = await componentMessage(entry.messageId, userId).catch(() => null);
    if (source) [message] = await D.messageObjects([source.message], { botId: entry.applicationId });
  }
  const answer = await run({
    type: TYPE.MODAL_SUBMIT, applicationId: entry.applicationId, member: access.member, permissions: access.permissions,
    channel: access.channel, data: { custom_id: entry.modal.custom_id, components }, message, messageId: entry.messageId,
  });
  return answerForApp(answer);
}

// What the app is told once the bot answered (its message, if any, came by socket).
function answerForApp({ type, data }) {
  if (type === CALLBACK.MODAL) return { modal: data };
  if (type === CALLBACK.AUTOCOMPLETE_RESULT) return { choices: data };
  return { ok: true };
}

// ---- The bot's answers ----

// Loads the interaction `id` if `token` is its own; resolves to its row (with `expired` once
// the token is older than 15 minutes) or null.
async function findInteraction(id, token) {
  const row = /^\d+$/.test(String(id)) && await db.get('SELECT * FROM bot_interactions WHERE id = ?', [Number(id)]);
  if (!row) return null;
  const a = Buffer.from(row.token_hash, 'hex');
  const b = Buffer.from(hashToken(String(token)), 'hex');
  if (!crypto.timingSafeEqual(a, b)) return null;
  return { ...row, expired: Date.now() - row.created_at * 1000 > TOKEN_MS };
}

async function interactionByToken(applicationId, token) {
  if (!String(token).startsWith(TOKEN_PREFIX)) return null;
  const row = await db.get('SELECT * FROM bot_interactions WHERE application_id = ? AND token_hash = ?', [applicationId, hashToken(String(token))]);
  if (!row) return null;
  return { ...row, expired: Date.now() - row.created_at * 1000 > TOKEN_MS };
}

// The interaction's metadata kept on its messages (discord.js shows "<user> used /<name>").
function metadataFor(row, extra = {}) {
  return {
    id: row.id,
    type: row.type,
    user_id: row.user_id,
    guild_id: row.guild_id,
    ...(row.command_name ? { name: row.command_name } : {}),
    ...(row.command_type ? { command_type: row.command_type } : {}),
    ...(row.target_id ? { target_id: row.target_id } : {}),
    ...(row.type === TYPE.MESSAGE_COMPONENT && row.message_id ? { interacted_message_id: row.message_id } : {}),
    ...extra,
  };
}

async function channelFor(row) {
  const access = await getChannelAccess(row.channel_id, row.application_id);
  const channel = access?.channel ?? await db.get('SELECT id, guild_id, name, type, nsfw FROM guild_channels WHERE id = ?', [row.channel_id]);
  if (!channel) throw new ActionError(404, 'Unknown Channel', 10003);
  return { channel, permissions: access?.permissions ?? 0 };
}

// An ephemeral message, as the app draws a message (sender the bot), kept for 15 minutes.
async function storeEphemeral(row, channel, built, { loading = false, extra = {} } = {}) {
  const bot = await db.get('SELECT username, display_name, avatar FROM users WHERE id = ?', [row.application_id]);
  const message = {
    id: EPHEMERAL_ID_BASE + ++ephemeralCounter,
    channel_id: channel.id,
    sender_id: row.application_id,
    sender_username: bot?.username,
    sender_display_name: bot?.display_name,
    sender_avatar: bot?.avatar,
    sender_bot: 1,
    content: built.content ?? '',
    embeds: built.embeds ?? [],
    attachments: built.attachments ?? [],
    components: built.components ?? [],
    flags: (built.flags ?? 0) | (loading ? LOADING : 0),
    timestamp: now(),
    edited: 0,
    edited_at: null,
    reactions: [],
    mention_roles: [],
    mention_everyone: 0,
    interaction: metadataFor(row, extra),
    ephemeral: true,
  };
  ephemeral.set(message.id, { message, userId: row.user_id, channel, interactionId: row.id, applicationId: row.application_id, at: Date.now() });
  sendToUserSockets(row.user_id, { type: 'guild_ephemeral_message', guildId: channel.guild_id, channelId: channel.id, message });
  return message;
}

function editEphemeral(entry, built) {
  Object.assign(entry.message, {
    content: built.content ?? entry.message.content,
    embeds: built.embeds ?? entry.message.embeds,
    attachments: built.attachments ?? entry.message.attachments,
    components: built.components ?? entry.message.components,
    flags: (built.flags ?? entry.message.flags) & ~LOADING,
    edited: 1,
    edited_at: now(),
  });
  sendToUserSockets(entry.userId, { type: 'guild_ephemeral_edit', guildId: entry.channel.guild_id, channelId: entry.channel.id, message: entry.message });
  return entry.message;
}

function deleteEphemeral(id) {
  const entry = ephemeral.get(Number(id));
  if (!entry) return false;
  ephemeral.delete(Number(id));
  sendToUserSockets(entry.userId, { type: 'guild_ephemeral_delete', guildId: entry.channel.guild_id, channelId: entry.channel.id, messageId: Number(id) });
  return true;
}

// Posts a reply or follow-up for interaction `row`: `built` from botMessages.readNewMessage
// (with `ephemeral`); `loading` for a "thinking…" placeholder. Resolves to the message (app shape).
async function postMessage(row, built, { loading = false, followup = false } = {}) {
  const { channel, permissions } = await channelFor(row);
  const extra = followup && row.response_message_id ? { original_response_message_id: row.response_message_id } : {};
  if (built.ephemeral) return storeEphemeral(row, channel, built, { loading, extra });
  const { createMessage } = require('./routes/guildMessages');
  return createMessage({
    channel,
    permissions,
    senderId: row.application_id,
    content: built.content ?? '',
    embeds: built.embeds ?? [],
    attachments: built.attachments ?? [],
    components: built.components ?? [],
    flags: (built.flags ?? 0) | (loading ? LOADING : 0),
    allowed: built.allowed,
    interaction: metadataFor(row, extra),
    silent: Boolean((built.flags ?? 0) & (1 << 12)) || loading,
  });
}

// Edits a message of interaction `row` (`messageId`: a guild message it made, its component's
// message for UPDATE_MESSAGE, or an ephemeral one) with `req`'s body. Resolves to the message.
async function editMessage(row, messageId, req) {
  const botMessages = require('./botMessages');
  if (isEphemeralId(messageId)) {
    const entry = ephemeral.get(Number(messageId));
    if (!entry || entry.applicationId !== row.application_id) throw new ActionError(404, 'Unknown Message', 10008);
    return editEphemeral(entry, await readOrEmpty(() => botMessages.readEdit(req, entry.message)));
  }
  const old = await db.get('SELECT * FROM guild_messages WHERE id = ? AND sender_id = ?', [Number(messageId), row.application_id]);
  if (!old) throw new ActionError(404, 'Unknown Message', 10008);
  const { channel, permissions } = await channelFor({ ...row, channel_id: old.channel_id });
  const edit = await readOrEmpty(() => botMessages.readEdit(req, old));
  return botMessages.saveEdit(old.id, channel, row.application_id, permissions, edit);
}

async function readOrEmpty(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.empty) throw new ActionError(400, 'Cannot send an empty message', 50006);
    throw err;
  }
}

// The bot's callback (POST /interactions/:id/:token/callback): checks it's the first answer,
// in time, and of a kind this interaction can have; does what it says; tells whoever is
// waiting. Resolves to { message } (app shape, for with_response) or {}.
async function callback(row, req) {
  const body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
  const pending = waiting.get(row.id);
  if (row.response_type != null) throw new ActionError(400, 'Interaction has already been acknowledged.', 40060);
  if (!pending) throw new ActionError(404, 'Unknown interaction', 10062);
  // Multipart bodies carry the type inside payload_json.
  const { readBody } = require('./routes/webhooks');
  const { body: full } = req.is('multipart/form-data') ? await readBody(req) : { body };
  const type = Number(full.type);
  if (!ALLOWED_CALLBACKS[row.type]?.includes(type)) {
    throw new ActionError(400, 'Interaction callback type is not valid here', 50035);
  }
  const botMessages = require('./botMessages');
  let result = {};
  const appAnswer = { type, data: null };
  if (type === CALLBACK.CHANNEL_MESSAGE) {
    const built = await readOrEmpty(() => withData(req, full, () => botMessages.readNewMessage(req, { allowEphemeral: true })));
    const message = await postMessage(row, built);
    await markResponded(row, type, message.id);
    result = { message };
  } else if (type === CALLBACK.DEFERRED_CHANNEL_MESSAGE) {
    const flags = Number(full.data?.flags ?? 0);
    const message = await postMessage(row, { content: '', ephemeral: Boolean(flags & botMessages.EPHEMERAL) }, { loading: true });
    await markResponded(row, type, message.id);
    result = { message };
  } else if (type === CALLBACK.DEFERRED_UPDATE_MESSAGE) {
    await markResponded(row, type, null);
  } else if (type === CALLBACK.UPDATE_MESSAGE) {
    if (!row.message_id) throw new ActionError(400, 'Interaction callback type is not valid here', 50035);
    const message = await withData(req, full, () => editMessage(row, row.message_id, req));
    await markResponded(row, type, null);
    result = { message };
  } else if (type === CALLBACK.AUTOCOMPLETE_RESULT) {
    const choices = full.data?.choices;
    if (!Array.isArray(choices) || choices.length > 25) throw new ActionError(400, 'Invalid choices', 50035);
    appAnswer.data = choices.map((c) => ({ name: String(c?.name ?? '').slice(0, 100), value: c?.value })).filter((c) => c.name && c.value != null);
    await markResponded(row, type, null);
  } else if (type === CALLBACK.MODAL) {
    const modal = C.cleanModal(full.data);
    const modalId = crypto.randomBytes(12).toString('base64url');
    modals.set(modalId, {
      modal, applicationId: row.application_id, userId: row.user_id, channelId: row.channel_id, guildId: row.guild_id,
      messageId: row.type === TYPE.MESSAGE_COMPONENT ? row.message_id : null, at: Date.now(),
    });
    const bot = await db.get('SELECT username, display_name, avatar FROM users WHERE id = ?', [row.application_id]);
    appAnswer.data = { id: modalId, ...modal, bot: { id: row.application_id, name: bot?.display_name || bot?.username, avatar: bot?.avatar } };
    await markResponded(row, type, null);
  }
  clearTimeout(pending.timer);
  waiting.delete(row.id);
  pending.resolve(appAnswer);
  return result;
}

// Runs `fn` with the request's body being the callback's `data` (where Discord puts the
// message), multipart included (payload_json's `data`, files alongside).
async function withData(req, full, fn) {
  if (!req.is('multipart/form-data')) {
    req.body = full.data ?? {};
    return fn();
  }
  // readBody reads payload_json: give it the inner data instead.
  const raw = req.body;
  const form = await new Response(raw, { headers: { 'content-type': req.get('content-type') } }).formData();
  const rebuilt = new FormData();
  for (const [name, value] of form) {
    if (name === 'payload_json') rebuilt.set('payload_json', JSON.stringify(full.data ?? {}));
    else rebuilt.append(name, value);
  }
  const encoded = new Response(rebuilt);
  req.body = Buffer.from(await encoded.arrayBuffer());
  const type = encoded.headers.get('content-type');
  const get = req.get.bind(req);
  req.get = (name) => (String(name).toLowerCase() === 'content-type' ? type : get(name));
  return fn();
}

async function markResponded(row, type, messageId) {
  await db.run('UPDATE bot_interactions SET response_type = ?, response_message_id = ? WHERE id = ?', [type, messageId, row.id]);
  row.response_type = type;
  row.response_message_id = messageId;
}

// ---- Follow-ups and the original reply (the interaction's webhook) ----

// The messages interaction `row` may touch: its reply (@original) and follow-ups.
async function interactionMessage(row, messageId) {
  const id = messageId === '@original' ? row.response_message_id : D.ourId(messageId);
  if (id == null) throw new ActionError(404, 'Unknown Message', 10008);
  if (isEphemeralId(id)) {
    const entry = ephemeral.get(Number(id));
    if (!entry || entry.interactionId !== row.id) throw new ActionError(404, 'Unknown Message', 10008);
    return { id, ephemeral: entry };
  }
  const message = await db.get('SELECT id, channel_id, sender_id, interaction, content, timestamp, system, webhook_id, webhook_name FROM guild_messages WHERE id = ?', [id]);
  const meta = message && commands.parse(message.interaction, null);
  if (!message || message.sender_id !== row.application_id || meta?.id !== row.id) throw new ActionError(404, 'Unknown Message', 10008);
  return { id, message };
}

// A message (app shape) of this interaction as the bot sees it.
async function messageForBot(row, found) {
  if (found.ephemeral) return (await D.messageObjects([found.ephemeral.message], { botId: row.application_id }))[0];
  const { MESSAGE_SELECT, withReactions } = require('./routes/guildMessages');
  const [message] = await withReactions([await db.get(`${MESSAGE_SELECT} WHERE m.id = ?`, [found.id])]);
  return (await D.messageObjects([message], { botId: row.application_id }))[0];
}

// Edits the reply or a follow-up. A "thinking…" reply becomes the message.
async function editInteractionMessage(row, messageId, req) {
  const found = await interactionMessage(row, messageId);
  return editMessage(row, found.id, req);
}

async function deleteInteractionMessage(row, messageId) {
  const found = await interactionMessage(row, messageId);
  if (found.ephemeral) return deleteEphemeral(found.id);
  const { channel } = await channelFor({ ...row, channel_id: found.message.channel_id });
  const { deleteMessage } = require('./routes/guildMessages');
  await deleteMessage(found.message, channel, row.application_id, 0);
  return true;
}

module.exports = {
  TYPE,
  CALLBACK,
  TOKEN_PREFIX,
  EPHEMERAL_ID_BASE,
  isEphemeralId,
  useCommand,
  useComponent,
  submitModal,
  findInteraction,
  interactionByToken,
  callback,
  postMessage,
  interactionMessage,
  messageForBot,
  editInteractionMessage,
  deleteInteractionMessage,
  dismissEphemeral: (userId, id) => {
    const entry = ephemeral.get(Number(id));
    if (entry && entry.userId === userId) ephemeral.delete(Number(id));
  },
};
