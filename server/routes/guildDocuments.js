const express = require('express');
const db = require('../db');
const { authenticateJWT } = require('../auth');
const { PERMISSIONS, has } = require('../permissions');
const { getChannelAccess, sendToChannel } = require('../guilds');
const { logAudit } = require('../auditLog');
const {
  MAX_TITLE,
  MAX_CONTENT,
  MAX_DOCUMENTS_PER_CHANNEL,
  MAX_REACTIONS_PER_USER,
  MAX_EMOJI_LENGTH,
  channelDocuments,
  documentCard,
  getDocument,
  cleanTitle,
  cleanContent,
  cleanCover,
  deleteDocumentRows,
} = require('../guildDocuments');

// Document channels: documents and their reactions (replies are guild messages, see
// routes/guildMessages.js). The channel's permissions decide: View Channel sees the feed
// (without it, 404), Create Documents writes new ones and edits your own, Manage Messages
// edits and deletes anyone's, Add Reactions reacts. Saving needs the `version` you last saw,
// so a save never silently overwrites someone else's (409 with the newer document). Events go
// to whoever can see the channel.
const router = express.Router();

const now = () => Math.floor(Date.now() / 1000);
const forbidden = (res) => res.status(403).json({ error: "You don't have permission to do that" });
const notFound = (res, what = 'Document') => res.status(404).json({ error: `${what} not found` });

// The channel as the caller sees it ({ channel, member, permissions }), or null if it isn't a
// document channel they can see.
async function docChannelAccess(channelId, userId) {
  const access = await getChannelAccess(channelId, userId);
  if (!access || access.channel.type !== 'doc' || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) return null;
  return access;
}

async function requireDocChannel(req, res, next) {
  const access = await docChannelAccess(Number(req.params.channelId), req.user.id);
  if (!access) return notFound(res, 'Channel');
  req.access = access;
  next();
}

// req.document and req.access for the document in the URL (404 if the caller can't see it).
async function requireDocument(req, res, next) {
  const document = await getDocument(Number(req.params.documentId));
  const access = document && await docChannelAccess(document.channel_id, req.user.id);
  if (!access) return notFound(res);
  req.document = document;
  req.access = access;
  next();
}

// Authors with Create Documents, or anyone with Manage Messages.
const mayChange = (req) => has(req.access.permissions, PERMISSIONS.MANAGE_MESSAGES)
  || (req.document.created_by === req.user.id && has(req.access.permissions, PERMISSIONS.CREATE_DOCUMENTS));

const event = (access, type, fields) => ({ type, guildId: access.channel.guild_id, channelId: access.channel.id, ...fields });

async function announceCard(access, documentId) {
  await sendToChannel(access.channel, event(access, 'guild_document_upsert', { document: await documentCard(documentId) }));
}

// The feed: every document, newest first, without its content (`content_start` instead).
router.get('/channels/:channelId/documents', authenticateJWT, requireDocChannel, async (req, res) => {
  res.json(await channelDocuments(req.access.channel.id));
});

// { title, cover?, content? }
router.post('/channels/:channelId/documents', authenticateJWT, requireDocChannel, async (req, res) => {
  if (!has(req.access.permissions, PERMISSIONS.CREATE_DOCUMENTS)) return forbidden(res);
  const title = cleanTitle(req.body?.title);
  if (!title) return res.status(400).json({ error: `Titles are 1–${MAX_TITLE} characters` });
  const content = cleanContent(req.body?.content ?? '');
  if (content === null) return res.status(400).json({ error: `Documents are at most ${MAX_CONTENT} characters` });
  const cover = cleanCover(req.body?.cover);
  if (cover === false) return res.status(400).json({ error: 'Invalid cover image' });

  const { channel } = req.access;
  const id = await db.transaction(async () => {
    const { count } = await db.get('SELECT COUNT(*) AS count FROM guild_documents WHERE channel_id = ?', [channel.id]);
    if (count >= MAX_DOCUMENTS_PER_CHANNEL) return null;
    const at = now();
    const { lastID } = await db.run(
      `INSERT INTO guild_documents (channel_id, title, cover, content, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [channel.id, title, cover ?? null, content, req.user.id, at, req.user.id, at]
    );
    return lastID;
  });
  if (!id) return res.status(400).json({ error: `A channel holds at most ${MAX_DOCUMENTS_PER_CHANNEL} documents` });
  await announceCard(req.access, id);
  res.status(201).json(await getDocument(id));
});

router.get('/documents/:documentId', authenticateJWT, requireDocument, (req, res) => {
  res.json(req.document);
});

// { version, title?, cover?, content? }: `version` is the one the edit started from.
router.patch('/documents/:documentId', authenticateJWT, requireDocument, async (req, res) => {
  if (!mayChange(req)) return forbidden(res);
  const body = req.body ?? {};
  const changes = {};
  if (body.title !== undefined) {
    changes.title = cleanTitle(body.title);
    if (!changes.title) return res.status(400).json({ error: `Titles are 1–${MAX_TITLE} characters` });
  }
  if (body.content !== undefined) {
    changes.content = cleanContent(body.content);
    if (changes.content === null) return res.status(400).json({ error: `Documents are at most ${MAX_CONTENT} characters` });
  }
  const cover = cleanCover(body.cover);
  if (cover === false) return res.status(400).json({ error: 'Invalid cover image' });
  if (cover !== undefined) changes.cover = cover;
  if (!Number.isInteger(body.version)) return res.status(400).json({ error: 'Missing version' });

  const saved = await db.transaction(async () => {
    const sets = Object.keys(changes).map((column) => `${column} = ?`);
    const { changes: updated } = await db.run(
      `UPDATE guild_documents SET ${[...sets, 'updated_by = ?', 'updated_at = ?', 'version = version + 1'].join(', ')}
       WHERE id = ? AND version = ?`,
      [...Object.values(changes), req.user.id, now(), req.document.id, body.version]
    );
    return updated > 0;
  });
  if (!saved) {
    return res.status(409).json({
      error: 'Someone else saved this document since you opened it',
      document: await getDocument(req.document.id),
    });
  }
  const document = await getDocument(req.document.id);
  await sendToChannel(req.access.channel, event(req.access, 'guild_document_update', { document }));
  await announceCard(req.access, req.document.id);
  res.json(document);
});

// With its replies and reactions. In the audit log like a message delete (never its text).
router.delete('/documents/:documentId', authenticateJWT, requireDocument, async (req, res) => {
  if (!mayChange(req)) return forbidden(res);
  const { channel } = req.access;
  const replyIds = await db.transaction(async () => {
    await logAudit({
      guildId: channel.guild_id,
      action: 'document_delete',
      actorId: req.user.id,
      targetType: 'user',
      targetId: req.document.created_by,
      channelId: channel.id,
      details: { documentId: req.document.id, createdAt: req.document.created_at, channelName: channel.name },
    });
    return deleteDocumentRows(req.document.id);
  });
  await sendToChannel(channel, event(req.access, 'guild_document_delete', { documentId: req.document.id, replyIds }));
  res.json({ success: true, deletedId: req.document.id });
});

// ---- Reactions (plain emoji, one of each per person) ----

router.post('/documents/:documentId/reactions', authenticateJWT, requireDocument, async (req, res) => {
  if (!has(req.access.permissions, PERMISSIONS.ADD_REACTIONS)) return forbidden(res);
  const { emoji } = req.body ?? {};
  if (typeof emoji !== 'string' || !emoji || emoji.length > MAX_EMOJI_LENGTH || /\s/.test(emoji)) {
    return res.status(400).json({ error: 'Invalid reaction' });
  }
  const documentId = req.document.id;
  const { count } = await db.get(
    'SELECT COUNT(*) AS count FROM guild_document_reactions WHERE document_id = ? AND user_id = ?',
    [documentId, req.user.id]
  );
  if (count >= MAX_REACTIONS_PER_USER) return res.status(400).json({ error: 'Too many reactions on this document' });
  const { changes, lastID } = await db.run(
    'INSERT OR IGNORE INTO guild_document_reactions (document_id, user_id, emoji, timestamp) VALUES (?, ?, ?, ?)',
    [documentId, req.user.id, emoji, now()]
  );
  if (!changes) return res.status(409).json({ error: 'Already reacted with that' });
  const reaction = await db.get('SELECT id, document_id, user_id, emoji, timestamp FROM guild_document_reactions WHERE id = ?', [lastID]);
  await sendToChannel(req.access.channel, event(req.access, 'guild_document_reaction_add', { reaction }));
  res.status(201).json(reaction);
});

// Only your own reactions can be removed.
router.delete('/document-reactions/:reactionId', authenticateJWT, async (req, res) => {
  const reactionId = Number(req.params.reactionId);
  const reaction = Number.isInteger(reactionId) && await db.get(
    `SELECT r.id, r.document_id, r.user_id, d.channel_id FROM guild_document_reactions r
     JOIN guild_documents d ON d.id = r.document_id WHERE r.id = ?`,
    [reactionId]
  );
  const access = reaction && await docChannelAccess(reaction.channel_id, req.user.id);
  if (!access) return notFound(res, 'Reaction');
  if (reaction.user_id !== req.user.id) return res.status(403).json({ error: 'Not your reaction' });
  await db.run('DELETE FROM guild_document_reactions WHERE id = ?', [reactionId]);
  await sendToChannel(access.channel, event(access, 'guild_document_reaction_remove', { documentId: reaction.document_id, reactionId }));
  res.json({ success: true });
});

module.exports = router;
