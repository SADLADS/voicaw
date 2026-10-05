const db = require('./db');
const { s3Endpoint } = require('./config');
const { PERMISSIONS: P, ALL_PERMISSIONS } = require('./permissions');
const { parseMentions } = require('./mentions');

// Our guilds, channels, members, roles and messages as Discord's API shows them, for the bot
// API (routes/botApi.js) and the gateway (gateway.js); docs/bots.md.
// - Ids are ours, as decimal strings, so the ids in the app and the API are the same, with two
//   exceptions Discord's libraries need: a guild's @everyone role has the guild's id (role ids
//   always run ahead of guild ids, so no other role of the guild can have it), and categories
//   (a table of their own) are CATEGORY_ID_BASE + their id, so they can't clash with channels.
//   Our ids aren't snowflakes: a library's "created at" from an id is meaningless.
// - Permissions are Discord's bits (decimal strings). Ours each have one; Discord's that we
//   don't have are implied by the nearest of ours (Read Message History by View Channel, Embed
//   Links and Attach Files by Send Messages...). Edit Tasks and Create Documents are ours only.
// - Channels: text (0), voice (2), category (4) and threads (11). List and document channels
//   aren't in the bot API.

const CATEGORY_ID_BASE = 2 ** 40;

const CHANNEL_TYPES = { text: 0, voice: 2, category: 4, thread: 11 };
const isBotChannel = (channel) => channel && Object.hasOwn(CHANNEL_TYPES, channel.type) && channel.type !== 'category';

// Ours -> Discord's bit numbers: the first is the one it stands for, the rest are implied.
const PERMISSION_BITS = [
  [P.CREATE_INVITE, [0]],
  [P.KICK_MEMBERS, [1]],
  [P.BAN_MEMBERS, [2]],
  [P.ADMINISTRATOR, [3]],
  [P.MANAGE_CHANNELS, [4]],
  [P.MANAGE_GUILD, [5]],
  [P.ADD_REACTIONS, [6]],
  [P.VIEW_AUDIT_LOG, [7]],
  [P.STREAM, [9]],
  [P.VIEW_CHANNEL, [10, 16]], // + Read Message History
  [P.SEND_MESSAGES, [11, 14, 15, 18, 31]], // + Embed Links, Attach Files, Use External Emoji, Use Application Commands
  [P.MANAGE_MESSAGES, [13]],
  [P.MENTION_EVERYONE, [17]],
  [P.CONNECT, [20]],
  [P.SPEAK, [21, 25]], // + Use Voice Activity
  [P.MANAGE_ROLES, [28]],
  [P.MANAGE_WEBHOOKS, [29]],
  [P.MANAGE_EMOJIS, [30, 43]], // Manage (and Create) Guild Expressions
  [P.CREATE_THREADS, [35]], // Create Public Threads
  [P.SEND_MESSAGES_IN_THREADS, [38]],
  [P.PIN_MESSAGES, [51]],
  [P.EDIT_TASKS, [56]], // ours only
  [P.CREATE_DOCUMENTS, [57]], // ours only
  [P.QUEUE_VIDEOS, [58]], // ours only
  [P.MANAGE_QUEUE, [59]], // ours only
  [P.CONTROL_PLAYBACK, [60]], // ours only
  [P.LISTEN, [61]], // ours only: hear the others in voice
];
const DISCORD_PERMISSIONS = Object.fromEntries([
  ['CREATE_INSTANT_INVITE', 0], ['KICK_MEMBERS', 1], ['BAN_MEMBERS', 2], ['ADMINISTRATOR', 3], ['MANAGE_CHANNELS', 4],
  ['MANAGE_GUILD', 5], ['ADD_REACTIONS', 6], ['VIEW_AUDIT_LOG', 7], ['STREAM', 9], ['VIEW_CHANNEL', 10],
  ['SEND_MESSAGES', 11], ['MANAGE_MESSAGES', 13], ['EMBED_LINKS', 14], ['ATTACH_FILES', 15], ['READ_MESSAGE_HISTORY', 16],
  ['MENTION_EVERYONE', 17], ['USE_EXTERNAL_EMOJIS', 18], ['CONNECT', 20], ['SPEAK', 21], ['USE_VAD', 25],
  ['MANAGE_ROLES', 28], ['MANAGE_WEBHOOKS', 29], ['MANAGE_GUILD_EXPRESSIONS', 30], ['USE_APPLICATION_COMMANDS', 31],
  ['CREATE_PUBLIC_THREADS', 35], ['SEND_MESSAGES_IN_THREADS', 38], ['CREATE_GUILD_EXPRESSIONS', 43], ['PIN_MESSAGES', 51],
  ['VOICAW_EDIT_TASKS', 56], ['VOICAW_CREATE_DOCUMENTS', 57],
  ['VOICAW_QUEUE_VIDEOS', 58], ['VOICAW_MANAGE_QUEUE', 59], ['VOICAW_CONTROL_PLAYBACK', 60],
  ['VOICAW_LISTEN', 61],
].map(([name, bit]) => [name, 1n << BigInt(bit)]));

function toDiscordPermissions(bits) {
  let result = 0n;
  for (const [ours, theirs] of PERMISSION_BITS) {
    if ((bits & ours) === ours) for (const bit of theirs) result |= 1n << BigInt(bit);
  }
  return result.toString();
}

// Discord's bitfield (a decimal string or a number) as ours: only the bits that stand for one
// of ours count. Throws on anything that isn't a bitfield.
function fromDiscordPermissions(value) {
  if (typeof value === 'number' ? !Number.isSafeInteger(value) || value < 0 : !/^\d{1,20}$/.test(String(value))) {
    throw new Error('Invalid permissions');
  }
  const big = BigInt(value);
  let bits = 0;
  for (const [ours, [bit]] of PERMISSION_BITS) if (big & (1n << BigInt(bit))) bits |= ours;
  return bits & ALL_PERMISSIONS;
}

// ---- Ids ----

const id = (value) => (value == null ? null : String(value));
const categoryId = (catId) => (catId == null ? null : String(CATEGORY_ID_BASE + catId));

// A Discord id from a request as our number, or null. `kind` 'category' undoes the offset.
function ourId(value, kind = null) {
  if (!/^\d{1,20}$/.test(String(value ?? ''))) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return null;
  if (kind === 'category') return n > CATEGORY_ID_BASE ? n - CATEGORY_ID_BASE : null;
  return n;
}
const isCategoryId = (value) => (ourId(value) ?? 0) > CATEGORY_ID_BASE;

const iso = (unix) => (unix == null ? null : new Date(Number(unix) * 1000).toISOString());

// ---- Users and members ----

const avatarUrlOf = (user) => (user.avatar ? `${s3Endpoint}/profile-pics/${user.id}/${user.avatar}.webp` : null);

// `user` is a users row (id, username, display_name, avatar, bot). A bot's username is
// "Name#1234" in Discord's old style: its application's name and a discriminator.
function userObject(user) {
  const bot = Boolean(user.bot);
  const discriminator = bot ? String(user.username).split('#').pop() : '0';
  return {
    id: id(user.id),
    username: bot ? (user.display_name || user.username) : user.username,
    discriminator,
    global_name: bot ? null : (user.display_name ?? null),
    avatar: user.avatar ?? null,
    bot,
    system: false,
    public_flags: 0,
    flags: 0,
    banner: null,
    accent_color: null,
    avatar_decoration_data: null,
    avatar_url: avatarUrlOf(user), // ours: the picture's address
  };
}

const USER_COLUMNS = 'u.id, u.username, u.display_name, u.avatar, u.bot';

// A member without `user` (as in MESSAGE_CREATE) or with it. `roleIds` without @everyone.
function memberObject({ user, joinedAt, roleIds }, { withUser = true } = {}) {
  return {
    ...(withUser ? { user: userObject(user) } : {}),
    nick: null,
    avatar: null,
    banner: null,
    roles: roleIds.map(String),
    joined_at: iso(joinedAt),
    premium_since: null,
    deaf: false,
    mute: false,
    flags: 0,
    pending: false,
    communication_disabled_until: null,
  };
}

// Members of `guildId` as Discord member objects: all of them, or those in `userIds`.
async function guildMembers(guildId, { userIds = null, query = null, limit = 1000, after = 0 } = {}) {
  const where = ['gm.guild_id = ?', 'gm.user_id > ?'];
  const params = [guildId, after];
  if (userIds) {
    where.push(`gm.user_id IN (${userIds.map(() => '?').join(',') || 'NULL'})`);
    params.push(...userIds);
  }
  if (query) {
    where.push("(u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')");
    const like = `${String(query).replace(/[\\%_]/g, '\\$&')}%`;
    params.push(like, like);
  }
  const rows = await db.all(
    `SELECT ${USER_COLUMNS}, gm.joined_at FROM guild_members gm JOIN users u ON u.id = gm.user_id
     WHERE ${where.join(' AND ')} ORDER BY gm.user_id LIMIT ?`,
    [...params, limit]
  );
  if (!rows.length) return [];
  const roleRows = await db.all(
    `SELECT user_id, role_id FROM guild_member_roles WHERE guild_id = ? AND user_id IN (${rows.map(() => '?').join(',')})`,
    [guildId, ...rows.map((r) => r.id)]
  );
  const roles = new Map(rows.map((r) => [r.id, []]));
  for (const r of roleRows) roles.get(r.user_id).push(r.role_id);
  return rows.map((row) => memberObject({ user: row, joinedAt: row.joined_at, roleIds: roles.get(row.id) }));
}

// ---- Roles, emoji, channels, guilds ----

function roleObject(role, guildId) {
  return {
    id: id(role.is_everyone ? guildId : role.id),
    name: role.name,
    color: role.color ?? 0,
    colors: { primary_color: role.color ?? 0, secondary_color: null, tertiary_color: null },
    hoist: Boolean(role.hoist),
    icon: null,
    unicode_emoji: null,
    position: role.position,
    permissions: toDiscordPermissions(role.permissions),
    managed: Boolean(role.bot_id),
    mentionable: Boolean(role.mentionable),
    flags: 0,
    ...(role.bot_id ? { tags: { bot_id: id(role.bot_id) } } : {}),
  };
}

// A role id from a request as ours: the guild's id means @everyone.
async function roleIdFromDiscord(guildId, value) {
  const n = ourId(value);
  if (n == null) return null;
  if (n === guildId) return (await db.get('SELECT id FROM guild_roles WHERE guild_id = ? AND is_everyone = 1', [guildId]))?.id ?? null;
  return (await db.get('SELECT id FROM guild_roles WHERE guild_id = ? AND id = ? AND is_everyone = 0', [guildId, n]))?.id ?? null;
}

function emojiObject(emoji) {
  return {
    id: id(emoji.id),
    name: emoji.name,
    roles: [],
    require_colons: true,
    managed: false,
    animated: Boolean(emoji.animated),
    available: emoji.available === undefined ? true : Boolean(emoji.available),
  };
}

function overwriteObject(o, guildId, everyoneRoleId) {
  const target = o.target_type === 'role' && o.target_id === everyoneRoleId ? guildId : o.target_id;
  return {
    id: id(target),
    type: o.target_type === 'role' ? 0 : 1,
    allow: toDiscordPermissions(o.allow),
    deny: toDiscordPermissions(o.deny),
  };
}

// `channel` a guild_channels row; `context` { everyoneRoleId, overrides (its rows), lastMessageId }.
function channelObject(channel, { everyoneRoleId, overrides = [], lastMessageId = null } = {}) {
  const guildId = channel.guild_id;
  const base = {
    id: id(channel.id),
    type: CHANNEL_TYPES[channel.type],
    guild_id: id(guildId),
    name: channel.name,
    flags: 0,
  };
  if (channel.type === 'thread') {
    const archivedAt = channel.archived ? (channel.last_activity ?? channel.created_at) : (channel.last_activity ?? channel.created_at);
    return {
      ...base,
      parent_id: id(channel.parent_id),
      owner_id: id(channel.owner_id),
      last_message_id: id(lastMessageId),
      rate_limit_per_user: 0,
      message_count: channel.message_count ?? 0,
      total_message_sent: channel.message_count ?? 0,
      member_count: channel.member_count ?? 0,
      thread_metadata: {
        archived: Boolean(channel.archived),
        auto_archive_duration: 10080,
        archive_timestamp: iso(archivedAt ?? 0),
        locked: false,
        create_timestamp: iso(channel.created_at),
      },
    };
  }
  const shared = {
    ...base,
    position: channel.position ?? 0,
    permission_overwrites: overrides.map((o) => overwriteObject(o, guildId, everyoneRoleId)),
    parent_id: categoryId(channel.category_id),
    nsfw: Boolean(channel.nsfw),
  };
  if (channel.type === 'voice') {
    return { ...shared, bitrate: 64000, user_limit: 0, rtc_region: null, video_quality_mode: 1, last_message_id: null, rate_limit_per_user: 0 };
  }
  return { ...shared, topic: channel.topic ?? null, last_message_id: id(lastMessageId), rate_limit_per_user: 0, default_auto_archive_duration: 10080 };
}

function categoryObject(category, guildId) {
  return {
    id: categoryId(category.id),
    type: CHANNEL_TYPES.category,
    guild_id: id(guildId),
    name: category.name,
    position: category.position ?? 0,
    permission_overwrites: [],
    parent_id: null,
    nsfw: false,
    flags: 0,
  };
}

const guildIconHash = (guild) => (guild.icon_version > 0 ? `v${guild.icon_version}` : null);

// The guild's own fields (no channels or members).
function guildObject(guild, { roles, emojis }) {
  return {
    id: id(guild.id),
    name: guild.name,
    icon: guildIconHash(guild),
    icon_hash: guildIconHash(guild),
    splash: null,
    discovery_splash: null,
    owner_id: id(guild.owner),
    afk_channel_id: null,
    afk_timeout: 300,
    widget_enabled: false,
    widget_channel_id: null,
    verification_level: 0,
    default_message_notifications: 1,
    explicit_content_filter: 0,
    roles: roles.map((r) => roleObject(r, guild.id)),
    emojis: emojis.map(emojiObject),
    features: [],
    mfa_level: 0,
    application_id: null,
    system_channel_id: null,
    system_channel_flags: 0,
    rules_channel_id: null,
    max_presences: null,
    max_members: 500000,
    vanity_url_code: null,
    description: null,
    banner: null,
    premium_tier: 0,
    premium_subscription_count: 0,
    preferred_locale: 'en-GB',
    public_updates_channel_id: null,
    max_video_channel_users: 25,
    max_stage_video_channel_users: 0,
    nsfw_level: 0,
    stickers: [],
    premium_progress_bar_enabled: false,
    safety_alerts_channel_id: null,
    incidents_data: null,
    icon_url: guild.icon_version > 0 ? `${s3Endpoint}/guild-icons/${guild.id}?v=${guild.icon_version}` : null, // ours
  };
}

// ---- Messages ----

// A reaction's emoji as Discord's { id, name }: Unicode, or a custom emoji `<:name:id>`.
function reactionEmoji(text) {
  const custom = /^<a?:([A-Za-z0-9_]{2,32}):(\d+)>$/.exec(text);
  return custom ? { id: custom[2], name: custom[1], animated: text.startsWith('<a:') } : { id: null, name: text };
}

// Discord's emoji in a URL ("😀", "name:id" or "name") as our reaction text, or null.
async function reactionText(value) {
  const text = decodeURIComponent(String(value ?? ''));
  const custom = /^<?a?:?([A-Za-z0-9_]{2,32}):(\d+)>?$/.exec(text);
  if (custom) {
    const emoji = await db.get('SELECT id, name FROM guild_emojis WHERE id = ?', [Number(custom[2])]);
    return emoji ? `<:${emoji.name}:${emoji.id}>` : null;
  }
  if (!text || text.length > 64 || /\s/.test(text)) return null;
  return text;
}

function reactionsObject(reactions, botId) {
  const groups = new Map();
  for (const r of reactions ?? []) {
    if (!groups.has(r.emoji)) groups.set(r.emoji, { count: 0, me: false });
    const g = groups.get(r.emoji);
    g.count += 1;
    if (r.user_id === botId) g.me = true;
  }
  return [...groups].map(([emoji, g]) => ({
    count: g.count,
    count_details: { burst: 0, normal: g.count },
    me: g.me,
    me_burst: false,
    burst_me: false,
    burst_count: 0,
    burst_colors: [],
    emoji: reactionEmoji(emoji),
  }));
}

// A voice state (voice.js's public state, null when they left) as Discord's. `listening` is
// ours: whether they hear the others (Listen).
function voiceStateObject({ guildId, channelId, userId, state, member = null }) {
  return {
    guild_id: id(guildId),
    channel_id: state ? id(channelId) : null,
    user_id: id(userId),
    ...(member ? { member } : {}),
    session_id: '',
    deaf: false,
    mute: false,
    self_deaf: Boolean(state?.self_deaf),
    self_mute: Boolean(state?.self_mute),
    self_stream: Boolean(state?.self_stream),
    self_video: false,
    suppress: false,
    request_to_speak_timestamp: null,
    ...(state ? { listening: state.listening !== false } : {}),
  };
}

const MESSAGE_TYPES = { default: 0, reply: 19, thread: 18, poll_end: 46 };

// Messages (rows from guildMessages' MESSAGE_SELECT, after withReactions) as Discord's, seen by
// bot `botId`. `guildId` adds guild_id (and `member` for authors who are still members), as
// in gateway events; `references` adds the replied-to message.
async function messageObjects(rows, { botId = null, guildId = null, references = true } = {}) {
  if (!rows.length) return [];
  const userIds = new Set();
  const mentionIds = new Map();
  for (const m of rows) {
    if (!m.webhook_id && m.sender_id) userIds.add(m.sender_id);
    const ids = [...parseMentions(m.content).userIds];
    mentionIds.set(m.id, ids);
    for (const u of ids) userIds.add(u);
  }
  const users = userIds.size
    ? await db.all(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id IN (${[...userIds].map(() => '?').join(',')})`, [...userIds])
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));
  const interactionUserIds = [...new Set(rows.map((m) => m.interaction?.user_id).filter(Boolean))];
  const interactionUsers = new Map((interactionUserIds.length
    ? await db.all(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id IN (${interactionUserIds.map(() => '?').join(',')})`, interactionUserIds)
    : []).map((u) => [u.id, u]));
  const members = guildId ? new Map((await guildMembers(guildId, { userIds: [...userIds] })).map((m) => [Number(m.user.id), m])) : new Map();

  let parents = new Map();
  const parentIds = [...new Set(rows.map((m) => m.parent_message_id).filter(Boolean))];
  if (references && parentIds.length) {
    const { MESSAGE_SELECT, withReactions } = require('./routes/guildMessages');
    const parentRows = await withReactions(await db.all(
      `${MESSAGE_SELECT} WHERE m.id IN (${parentIds.map(() => '?').join(',')})`,
      parentIds
    ));
    parents = new Map((await messageObjects(parentRows, { botId, guildId, references: false })).map((p) => [Number(p.id), p]));
  }

  const threadIds = rows.map((m) => m.thread?.id).filter(Boolean);
  const threadRows = threadIds.length
    ? await db.all(`SELECT * FROM guild_channels WHERE id IN (${threadIds.map(() => '?').join(',')})`, threadIds)
    : [];
  const threads = new Map(threadRows.map((t) => [t.id, t]));

  return rows.map((m) => {
    const sender = userById.get(m.sender_id);
    const author = m.webhook_id
      ? { id: id(m.webhook_id), username: m.webhook_name, discriminator: '0000', global_name: null, avatar: null, bot: true, public_flags: 0, flags: 0, avatar_url: m.webhook_avatar ?? null }
      : userObject(sender ?? { id: m.sender_id, username: m.sender_username ?? 'Deleted User', display_name: m.sender_display_name });
    let type = MESSAGE_TYPES.default;
    if (m.system === 'thread') type = MESSAGE_TYPES.thread;
    else if (m.system === 'poll_end') type = MESSAGE_TYPES.poll_end;
    else if (m.parent_message_id) type = MESSAGE_TYPES.reply;
    // An answer to a command: Discord's CHAT_INPUT_COMMAND (20) or CONTEXT_MENU_COMMAND (23).
    else if (m.interaction?.type === 2) type = m.interaction.command_type === 1 ? 20 : 23;
    const member = guildId && !m.webhook_id ? members.get(m.sender_id) : null;
    const thread = m.thread && threads.get(m.thread.id);
    const message = {
      id: id(m.id),
      type,
      channel_id: id(m.channel_id),
      ...(guildId ? { guild_id: id(guildId) } : {}),
      author,
      ...(member ? { member: { ...member, user: undefined } } : {}),
      content: m.content ?? '',
      timestamp: iso(m.timestamp),
      edited_timestamp: m.edited_at ? iso(m.edited_at) : (m.edited ? iso(m.timestamp) : null),
      tts: false,
      mention_everyone: Boolean(m.mention_everyone),
      mentions: mentionIds.get(m.id).filter((u) => userById.has(u)).map((u) => ({
        ...userObject(userById.get(u)),
        ...(members.get(u) ? { member: { ...members.get(u), user: undefined } } : {}),
      })),
      mention_roles: (m.mention_roles ?? []).map(String),
      mention_channels: [],
      attachments: m.attachments ?? [],
      // Its own embeds, then the link previews the server made (linkPreviews.js), as Discord.
      embeds: m.flags & (1 << 2) ? [] : [...(m.embeds ?? []), ...(m.link_embeds ?? [])],
      reactions: reactionsObject(m.reactions, botId),
      pinned: m.pinned_at != null,
      ...(m.webhook_id ? { webhook_id: id(m.webhook_id) } : {}),
      flags: (m.flags ?? 0) | (m.ephemeral ? 1 << 6 : 0),
      components: m.components ?? [],
      sticker_items: [],
    };
    // An answer to an interaction (interactions.js): who used which command or component.
    if (m.interaction) {
      const user = interactionUsers.get(m.interaction.user_id);
      const by = user ? userObject(user) : { id: id(m.interaction.user_id) };
      message.interaction_metadata = {
        id: id(m.interaction.id),
        type: m.interaction.type,
        user: by,
        authorizing_integration_owners: { 0: id(m.interaction.guild_id) },
        ...(m.interaction.original_response_message_id ? { original_response_message_id: id(m.interaction.original_response_message_id) } : {}),
        ...(m.interaction.interacted_message_id ? { interacted_message_id: id(m.interaction.interacted_message_id) } : {}),
        ...(m.interaction.target_id && m.interaction.command_type === 2 ? { target_user: { id: id(m.interaction.target_id) } } : {}),
        ...(m.interaction.target_id && m.interaction.command_type === 3 ? { target_message_id: id(m.interaction.target_id) } : {}),
      };
      if (m.interaction.name) message.interaction = { id: id(m.interaction.id), type: m.interaction.type, name: m.interaction.name, user: by };
      message.application_id = id(m.sender_id);
    }
    if (message.reactions.length === 0) delete message.reactions;
    if (m.parent_message_id) {
      message.message_reference = { type: 0, message_id: id(m.parent_message_id), channel_id: id(m.channel_id), ...(guildId ? { guild_id: id(guildId) } : {}), fail_if_not_exists: false };
      if (references) message.referenced_message = parents.get(m.parent_message_id) ?? null;
    }
    if (thread) message.thread = channelObject({ ...thread, archived: m.thread.archived, message_count: m.thread.message_count });
    for (const key of Object.keys(message)) if (message[key] === undefined) delete message[key];
    if (message.member) delete message.member.user;
    return message;
  });
}

module.exports = {
  CATEGORY_ID_BASE,
  CHANNEL_TYPES,
  DISCORD_PERMISSIONS,
  isBotChannel,
  toDiscordPermissions,
  fromDiscordPermissions,
  ourId,
  isCategoryId,
  categoryId,
  iso,
  USER_COLUMNS,
  userObject,
  memberObject,
  guildMembers,
  roleObject,
  roleIdFromDiscord,
  emojiObject,
  overwriteObject,
  channelObject,
  categoryObject,
  guildObject,
  reactionEmoji,
  reactionText,
  messageObjects,
  voiceStateObject,
};
