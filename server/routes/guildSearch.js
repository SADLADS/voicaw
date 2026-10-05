const express = require('express');
const db = require('../db');
const { authenticateJWT } = require('../auth');
const { PERMISSIONS, has, channelPermissions } = require('../permissions');
const { getMember, getOverrides } = require('../guilds');
const { HAS } = require('../searchText');
const { MESSAGE_SELECT, withReactions } = require('./guildMessages');

// Searching a guild's messages, like Discord's GET /guilds/:id/messages/search: only in the
// text channels the caller can see (the others don't exist for them). The client turns
// `from:` / `in:` / `has:` / `mentions:` in the search box into these parameters:
// - `content`: words, each matching a word starting with it (`"quoted words"`: that exact
//   phrase), all of them (the index: searchText.js, db.js). Something with no letters or
//   digits (an emoji) is looked for in the text as typed.
// - `author_id`, `channel_id`: any of them (repeat the parameter for several).
// - `has`: link, embed, file, image, video, sound, poll; all of them.
// - `mentions`: user ids named in the message (`<@id>`); all of them.
// - `sort_order`: desc (newest first, the default) or asc; `offset` (pages of 25).
// Returns { total_results, messages } (message rows as in a channel, plus their channel_id).
const router = express.Router();

const PAGE_SIZE = 25;
const MAX_OFFSET = 5000;
const MAX_CONTENT = 512;
const MAX_TERMS = 20;
const MAX_IDS = 25;

const list = (value) => (value == null ? [] : (Array.isArray(value) ? value : [value]))
  .flatMap((v) => String(v).split(','))
  .map((v) => v.trim())
  .filter(Boolean);

function ids(value) {
  const values = list(value);
  if (values.length > MAX_IDS || !values.every((v) => /^\d{1,15}$/.test(v))) return null;
  return [...new Set(values.map(Number))];
}

const ftsString = (s) => `"${s.replace(/"/g, '""')}"`;

// `content` → { match: an FTS5 query or null, likes: [text] } (null: nothing to search for).
function parseContent(content) {
  const match = [];
  const likes = [];
  for (const [, phrase, word] of content.matchAll(/"([^"]*)"|(\S+)/g)) {
    const text = (phrase ?? word).trim();
    if (!text) continue;
    if (!/[\p{L}\p{N}]/u.test(text)) likes.push(text);
    else match.push(phrase != null ? ftsString(text) : `${ftsString(text)}*`);
  }
  if (match.length + likes.length > MAX_TERMS) return null;
  return { match: match.length ? match.join(' ') : null, likes };
}

const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');

router.get('/guilds/:guildId/messages/search', authenticateJWT, async (req, res) => {
  const guildId = Number(req.params.guildId);
  const member = await getMember(guildId, req.user.id);
  if (!member) return res.status(404).json({ error: 'Guild not found' });

  const q = req.query;
  const content = typeof q.content === 'string' ? q.content.trim() : '';
  const authorIds = ids(q.author_id);
  const channelIds = ids(q.channel_id);
  const mentionIds = ids(q.mentions);
  const hasValues = list(q.has).map((v) => v.toLowerCase());
  const offset = q.offset == null ? 0 : Number(q.offset);
  const order = String(q.sort_order ?? 'desc').toLowerCase();
  if (content.length > MAX_CONTENT) return res.status(400).json({ error: 'That search is too long' });
  if (!authorIds || !channelIds || !mentionIds) return res.status(400).json({ error: 'Invalid id' });
  if (!hasValues.every((v) => Object.hasOwn(HAS, v))) return res.status(400).json({ error: 'Unknown has: value' });
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) return res.status(400).json({ error: 'Invalid offset' });
  if (!['asc', 'desc'].includes(order)) return res.status(400).json({ error: 'Invalid sort_order' });
  const terms = parseContent(content);
  if (!terms) return res.status(400).json({ error: 'Too many words in that search' });
  if (!terms.match && !terms.likes.length && !authorIds.length && !channelIds.length &&
    !mentionIds.length && !hasValues.length) {
    return res.status(400).json({ error: 'Nothing to search for' });
  }

  // The text and voice channels (their chats) the caller can see (of those asked for).
  const overrides = await getOverrides({ guildId });
  const channels = await db.all("SELECT id FROM guild_channels WHERE guild_id = ? AND type IN ('text', 'voice')", [guildId]);
  const visible = channels.map((c) => c.id).filter((id) =>
    (!channelIds.length || channelIds.includes(id)) &&
    has(channelPermissions(member, req.user.id, overrides.get(id) ?? []), PERMISSIONS.VIEW_CHANNEL));
  if (!visible.length) return res.json({ total_results: 0, messages: [] });

  const where = [`m.channel_id IN (${visible.map(() => '?').join(',')})`];
  const params = [...visible];
  if (terms.match) {
    where.push('m.id IN (SELECT rowid FROM guild_messages_fts WHERE guild_messages_fts MATCH ?)');
    params.push(terms.match);
  }
  for (const text of terms.likes) {
    where.push("m.content LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(text)}%`);
  }
  if (authorIds.length) {
    where.push(`m.sender_id IN (${authorIds.map(() => '?').join(',')})`);
    params.push(...authorIds);
  }
  for (const id of mentionIds) {
    where.push('m.content LIKE ?');
    params.push(`%<@${id}>%`);
  }
  const bits = hasValues.reduce((all, v) => all | HAS[v], 0);
  if (bits) {
    where.push('(m.search_has & ?) = ?');
    params.push(bits, bits);
  }

  const whereSql = where.join(' AND ');
  const { total } = await db.get(`SELECT COUNT(*) AS total FROM guild_messages m WHERE ${whereSql}`, params);
  const rows = total > offset
    ? await db.all(`${MESSAGE_SELECT} WHERE ${whereSql} ORDER BY m.id ${order.toUpperCase()} LIMIT ? OFFSET ?`, [...params, PAGE_SIZE, offset])
    : [];
  res.json({ total_results: total, messages: await withReactions(rows) });
});

module.exports = router;
