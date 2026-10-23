const db = require('./db');
const { s3Endpoint } = require('./config');
const { linkUploads } = require('./uploads');
const { uploadKeysIn } = require('./uploadKeys');

// Document channels (Guilded's docs): a feed of markdown documents, each with a title, an
// optional cover image, reactions and a thread of replies (guild_messages with document_id).
// Rows, limits and cleanup; routes are in routes/guildDocuments.js, live co-editing in
// documentCollab.js.

const MAX_TITLE = 200;
const MAX_CONTENT = 100000;
const MAX_COVER = 2048;
const MAX_DOCUMENTS_PER_CHANNEL = 1000;
const MAX_REACTIONS_PER_USER = 20;
const MAX_EMOJI_LENGTH = 64;
// How much of the start of a document the feed's cards get (they show an excerpt).
const CARD_CONTENT = 1000;

const DOCUMENT_COLUMNS = `d.id, d.channel_id, d.title, d.cover, d.created_by, d.created_at,
  d.updated_by, d.updated_at, d.version, d.open_editing`;

// The documents with their `reactions` ([{ id, user_id, emoji, timestamp }], oldest first),
// `reply_count`, `last_reply_at` (unix s or null) and `last_reply_id`.
async function withDetails(documents) {
  if (!documents.length) return documents;
  const ids = documents.map((d) => d.id);
  const marks = ids.map(() => '?').join(',');
  const reactions = await db.all(
    `SELECT id, document_id, user_id, emoji, timestamp FROM guild_document_reactions
     WHERE document_id IN (${marks}) ORDER BY id`,
    ids
  );
  const replies = await db.all(
    `SELECT document_id, COUNT(*) AS count, MAX(timestamp) AS last, MAX(id) AS last_id FROM guild_messages
     WHERE document_id IN (${marks}) AND system IS NULL GROUP BY document_id`,
    ids
  );
  const byDocument = new Map(ids.map((id) => [id, []]));
  for (const { document_id: documentId, ...reaction } of reactions) byDocument.get(documentId).push(reaction);
  const replyOf = new Map(replies.map((r) => [r.document_id, r]));
  return documents.map((d) => ({
    ...d,
    reactions: byDocument.get(d.id),
    reply_count: replyOf.get(d.id)?.count ?? 0,
    last_reply_at: replyOf.get(d.id)?.last ?? null,
    last_reply_id: replyOf.get(d.id)?.last_id ?? null,
  }));
}

// The channel's documents for its feed, newest first: everything but the content, of which
// only the start (`content_start`, for an excerpt).
async function channelDocuments(channelId) {
  return withDetails(await db.all(
    `SELECT ${DOCUMENT_COLUMNS}, substr(d.content, 1, ${CARD_CONTENT}) AS content_start
     FROM guild_documents d WHERE d.channel_id = ? ORDER BY d.id DESC`,
    [channelId]
  ));
}

// One document as its feed card (see channelDocuments), or null.
async function documentCard(id) {
  const row = await db.get(
    `SELECT ${DOCUMENT_COLUMNS}, substr(d.content, 1, ${CARD_CONTENT}) AS content_start
     FROM guild_documents d WHERE d.id = ?`,
    [id]
  );
  return row ? (await withDetails([row]))[0] : null;
}

// One document, content and all, or null.
async function getDocument(id) {
  if (!Number.isInteger(id)) return null;
  const row = await db.get(`SELECT ${DOCUMENT_COLUMNS}, d.content FROM guild_documents d WHERE d.id = ?`, [id]);
  return row ? (await withDetails([row]))[0] : null;
}

// Links document `id` to the uploads its text and cover show (uploads.js). Inside the
// transaction that wrote them.
async function linkDocumentUploads(id) {
  const row = await db.get('SELECT content, cover FROM guild_documents WHERE id = ?', [id]);
  await linkUploads('doc', id, uploadKeysIn([row.content, row.cover].filter(Boolean).join('\n')));
}

// ---- Checking what's sent ----

function cleanTitle(title) {
  if (typeof title !== 'string') return null;
  const trimmed = title.replace(/\s+/g, ' ').trim();
  return trimmed && trimmed.length <= MAX_TITLE ? trimmed : null;
}

// Markdown, trailing whitespace dropped; null if invalid.
function cleanContent(content) {
  if (typeof content !== 'string' || content.length > MAX_CONTENT) return null;
  return content.replace(/\s+$/, '');
}

// A cover is an upload of ours (its URL, with the key fragment of an encrypted channel
// attachment): undefined: not sent; null: none; false: invalid.
function cleanCover(cover) {
  if (cover === undefined) return undefined;
  if (cover === null || cover === '') return null;
  if (typeof cover !== 'string' || cover.length > MAX_COVER || /\s/.test(cover)) return false;
  return cover.startsWith(`${s3Endpoint}/uploads/`) ? cover : false;
}

// ---- Deleting ----

// A document's replies (and their reactions and mentions) and its own reactions, then the
// document. Returns the ids of the replies removed.
async function deleteDocumentRows(documentId) {
  const replies = await db.all('SELECT id FROM guild_messages WHERE document_id = ?', [documentId]);
  await db.run('DELETE FROM guild_reactions WHERE message_id IN (SELECT id FROM guild_messages WHERE document_id = ?)', [documentId]);
  await db.run('DELETE FROM guild_mentions WHERE message_id IN (SELECT id FROM guild_messages WHERE document_id = ?)', [documentId]);
  await db.run(
    `DELETE FROM poll_timers WHERE kind = 'guild' AND message_id IN (SELECT id FROM guild_messages WHERE document_id = ?)`,
    [documentId]
  );
  await db.run('DELETE FROM guild_messages WHERE document_id = ?', [documentId]);
  await db.run('DELETE FROM guild_document_reactions WHERE document_id = ?', [documentId]);
  await db.run('DELETE FROM guild_documents WHERE id = ?', [documentId]);
  return replies.map((r) => r.id);
}

// Every document of the channels (an SQL list of ids, as deleteChannelContents takes them);
// their replies are the channels' messages, which deleteChannelContents deletes itself.
async function deleteChannelDocuments(channelIdsSql, params) {
  await db.run(
    `DELETE FROM guild_document_reactions WHERE document_id IN
       (SELECT id FROM guild_documents WHERE channel_id IN (${channelIdsSql}))`,
    params
  );
  await db.run(`DELETE FROM guild_documents WHERE channel_id IN (${channelIdsSql})`, params);
}

module.exports = {
  MAX_TITLE,
  MAX_CONTENT,
  MAX_DOCUMENTS_PER_CHANNEL,
  MAX_REACTIONS_PER_USER,
  MAX_EMOJI_LENGTH,
  channelDocuments,
  documentCard,
  getDocument,
  linkDocumentUploads,
  cleanTitle,
  cleanContent,
  cleanCover,
  deleteDocumentRows,
  deleteChannelDocuments,
};
