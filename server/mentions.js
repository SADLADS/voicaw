const db = require('./db');
const { s3Endpoint } = require('./config');
const { sendToUserSockets, getStatus, isViewingConversation } = require('./sockets');
const { sendPushToUser, getUserImageUrl } = require('./push');
const { PERMISSIONS, has, channelPermissions } = require('./permissions');
const { getAllMembers, getOverrides, getChannelViewers } = require('./guilds');
const { pollPreview } = require('./polls');

// Mentions in guild messages, and the pushes they (and plain messages) cause.
// In the text: `<@userId>`, `<@&roleId>`, `@everyone` (everyone who can see the channel) and
// `@here` (those of them not offline). Nothing inside code counts, as in Discord. Roles only
// ping if they're `mentionable` or the sender has Mention Everyone; @everyone and @here need
// Mention Everyone (without it they're just text). Only members who can see the channel are
// ever mentioned, and never the sender.

const MAX_PREVIEW_LENGTH = 200;
const NOTIFY_LEVELS = ['all', 'mentions', 'none'];

function withoutCode(text) {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

// What the text asks for (before any permission check).
function parseMentions(content) {
  const text = withoutCode(String(content ?? ''));
  const ids = (re) => new Set([...text.matchAll(re)].map((m) => Number(m[1])));
  return {
    userIds: ids(/<@(\d+)>/g),
    roleIds: ids(/<@&(\d+)>/g),
    everyone: /(?:^|[^\w@])@everyone\b/.test(text),
    here: /(?:^|[^\w@])@here\b/.test(text),
  };
}

// The channel's viewers as member contexts (guilds.js), by user id.
async function channelViewers(channel) {
  const members = await getAllMembers(channel.guild_id);
  const overrides = (await getOverrides({ channelIds: [channel.id] })).get(channel.id) ?? [];
  return new Map([...members].filter(([userId, m]) =>
    has(channelPermissions(m, userId, overrides), PERMISSIONS.VIEW_CHANNEL)));
}

// Who a message by `senderId` (with `permissions` in the channel) mentions:
// { everyone: 0/1 (@everyone or @here pinged), roleIds: [], userIds: Set }.
// `allowed` (webhooks' Discord `allowed_mentions`) narrows it: { parse: Set of 'users', 'roles',
// 'everyone', users: Set of ids, roles: Set of ids }; without it, whatever the text asks for.
function resolveMentions(content, { senderId, permissions, viewers, roles, allowed }) {
  const asked = parseMentions(content);
  if (allowed) {
    const only = (ids, kind) => new Set([...ids].filter((id) => allowed.parse.has(kind) || allowed[kind].has(id)));
    asked.userIds = only(asked.userIds, 'users');
    asked.roleIds = only(asked.roleIds, 'roles');
    if (!allowed.parse.has('everyone')) asked.everyone = asked.here = false;
  }
  const massMention = has(permissions, PERMISSIONS.MENTION_EVERYONE);
  const roleIds = roles
    .filter((r) => !r.is_everyone && asked.roleIds.has(r.id) && (r.mentionable || massMention))
    .map((r) => r.id);
  const everyone = massMention && asked.everyone;
  const here = massMention && asked.here && !everyone;

  const userIds = new Set();
  for (const [userId, member] of viewers) {
    if (userId === senderId) continue;
    if (everyone || asked.userIds.has(userId) ||
      (here && getStatus(userId) !== 'offline') ||
      member.roles.some((r) => roleIds.includes(r.id))) {
      userIds.add(userId);
    }
  }
  return { everyone: everyone || here ? 1 : 0, roleIds, userIds };
}

// Works out and saves a message's mentions (replacing any from before an edit). Returns
// { mentioned: Set of user ids, viewers }.
async function saveMentions(message, channel, permissions, allowed) {
  const viewers = await channelViewers(channel);
  const roles = await db.all('SELECT id, name, mentionable, is_everyone FROM guild_roles WHERE guild_id = ?', [channel.guild_id]);
  const found = resolveMentions(message.content, { senderId: message.sender_id, permissions, viewers, roles, allowed });
  await db.run(
    'UPDATE guild_messages SET mention_everyone = ?, mention_roles = ? WHERE id = ?',
    [found.everyone, found.roleIds.length ? JSON.stringify(found.roleIds) : null, message.id]
  );
  await db.run('DELETE FROM guild_mentions WHERE message_id = ?', [message.id]);
  for (const userId of found.userIds) {
    await db.run('INSERT INTO guild_mentions (message_id, channel_id, user_id) VALUES (?, ?, ?)', [message.id, channel.id, userId]);
  }
  return { mentioned: found.userIds, viewers };
}

// The message as notification text: mentions by name (channels `channelNames` gives, { id: name }:
// those the reader can see; others are #unknown-channel, as in the app), custom emoji as :name:, attachments as
// their names (their links carry keys; spoilers just "spoiler"), spoilers hidden, cut to MAX_PREVIEW_LENGTH.
async function previewText(content, guildId, channelNames = {}) {
  const userIds = [...String(content).matchAll(/<@(\d+)>/g)].map((m) => Number(m[1]));
  const users = userIds.length
    ? await db.all(`SELECT id, username, display_name FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`, userIds)
    : [];
  const roles = await db.all('SELECT id, name FROM guild_roles WHERE guild_id = ?', [guildId]);
  const userName = new Map(users.map((u) => [u.id, u.display_name || u.username]));
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  const text = pollPreview(content) ?? String(content)
    .replace(/!\[((?:\\.|[^\]\\])*)\]\(([^)]*)\)/g, (_, alt, url) =>
      /#(?:.*&)?sp=1(?:&|$)/.test(url) ? '📎 spoiler' : `📎 ${alt.replace(/\\(.)/g, '$1') || 'attachment'}`)
    .replace(/<:([A-Za-z0-9_]+):\d+>/g, ':$1:')
    .replace(/\|\|(?!\|)([\s\S]+?)\|\|/g, '[spoiler]')
    .replace(/<@&(\d+)>/g, (_, id) => `@${roleName.get(Number(id)) ?? 'deleted-role'}`)
    .replace(/<@(\d+)>/g, (_, id) => `@${userName.get(Number(id)) ?? 'unknown-user'}`)
    .replace(/<#(\d+)>/g, (_, id) => `#${channelNames[id] ?? 'unknown-channel'}`)
    .trim();
  return text.length > MAX_PREVIEW_LENGTH ? `${text.slice(0, MAX_PREVIEW_LENGTH - 1)}…` : text;
}

// The guild's channels that `content` mentions (`<#id>`), with who can see each:
// [{ id, name, viewers: Set of user ids }].
async function mentionedChannels(content, guildId) {
  const ids = [...new Set([...String(content).matchAll(/<#(\d+)>/g)].map((m) => Number(m[1])))];
  const found = [];
  for (const id of ids) {
    const channel = await db.get('SELECT id, guild_id, name FROM guild_channels WHERE id = ? AND guild_id = ?', [id, guildId]);
    if (channel) found.push({ id, name: channel.name, viewers: new Set(await getChannelViewers(channel)) });
  }
  return found;
}

// What a push says for a message with no text (a webhook's embeds or files only).
function fallbackPreview(message) {
  const embed = message.embeds?.find((e) => e.title || e.description);
  if (embed) return String(embed.title || embed.description).slice(0, MAX_PREVIEW_LENGTH);
  const file = message.attachments?.[0];
  return file ? `📎 ${file.filename}` : '';
}

// After a new message: tells the people mentioned (`guild_mention`, for their unread mention
// counts) and pushes to every viewer whose notification level wants it ('all': every message;
// 'mentions': when mentioned), unless they're looking at the channel. `silent` (a webhook's
// "suppress notifications" flag, like Discord's): no pushes, the counts still go up.
async function notifyNewMessage(message, channel, { mentioned, viewers }, { silent = false } = {}) {
  for (const userId of mentioned) {
    sendToUserSockets(userId, { type: 'guild_mention', guildId: channel.guild_id, channelId: channel.id, messageId: message.id });
  }
  const levels = new Map((await db.all(
    'SELECT user_id, notify_level FROM guild_members WHERE guild_id = ?',
    [channel.guild_id]
  )).map((r) => [r.user_id, r.notify_level]));
  const recipients = [...viewers.keys()].filter((userId) => {
    if (userId === message.sender_id) return false;
    const level = levels.get(userId) ?? 'mentions';
    if (level === 'none' || (level === 'mentions' && !mentioned.has(userId))) return false;
    return !isViewingConversation(userId, `channel-${channel.id}`);
  });
  if (!recipients.length || silent) return;

  const guild = await db.get('SELECT name FROM guilds WHERE id = ?', [channel.guild_id]);
  // Channel mentions are named only for those who can see that channel, so the text can differ.
  const channels = await mentionedChannels(message.content, channel.guild_id);
  const bodyFor = async (userId) => (await previewText(
    message.content,
    channel.guild_id,
    Object.fromEntries(channels.filter((c) => c.viewers.has(userId)).map((c) => [c.id, c.name]))
  )) || fallbackPreview(message);
  const sharedBody = channels.length ? null : await bodyFor(null);
  const payload = {
    type: 'guild',
    title: `${message.sender_display_name || message.sender_username} (#${channel.name}, ${guild.name})`,
    // A reply to a document opens that document.
    url: `/guild/${channel.guild_id}/${channel.id}${message.document_id ? `?doc=${message.document_id}` : ''}`,
    tag: `channel-${channel.id}`,
    // A webhook's own picture (ours, never another site's), else the sender's.
    image: message.webhook_id
      ? (message.webhook_avatar?.startsWith(s3Endpoint) ? message.webhook_avatar : '/default.png')
      : await getUserImageUrl(message.sender_id),
    timestamp: message.timestamp,
  };
  for (const userId of recipients) {
    const body = sharedBody ?? await bodyFor(userId);
    sendPushToUser(userId, { ...payload, body }, { urgency: 'high', topic: `channel${channel.id}` }).catch(() => {});
  }
}

module.exports = { NOTIFY_LEVELS, parseMentions, resolveMentions, saveMentions, notifyNewMessage, previewText };
