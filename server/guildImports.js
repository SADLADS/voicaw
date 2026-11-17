// History imports (docs/guilds.md, History imports): a guild's administrators (the owner or
// Administrator) put old messages from an exported archive into the guild's channels. The
// browser reads the archive (client/src/services/historyImport/) and sends it here in parts:
// first its authors and channels (createImport), then how they map to members and channels
// (setMapping), then the files (storeImportFile) and the messages, one channel's batch at a
// time in time order (addMessages), then finishImport. Tables: see db.js, HISTORY IMPORTS.
//
// Imported messages are written straight into guild_messages: no pushes, no mention rows (so
// nobody is pinged), no XP, no unread changes, no live events but one `guild_history_changed`
// per channel when something changes, which makes open apps load the channel again. They keep
// the archive's times, so a channel's history is ordered by (timestamp, id), not id (see
// routes/guildMessages.js). Every one says it was imported, with the import's `label` (free
// text, "Imported" when empty) and a disclaimer the app writes itself.
//
// An archive author is mapped to a member (shown as them) or not (shown by the archive's name
// and picture, as webhooks are: sender_id 0). A member can unlink themselves ("This wasn't
// me", or all at once in Settings → Privacy); then they show as unmapped, and the importer
// can't map them to that author again (`unlinked_user_id`, never shown). With the preference
// `importOptOut` nobody can map them at all.
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const { PERMISSIONS, has } = require('./permissions');
const { getMember, getChannelViewers } = require('./guilds');
const { getSetting } = require('./appSettings');
const { getPreferences } = require('./preferences');
const { logAudit } = require('./auditLog');
const { ActionError } = require('./actionError');
const { putObject, deleteObject, getUploadUrl } = require('./s3');
const { releaseUploads, registerUpload } = require('./uploads');
const { sendToUserSockets } = require('./sockets');
const { processAvatar, AvatarImageError } = require('./avatarImage');
const { refreshLinkPreviews, linksIn } = require('./linkPreviews');
const { maxPlaintextLength } = config;

// Archive formats the client can read; only names, never shown.
const SOURCES = ['discord-chat-exporter'];
const LIMITS = {
  label: 24,
  name: 80,
  guildName: 100,
  authors: 20000,
  channels: 1000,
  batch: 500,
  attachments: 10,
  embeds: 10,
  reactions: 20,
  emoji: 64,
  file: 90 * 1024 * 1024, // under nginx's 100M a request
  avatar: 8 * 1024 * 1024,
};
const CHAT_TYPES = ['text', 'voice'];
const AVATAR_BUCKET = 'profile-pics';
const FILE_BUCKET = 'uploads';

const now = () => Math.floor(Date.now() / 1000);

const enabled = async () => (await getSetting('historyImports')) !== 'off';

// The member importing into `guildId`: the owner or an administrator, while imports are on.
async function requireImporter(guildId, userId) {
  if (!(await enabled())) throw new ActionError(403, 'History imports are turned off on this server');
  const member = await getMember(guildId, userId);
  if (!member) throw new ActionError(404, 'Guild not found');
  if (!has(member.permissions, PERMISSIONS.ADMINISTRATOR)) throw new ActionError(403, "You don't have permission to do that");
  return member;
}

async function getImport(guildId, importId) {
  const row = Number.isInteger(importId) && await db.get('SELECT * FROM guild_imports WHERE id = ? AND guild_id = ?', [importId, guildId]);
  if (!row) throw new ActionError(404, 'Import not found');
  return row;
}

// A trimmed string of 1–`max` characters, else null.
function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

// The archive's own ids: digits or short safe strings (other formats may not use numbers).
const cleanSourceId = (value) => {
  const id = typeof value === 'number' ? String(value) : value;
  return typeof id === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(id) ? id : null;
};

// The import as Guild Settings shows it: its authors (with how many messages each has) and
// channels (with where they go and how many are in).
async function importView(importId) {
  const row = await db.get(
    `SELECT i.*, u.username AS importer_username FROM guild_imports i LEFT JOIN users u ON u.id = i.importer_id WHERE i.id = ?`,
    [importId]
  );
  const authors = await db.all(
    `SELECT a.id, a.source_id, a.name, a.avatar, a.is_bot, a.user_id,
       (SELECT COUNT(*) FROM guild_messages m WHERE m.import_author_id = a.id) AS message_count
     FROM guild_import_authors a WHERE a.import_id = ? ORDER BY a.id`,
    [importId]
  );
  const channels = await db.all(
    `SELECT c.source_id, c.name, c.channel_id,
       (SELECT COUNT(*) FROM guild_import_messages im JOIN guild_messages m ON m.id = im.message_id
        WHERE im.import_id = c.import_id AND m.channel_id = c.channel_id) AS message_count
     FROM guild_import_channels c WHERE c.import_id = ? ORDER BY c.rowid`,
    [importId]
  );
  const { count } = await db.get('SELECT COUNT(*) AS count FROM guild_import_messages WHERE import_id = ?', [importId]);
  return { ...row, message_count: count, authors, channels };
}

async function listImports(member) {
  const rows = await db.all('SELECT id FROM guild_imports WHERE guild_id = ? ORDER BY id DESC', [member.guild.id]);
  return Promise.all(rows.map((r) => importView(r.id)));
}

// Members an archive author probably is: the same username or display name (any case).
async function suggestions(guildId, authors) {
  const members = await db.all(
    `SELECT u.id, u.username, u.display_name FROM guild_members gm JOIN users u ON u.id = gm.user_id WHERE gm.guild_id = ?`,
    [guildId]
  );
  const optedOut = new Set();
  for (const m of members) if ((await getPreferences(m.id)).importOptOut) optedOut.add(m.id);
  const byName = new Map();
  for (const m of members) {
    if (optedOut.has(m.id)) continue;
    for (const name of [m.username, m.display_name]) {
      const key = name?.trim().toLowerCase();
      if (key && !byName.has(key)) byName.set(key, m.id);
    }
  }
  const found = {};
  for (const author of authors) {
    for (const name of author.names) {
      const id = byName.get(name.toLowerCase());
      if (id) {
        found[author.id] = id;
        break;
      }
    }
  }
  return found;
}

// Starts an import from the archive's list of `authors` ([{ sourceId, name, names?, isBot }])
// and `channels` ([{ sourceId, name }]). -> the import with `suggested` ({ authorId: userId }).
async function createImport(member, { source, sourceGuildName, label, authors, channels } = {}) {
  if (!SOURCES.includes(source)) throw new ActionError(400, 'Unknown archive format');
  if (!Array.isArray(authors) || authors.length > LIMITS.authors) throw new ActionError(400, 'Invalid authors');
  if (!Array.isArray(channels) || channels.length === 0 || channels.length > LIMITS.channels) throw new ActionError(400, 'Invalid channels');
  const cleanAuthors = authors.map((a) => ({
    sourceId: cleanSourceId(a?.sourceId),
    name: cleanText(a?.name, LIMITS.name),
    names: (Array.isArray(a?.names) ? a.names : []).map((n) => cleanText(n, LIMITS.name)).filter(Boolean).slice(0, 4),
    isBot: Boolean(a?.isBot),
  }));
  const cleanChannels = channels.map((c) => ({ sourceId: cleanSourceId(c?.sourceId), name: cleanText(c?.name, LIMITS.name) }));
  if (cleanAuthors.some((a) => !a.sourceId || !a.name) || new Set(cleanAuthors.map((a) => a.sourceId)).size !== cleanAuthors.length) {
    throw new ActionError(400, 'Invalid authors');
  }
  if (cleanChannels.some((c) => !c.sourceId || !c.name) || new Set(cleanChannels.map((c) => c.sourceId)).size !== cleanChannels.length) {
    throw new ActionError(400, 'Invalid channels');
  }
  const guildId = member.guild.id;
  const { importId, authorIds } = await db.transaction(async () => {
    const { lastID } = await db.run(
      'INSERT INTO guild_imports (guild_id, importer_id, source, source_guild_name, label, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [guildId, member.userId, source, cleanText(sourceGuildName, LIMITS.guildName), cleanText(label, LIMITS.label), now()]
    );
    const ids = new Map();
    for (const a of cleanAuthors) {
      const { lastID: id } = await db.run(
        'INSERT INTO guild_import_authors (import_id, source_id, name, is_bot) VALUES (?, ?, ?, ?)',
        [lastID, a.sourceId, a.name, a.isBot ? 1 : 0]
      );
      ids.set(a.sourceId, id);
    }
    for (const c of cleanChannels) {
      await db.run('INSERT INTO guild_import_channels (import_id, source_id, name) VALUES (?, ?, ?)', [lastID, c.sourceId, c.name]);
    }
    await logAudit({ guildId, actorId: member.userId, action: 'import_create', targetType: 'import', targetId: lastID, details: { source: cleanText(sourceGuildName, LIMITS.guildName) } });
    return { importId: lastID, authorIds: ids };
  });
  const suggested = await suggestions(guildId, cleanAuthors.filter((a) => !a.isBot).map((a) => ({
    id: authorIds.get(a.sourceId), names: [a.name, ...a.names],
  })));
  return { ...(await importView(importId)), suggested };
}

// Who may be shown as `authorRow`: a member of the guild who hasn't opted out or unlinked
// themselves from it.
async function checkMappable(guildId, authorRow, userId) {
  if (userId == null) return;
  if (!Number.isInteger(userId) || !(await getMember(guildId, userId))) throw new ActionError(400, 'Not a member of this guild');
  if (authorRow.unlinked_user_id === userId) throw new ActionError(400, 'That member has asked not to be linked to this author');
  if ((await getPreferences(userId)).importOptOut) throw new ActionError(400, "That member doesn't want to be linked to imported messages");
}

// Changes the import's `label`, its `authors` ([{ id, userId (null: unmapped), name? }]) and
// `channels` ([{ sourceId, channelId (null: skipped) }]; new channels are made by the client
// first, with the usual route, so they get the usual checks). Messages already in follow.
async function setMapping(member, importId, { label, authors = [], channels = [] } = {}) {
  const guildId = member.guild.id;
  const imp = await getImport(guildId, importId);
  if (!Array.isArray(authors) || !Array.isArray(channels)) throw new ActionError(400, 'Invalid mapping');
  const authorRows = new Map((await db.all('SELECT * FROM guild_import_authors WHERE import_id = ?', [imp.id])).map((a) => [a.id, a]));
  const authorChanges = [];
  for (const change of authors) {
    const row = authorRows.get(change?.id);
    if (!row) throw new ActionError(400, 'Invalid author');
    const userId = change.userId === undefined ? row.user_id : change.userId;
    if (userId !== row.user_id) await checkMappable(guildId, row, userId);
    const name = change.name === undefined ? row.name : cleanText(change.name, LIMITS.name);
    if (!name) throw new ActionError(400, `Names are 1–${LIMITS.name} characters`);
    authorChanges.push({ row, userId, name });
  }
  const channelRows = new Map((await db.all('SELECT * FROM guild_import_channels WHERE import_id = ?', [imp.id])).map((c) => [c.source_id, c]));
  const channelChanges = [];
  for (const change of channels) {
    const row = channelRows.get(cleanSourceId(change?.sourceId));
    if (!row) throw new ActionError(400, 'Invalid channel');
    const channelId = change.channelId ?? null;
    if (channelId !== null) {
      const target = Number.isInteger(channelId) && await db.get('SELECT id, type FROM guild_channels WHERE id = ? AND guild_id = ?', [channelId, guildId]);
      if (!target || !CHAT_TYPES.includes(target.type)) throw new ActionError(400, 'Messages can only go into text channels and voice channels');
    }
    // Messages already in a channel stay there: moving them isn't offered.
    if (row.channel_id != null && channelId !== row.channel_id) {
      const placed = await db.get('SELECT 1 FROM guild_import_messages im JOIN guild_messages m ON m.id = im.message_id WHERE im.import_id = ? AND m.channel_id = ? LIMIT 1', [imp.id, row.channel_id]);
      if (placed) throw new ActionError(400, 'Messages from that channel are already imported');
    }
    channelChanges.push({ row, channelId });
  }
  const newLabel = label === undefined ? imp.label : cleanText(label, LIMITS.label);

  const touched = await db.transaction(async () => {
    const changedChannels = new Set();
    if (newLabel !== imp.label) {
      await db.run('UPDATE guild_imports SET label = ? WHERE id = ?', [newLabel, imp.id]);
      for (const { channel_id: id } of await importChannelIds(imp.id)) changedChannels.add(id);
    }
    for (const { row, userId, name } of authorChanges) {
      if (userId === row.user_id && name === row.name) continue;
      await db.run('UPDATE guild_import_authors SET user_id = ?, name = ? WHERE id = ?', [userId, name, row.id]);
      for (const id of await reassignAuthor(row.id, userId)) changedChannels.add(id);
    }
    for (const { row, channelId } of channelChanges) {
      await db.run('UPDATE guild_import_channels SET channel_id = ? WHERE import_id = ? AND source_id = ?', [channelId, imp.id, row.source_id]);
    }
    await logAudit({ guildId, actorId: member.userId, action: 'import_mapping', targetType: 'import', targetId: imp.id });
    return changedChannels;
  });
  await announceHistory(guildId, touched);
  return importView(imp.id);
}

// Points the messages of author `authorId` at `userId` (or 0, unmapped). -> the channels touched.
async function reassignAuthor(authorId, userId) {
  await db.run('UPDATE guild_messages SET sender_id = ? WHERE import_author_id = ?', [userId ?? 0, authorId]);
  const rows = await db.all('SELECT DISTINCT channel_id FROM guild_messages WHERE import_author_id = ?', [authorId]);
  return rows.map((r) => r.channel_id);
}

const importChannelIds = (importId) => db.all('SELECT DISTINCT channel_id FROM guild_messages WHERE import_id = ?', [importId]);

// Tells whoever can see each channel to load it again.
async function announceHistory(guildId, channelIds) {
  for (const channelId of channelIds) {
    const channel = await db.get('SELECT id, guild_id FROM guild_channels WHERE id = ?', [channelId]);
    if (!channel) continue;
    for (const userId of await getChannelViewers(channel)) {
      sendToUserSockets(userId, { type: 'guild_history_changed', guildId, channelId });
    }
  }
}

// ---- Content ----

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The archive's mentions and custom emoji made ours: `<@sourceId>` becomes the mapped member's
// mention (no ping: imports save no mention rows) or `@name`; `<#sourceId>` the channel it went
// into or `#name`; `<@&id>` `@role name`; `<:name:id>` the guild's emoji of that name or
// `:name:`. `names` are the archive's names for users, roles and channels it mentions.
function rewriteContent(content, ctx) {
  return content
    .replace(/<@!?([A-Za-z0-9._:-]{1,64})>/g, (_, id) => {
      const author = ctx.authors.get(id);
      if (author?.user_id) return `<@${author.user_id}>`;
      return `@${author?.name ?? ctx.names.users[id] ?? 'unknown-user'}`;
    })
    .replace(/<#([A-Za-z0-9._:-]{1,64})>/g, (_, id) => {
      const channel = ctx.channels.get(id);
      if (channel?.channel_id) return `<#${channel.channel_id}>`;
      return `#${channel?.name ?? ctx.names.channels[id] ?? 'unknown-channel'}`;
    })
    .replace(/<@&([A-Za-z0-9._:-]{1,64})>/g, (_, id) => `@${ctx.names.roles[id] ?? 'unknown-role'}`)
    .replace(/<(a?):([A-Za-z0-9_]{1,32}):(\d{1,25})>/g, (_, animated, name) => {
      const emoji = ctx.emojis.get(name.toLowerCase());
      return emoji ? `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>` : `:${name}:`;
    });
}

// A plain {[id]: name} map from the client (names the archive gave its mentions).
function cleanNames(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [id, name] of Object.entries(value).slice(0, 5000)) {
    const cleanId = cleanSourceId(id);
    const cleanName = cleanText(name, LIMITS.name);
    if (cleanId && cleanName) out[cleanId] = cleanName;
  }
  return out;
}

const isOurFile = (importId, url) => typeof url === 'string'
  && url.startsWith(`${config.s3Endpoint}/${FILE_BUCKET}/imports/${importId}/`)
  && !url.includes('..');

// Attachments: files storeImportFile stored for this import (kept as it returned them), or a
// file the archive didn't include ({ filename, size, missing: true }), drawn as "not included".
function cleanAttachments(importId, list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, LIMITS.attachments).map((a) => {
    const filename = cleanText(a?.filename, 200) ?? 'file';
    const size = Number.isSafeInteger(a?.size) && a.size >= 0 ? a.size : null;
    if (a?.missing || !isOurFile(importId, a?.url)) return { id: crypto.randomUUID(), filename, size, missing: true };
    const clean = {
      id: String(a.id ?? crypto.randomUUID()).slice(0, 40), filename, size, url: a.url, proxy_url: a.url,
      content_type: typeof a.content_type === 'string' ? a.content_type.slice(0, 100) : 'application/octet-stream',
    };
    if (Number.isInteger(a.width) && Number.isInteger(a.height)) Object.assign(clean, { width: a.width, height: a.height });
    return clean;
  });
}

// Embeds without anything loaded from other sites (pictures in an archive's embeds are links
// to its old CDN or to third parties): text, links, colour and fields only.
function cleanEmbeds(list) {
  if (!Array.isArray(list)) return [];
  const text = (v, max) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined);
  const link = (v) => (typeof v === 'string' && /^https?:\/\//i.test(v) && v.length <= 2048 ? v : undefined);
  const strip = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
  return list.slice(0, LIMITS.embeds).map((e) => strip({
    title: text(e?.title, 256),
    url: link(e?.url),
    description: text(e?.description, 4096),
    color: Number.isInteger(e?.color) && e.color >= 0 && e.color <= 0xffffff ? e.color : undefined,
    author: e?.author && text(e.author.name, 256) ? strip({ name: text(e.author.name, 256), url: link(e.author.url) }) : undefined,
    footer: e?.footer && text(e.footer.text, 2048) ? { text: text(e.footer.text, 2048) } : undefined,
    fields: Array.isArray(e?.fields) ? e.fields.slice(0, 25).filter((f) => text(f?.name, 256) && text(f?.value, 1024))
      .map((f) => ({ name: text(f.name, 256), value: text(f.value, 1024), inline: Boolean(f.inline) })) : undefined,
  })).filter((e) => Object.keys(e).length > 0);
}

// The archive's reactions: [{ emoji, count, users }], `emoji` Unicode, or a custom one's name
// (`customName`: made the guild's emoji of that name, `<:name:id>`, or left as `:name:`).
// `users` are the reactors' archive author rows (ids), so the client shows mapped ones as
// members and the rest by the archive's names.
function cleanReactions(list, emojis, authors) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list.slice(0, LIMITS.reactions)) {
    const count = Number.isSafeInteger(r?.count) && r.count > 0 ? Math.min(r.count, 1_000_000) : null;
    if (!count) continue;
    const users = (Array.isArray(r.userSourceIds) ? r.userSourceIds : []).slice(0, 100)
      .map((id) => authors.get(cleanSourceId(id))?.id).filter(Boolean);
    if (typeof r.customName === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(r.customName)) {
      const emoji = emojis.get(r.customName.toLowerCase());
      out.push({ emoji: emoji ? `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>` : `:${r.customName}:`, count, users });
    } else if (typeof r.emoji === 'string' && r.emoji && r.emoji.length <= LIMITS.emoji) {
      out.push({ emoji: r.emoji, count, users });
    }
  }
  return out;
}

// A bot's answer to a command: { name, import_author_id } (who ran it; decorateImported makes
// that `user_id` or `user_name` as it's read).
function cleanInteraction(value, authors) {
  const name = cleanText(value?.name, 100);
  const author = authors.get(cleanSourceId(value?.userSourceId));
  if (!name || !author) return null;
  return { name, import_author_id: author.id };
}

// Link previews for imported messages, made by the usual code (linkPreviews.js; none when
// Settings → Admin turns them off) one at a time, so an import never fetches hundreds of pages
// at once. The archive's own previews aren't kept: their pictures are on its old CDN.
let previewQueue = Promise.resolve();
function queuePreviews(messageIds) {
  for (const id of messageIds) previewQueue = previewQueue.then(() => refreshLinkPreviews(id));
}
const previewsSettled = () => previewQueue;

// ---- Adding ----

// Adds a batch of `messages` (oldest first) from archive channel `channelSourceId`, each
// { sourceId, authorSourceId, timestamp (ms), editedTimestamp?, pinned?, content,
// replyToSourceId?, attachments?, embeds?, reactions? }, plus the archive's `names` ({ users,
// roles, channels }: {[id]: name}) for rewriting mentions. Messages already in are skipped,
// so a batch can be sent again. -> { added, skipped }
async function addMessages(member, importId, { channelSourceId, messages, names = {} } = {}) {
  const guildId = member.guild.id;
  const imp = await getImport(guildId, importId);
  if (!Array.isArray(messages) || messages.length > LIMITS.batch) throw new ActionError(400, `Batches are at most ${LIMITS.batch} messages`);
  const channelRows = new Map((await db.all('SELECT * FROM guild_import_channels WHERE import_id = ?', [imp.id])).map((c) => [c.source_id, c]));
  const mapped = channelRows.get(cleanSourceId(channelSourceId));
  if (!mapped || mapped.channel_id == null) throw new ActionError(400, "That channel isn't going anywhere");
  const channel = await db.get('SELECT id, guild_id, type FROM guild_channels WHERE id = ? AND guild_id = ?', [mapped.channel_id, guildId]);
  if (!channel || !CHAT_TYPES.includes(channel.type)) throw new ActionError(400, 'That channel no longer exists');
  const authors = new Map((await db.all('SELECT * FROM guild_import_authors WHERE import_id = ?', [imp.id])).map((a) => [a.source_id, a]));
  const emojis = new Map();
  for (const e of await db.all('SELECT id, name, animated FROM guild_emojis WHERE guild_id = ? AND available = 1', [guildId])) {
    if (!emojis.has(e.name.toLowerCase())) emojis.set(e.name.toLowerCase(), e);
  }
  const ctx = {
    authors,
    channels: channelRows,
    emojis,
    names: { users: cleanNames(names.users), roles: cleanNames(names.roles), channels: cleanNames(names.channels) },
  };

  const rows = [];
  for (const m of messages) {
    const sourceId = cleanSourceId(m?.sourceId);
    const author = authors.get(cleanSourceId(m?.authorSourceId));
    const ms = Number(m?.timestamp);
    if (!sourceId || !author || !Number.isFinite(ms) || ms <= 0 || ms > Date.now() + 86_400_000) {
      throw new ActionError(400, 'Invalid message');
    }
    let content = typeof m.content === 'string' ? rewriteContent(m.content, ctx).trim() : '';
    if (content.length > maxPlaintextLength) content = `${content.slice(0, maxPlaintextLength - 1)}…`;
    const attachments = cleanAttachments(imp.id, m.attachments);
    const embeds = cleanEmbeds(m.embeds);
    if (!content && !attachments.length && !embeds.length) continue; // nothing to show
    const edited = Number(m.editedTimestamp);
    rows.push({
      sourceId,
      author,
      timestamp: Math.floor(ms / 1000),
      editedAt: Number.isFinite(edited) && edited > ms ? Math.floor(edited / 1000) : null,
      pinned: m.pinned === true,
      content,
      replyTo: cleanSourceId(m.replyToSourceId),
      attachments,
      embeds,
      reactions: cleanReactions(m.reactions, emojis, authors),
      interaction: cleanInteraction(m.interaction, authors),
    });
  }

  const withLinks = [];
  const result = await db.transaction(async () => {
    let added = 0;
    let skipped = messages.length - rows.length;
    let { pins } = await db.get('SELECT COUNT(*) AS pins FROM guild_messages WHERE channel_id = ? AND pinned_at IS NOT NULL', [channel.id]);
    for (const row of rows) {
      const seen = await db.get('SELECT message_id FROM guild_import_messages WHERE import_id = ? AND source_id = ?', [imp.id, row.sourceId]);
      if (seen) {
        skipped += 1;
        continue;
      }
      const parent = row.replyTo && await db.get(
        `SELECT m.id FROM guild_import_messages im JOIN guild_messages m ON m.id = im.message_id
         WHERE im.import_id = ? AND im.source_id = ? AND m.channel_id = ?`,
        [imp.id, row.replyTo, channel.id]
      );
      const pin = row.pinned && pins < require('./pins').MAX_PINS;
      if (pin) pins += 1;
      const { lastID } = await db.run(
        `INSERT INTO guild_messages (channel_id, sender_id, content, timestamp, parent_message_id, edited, edited_at,
           embeds, attachments, pinned_at, pinned_by, import_id, import_author_id, import_reactions, interaction)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [channel.id, row.author.user_id ?? 0, row.content, row.timestamp, parent?.id ?? null, row.editedAt ? 1 : 0, row.editedAt,
          row.embeds.length ? JSON.stringify(row.embeds) : null, row.attachments.length ? JSON.stringify(row.attachments) : null,
          pin ? row.timestamp : null, pin ? member.userId : null, imp.id, row.author.id,
          row.reactions.length ? JSON.stringify(row.reactions) : null, row.interaction ? JSON.stringify(row.interaction) : null]
      );
      await db.run('INSERT INTO guild_import_messages (import_id, source_id, message_id) VALUES (?, ?, ?)', [imp.id, row.sourceId, lastID]);
      await db.indexGuildMessage(lastID);
      if (linksIn(row.content).length) withLinks.push(lastID);
      added += 1;
    }
    if (imp.status === 'mapping') await db.run("UPDATE guild_imports SET status = 'running' WHERE id = ?", [imp.id]);
    return { added, skipped };
  });
  queuePreviews(withLinks);
  return result;
}

// One file of the archive, `size` bytes, named `name` (`width`/`height` for a picture, from
// the browser), put by the client straight into the object store (the API's nginx takes 26 MB a
// request, the object store's 100 MB): -> { uploadUrl (a signed PUT, for 60 s), attachment
// (what a batch then gives back) }. Served as its extension says, as webhooks' files are
// (pictures, videos and sounds as themselves, anything else as a download). Registered now:
// deleted unless a message links to it within a day (uploads.js).
async function prepareImportFile(member, importId, { name, size, width, height } = {}) {
  const imp = await getImport(member.guild.id, importId);
  if (!Number.isSafeInteger(size) || size <= 0) throw new ActionError(400, 'Invalid file');
  if (size > LIMITS.file) throw new ActionError(413, 'That file is too large');
  const { cleanFilename, EXTENSION_TYPES } = require('./routes/webhooks');
  const filename = cleanFilename(name, 0);
  const contentType = EXTENSION_TYPES[filename.split('.').pop().toLowerCase()] ?? 'application/octet-stream';
  const id = (crypto.randomBytes(8).readBigUInt64BE() >> 1n).toString();
  const key = `imports/${imp.id}/${id}/${filename}`;
  const uploadUrl = await getUploadUrl(key, FILE_BUCKET, contentType, size);
  await registerUpload(key, member.userId);
  const url = `${config.s3Endpoint}/${FILE_BUCKET}/${key}`;
  const dimensions = contentType.startsWith('image/') && Number.isInteger(width) && Number.isInteger(height)
    && width > 0 && height > 0 && width <= 100_000 && height <= 100_000 ? { width, height } : {};
  return { uploadUrl, attachment: { id, filename, size, url, content_type: contentType, ...dimensions } };
}

const avatarKey = (importId, authorId, version) => `imports/${importId}/${authorId}-${version}.webp`;

// The archive's picture of an author, stored as a profile picture is (the original isn't kept).
async function storeAuthorAvatar(member, importId, authorId, body) {
  const imp = await getImport(member.guild.id, importId);
  const author = await db.get('SELECT * FROM guild_import_authors WHERE id = ? AND import_id = ?', [authorId, imp.id]);
  if (!author) throw new ActionError(404, 'Author not found');
  if (!Buffer.isBuffer(body) || body.length === 0 || body.length > LIMITS.avatar) throw new ActionError(400, 'Invalid picture');
  let image;
  try {
    image = await processAvatar(body);
  } catch (err) {
    if (err instanceof AvatarImageError) throw new ActionError(400, err.message);
    throw err;
  }
  const key = avatarKey(imp.id, author.id, crypto.randomBytes(6).toString('hex'));
  await putObject(AVATAR_BUCKET, key, image.buffer, image.contentType);
  const url = `${config.s3Endpoint}/${AVATAR_BUCKET}/${key}`;
  await db.run('UPDATE guild_import_authors SET avatar = ? WHERE id = ?', [url, author.id]);
  if (author.avatar) await deleteAvatar(author.avatar);
  return { avatar: url };
}

async function deleteAvatar(url) {
  const prefix = `${config.s3Endpoint}/${AVATAR_BUCKET}/`;
  if (!url?.startsWith(prefix)) return;
  try {
    await deleteObject(AVATAR_BUCKET, url.slice(prefix.length));
  } catch (err) {
    console.error('Deleting an imported picture failed:', err.message);
  }
}

// Marks the import done and tells open apps about every channel it went into.
async function finishImport(member, importId) {
  const imp = await getImport(member.guild.id, importId);
  await db.transaction(async () => {
    await db.run("UPDATE guild_imports SET status = 'done', finished_at = ? WHERE id = ?", [now(), imp.id]);
    const { count } = await db.get('SELECT COUNT(*) AS count FROM guild_import_messages WHERE import_id = ?', [imp.id]);
    await logAudit({ guildId: imp.guild_id, actorId: member.userId, action: 'import_finish', targetType: 'import', targetId: imp.id, details: { messages: count } });
  });
  await announceHistory(imp.guild_id, (await importChannelIds(imp.id)).map((r) => r.channel_id));
  return importView(imp.id);
}

// Deletes the import's rows and messages (with anything people did to them since: reactions,
// pins, edit history...), not its files (the upload registry deletes those once nothing links
// them) or the channels it made. `actorId` null when the guild itself is going.
async function removeImportRows(importId) {
  const messageIds = (await db.all('SELECT id FROM guild_messages WHERE import_id = ?', [importId])).map((r) => r.id);
  const { removeLinkedRows } = require('./pollTimers');
  for (const id of messageIds) {
    await db.run('DELETE FROM guild_reactions WHERE message_id = ?', [id]);
    await db.run('DELETE FROM guild_mentions WHERE message_id = ?', [id]);
    await db.run('UPDATE guild_messages SET parent_message_id = NULL WHERE parent_message_id = ? AND import_id IS NOT ?', [id, importId]);
    await removeLinkedRows('guild', id);
  }
  await db.run('DELETE FROM guild_messages WHERE import_id = ?', [importId]);
  await db.run('DELETE FROM guild_import_messages WHERE import_id = ?', [importId]);
  await db.run('DELETE FROM guild_import_channels WHERE import_id = ?', [importId]);
  const avatars = await db.all('SELECT avatar FROM guild_import_authors WHERE import_id = ? AND avatar IS NOT NULL', [importId]);
  await db.run('DELETE FROM guild_import_authors WHERE import_id = ?', [importId]);
  await db.run('DELETE FROM guild_imports WHERE id = ?', [importId]);
  return avatars.map((a) => a.avatar);
}

async function deleteImport(member, importId) {
  const imp = await getImport(member.guild.id, importId);
  const channelIds = (await importChannelIds(imp.id)).map((r) => r.channel_id);
  const avatars = await db.transaction(async () => {
    const urls = await removeImportRows(imp.id);
    await logAudit({ guildId: imp.guild_id, actorId: member.userId, action: 'import_delete', targetType: 'import', targetId: imp.id, details: { source: imp.source_guild_name } });
    return urls;
  });
  releaseUploads();
  await deletePictures(avatars);
  await announceHistory(imp.guild_id, channelIds);
}

async function deletePictures(urls) {
  for (const url of urls) await deleteAvatar(url);
}

// Every import of a guild being deleted (inside its transaction). -> pictures to delete after.
async function deleteGuildImports(guildId) {
  const urls = [];
  for (const { id } of await db.all('SELECT id FROM guild_imports WHERE guild_id = ?', [guildId])) urls.push(...await removeImportRows(id));
  return urls;
}

// ---- The person linked ----

// The archive authors linked to `userId`, with their guild and how many messages each has.
async function linkedTo(userId) {
  return db.all(
    `SELECT a.id, a.name, i.guild_id, g.name AS guild_name, i.source_guild_name, i.label,
       (SELECT COUNT(*) FROM guild_messages m WHERE m.import_author_id = a.id) AS message_count
     FROM guild_import_authors a JOIN guild_imports i ON i.id = a.import_id JOIN guilds g ON g.id = i.guild_id
     WHERE a.user_id = ? ORDER BY g.name, a.id`,
    [userId]
  );
}

// "This wasn't me": `userId` stops being shown as author `authorId` (null: every one), and
// can't be linked to it again.
async function unlink(userId, authorId = null) {
  const rows = authorId == null
    ? await db.all('SELECT a.id, i.guild_id FROM guild_import_authors a JOIN guild_imports i ON i.id = a.import_id WHERE a.user_id = ?', [userId])
    : await db.all('SELECT a.id, i.guild_id FROM guild_import_authors a JOIN guild_imports i ON i.id = a.import_id WHERE a.id = ? AND a.user_id = ?', [authorId, userId]);
  if (authorId != null && rows.length === 0) throw new ActionError(404, 'Not linked to you');
  const touched = await db.transaction(async () => {
    const byGuild = new Map();
    for (const row of rows) {
      await db.run('UPDATE guild_import_authors SET user_id = NULL, unlinked_user_id = ? WHERE id = ?', [userId, row.id]);
      if (!byGuild.has(row.guild_id)) byGuild.set(row.guild_id, new Set());
      for (const id of await reassignAuthor(row.id, null)) byGuild.get(row.guild_id).add(id);
    }
    return byGuild;
  });
  for (const [guildId, channelIds] of touched) await announceHistory(guildId, channelIds);
  return { unlinked: rows.length };
}

// Someone leaving a guild stays linked (as people's old messages stay theirs); deleting an
// account unlinks them everywhere (accounts.js).
async function unlinkDeletedUser(userId) {
  await db.run('UPDATE guild_import_authors SET user_id = NULL WHERE user_id = ?', [userId]);
  await db.run('UPDATE guild_messages SET sender_id = 0 WHERE sender_id = ? AND import_id IS NOT NULL', [userId]);
}

// ---- Drawing ----

const placeholders = (list) => list.map(() => '?').join(',');

// Adds `imported` to each imported message (others unchanged), worked out as it's read so a
// remap or an unlink shows at once:
// { label (null: the app's "Imported"), source_guild_name, source_channel_name, importer_id,
//   imported_at, author: { name, avatar, mapped } }
// and makes its archive reactions `import_reactions` ([{ emoji, count, users: [{ user_id,
// name }] }]) and its command's `interaction.user_id` / `user_name` follow the mapping.
async function decorateImported(messages) {
  const imported = messages.filter((m) => m.import_id != null);
  if (!imported.length) return messages;
  const importIds = [...new Set(imported.map((m) => m.import_id))];
  const imports = new Map((await db.all(
    `SELECT id, label, source_guild_name, created_at, importer_id FROM guild_imports WHERE id IN (${placeholders(importIds)})`,
    importIds
  )).map((r) => [r.id, r]));
  const channelNames = new Map();
  for (const row of await db.all(
    `SELECT import_id, channel_id, name FROM guild_import_channels WHERE import_id IN (${placeholders(importIds)}) AND channel_id IS NOT NULL`,
    importIds
  )) {
    const key = `${row.import_id}:${row.channel_id}`;
    // Two archive channels in one: the tag names neither.
    channelNames.set(key, channelNames.has(key) ? null : row.name);
  }
  const parse = (json, fallback) => {
    if (json == null) return fallback;
    if (typeof json !== 'string') return json;
    try {
      return JSON.parse(json) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const authorIds = new Set();
  for (const m of imported) {
    authorIds.add(m.import_author_id);
    for (const r of parse(m.import_reactions, [])) for (const id of r.users ?? []) authorIds.add(id);
    const interaction = parse(m.interaction, null);
    if (interaction?.import_author_id) authorIds.add(interaction.import_author_id);
  }
  const ids = [...authorIds].filter(Number.isInteger);
  const authors = new Map(ids.length ? (await db.all(
    `SELECT id, name, avatar, user_id FROM guild_import_authors WHERE id IN (${placeholders(ids)})`,
    ids
  )).map((a) => [a.id, a]) : []);
  return messages.map((m) => {
    if (m.import_id == null) return m;
    const imp = imports.get(m.import_id);
    const author = authors.get(m.import_author_id);
    const interaction = parse(m.interaction, null);
    const invoker = interaction?.import_author_id ? authors.get(interaction.import_author_id) : null;
    return {
      ...m,
      imported: {
        label: imp?.label ?? null,
        source_guild_name: imp?.source_guild_name ?? null,
        source_channel_name: channelNames.get(`${m.import_id}:${m.channel_id}`) ?? null,
        importer_id: imp?.importer_id ?? null,
        imported_at: imp?.created_at ?? null,
        author: { name: author?.name ?? '?', avatar: author?.avatar ?? null, mapped: Boolean(author?.user_id) },
      },
      import_reactions: parse(m.import_reactions, []).map((r) => ({
        emoji: r.emoji,
        count: r.count,
        users: (r.users ?? []).map((id) => authors.get(id)).filter(Boolean).map((a) => ({ user_id: a.user_id ?? null, name: a.name })),
      })),
      ...(interaction && invoker ? {
        interaction: { ...interaction, user_id: invoker.user_id ?? null, user_name: invoker.name },
      } : {}),
    };
  });
}

module.exports = {
  LIMITS,
  enabled,
  requireImporter,
  listImports,
  importView,
  createImport,
  setMapping,
  addMessages,
  prepareImportFile,
  storeAuthorAvatar,
  finishImport,
  deleteImport,
  deleteGuildImports,
  deletePictures,
  linkedTo,
  unlink,
  unlinkDeletedUser,
  decorateImported,
  rewriteContent,
  previewsSettled,
};
