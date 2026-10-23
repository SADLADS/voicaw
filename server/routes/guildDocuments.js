const express = require('express');
const db = require('../db');
const { authenticateJWT } = require('../auth');
const { PERMISSIONS, has } = require('../permissions');
const { getChannelAccess, sendToChannel } = require('../guilds');
const { logAudit } = require('../auditLog');
const { releaseUploads } = require('../uploads');
const levels = require('../guildLevels');
const collab = require('../documentCollab');
const {
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
} = require('../guildDocuments');

// Document channels: documents and their reactions (replies are guild messages, see
// routes/guildMessages.js). The channel's permissions decide: View Channel sees the feed
// (without it, 404), Create Documents writes new ones and edits your own (and others' that
// their author opened to editing), Manage Messages edits and deletes anyone's, Add Reactions
// reacts. Editing is live (documentCollab.js, the /collab routes): everyone editing a document
// sees the others' changes and cursors as they happen, and the server saves. A whole-document
// save (PATCH) still works, needing the `version` you last saw, so it never silently
// overwrites someone else's (409 with the newer document). Events go to whoever can see the
// channel.
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

// Deleting, and opening a document to everyone's editing: its author with Create Documents, or
// anyone with Manage Messages.
const managing = (permissions, document, userId) => has(permissions, PERMISSIONS.MANAGE_MESSAGES)
  || (document.created_by === userId && has(permissions, PERMISSIONS.CREATE_DOCUMENTS));
// Editing: those, and anyone with Create Documents once the author opened it to editing (the
// live session's say, when it's being edited: newer than the saved row).
const editing = (permissions, document, userId) => managing(permissions, document, userId)
  || (Boolean(collab.openEditingOf(document.id) ?? document.open_editing) && has(permissions, PERMISSIONS.CREATE_DOCUMENTS));
const mayManage = (req) => managing(req.access.permissions, req.document, req.user.id);
const mayChange = (req) => editing(req.access.permissions, req.document, req.user.id);

const event = (access, type, fields) => ({ type, guildId: access.channel.guild_id, channelId: access.channel.id, ...fields });

async function announceCard(access, documentId) {
  await sendToChannel(access.channel, event(access, 'guild_document_upsert', { document: await documentCard(documentId) }));
}

// The feed: every document, newest first, without its content (`content_start` instead).
router.get('/channels/:channelId/documents', authenticateJWT, requireDocChannel, async (req, res) => {
  res.json(await channelDocuments(req.access.channel.id));
});

// { title, cover?, content?, open_editing? }
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
      `INSERT INTO guild_documents (channel_id, title, cover, content, created_by, created_at, updated_by, updated_at, open_editing)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [channel.id, title, cover ?? null, content, req.user.id, at, req.user.id, at, req.body?.open_editing ? 1 : 0]
    );
    await linkDocumentUploads(lastID);
    return lastID;
  });
  if (!id) return res.status(400).json({ error: `A channel holds at most ${MAX_DOCUMENTS_PER_CHANNEL} documents` });
  await announceCard(req.access, id);
  await levels.award(channel.guild_id, req.user.id, 'documentCreated');
  res.status(201).json(await getDocument(id));
});

router.get('/documents/:documentId', authenticateJWT, requireDocument, (req, res) => {
  res.json(req.document);
});

// { version, title?, cover?, content?, open_editing? }: `version` is the one the edit started
// from. Anything the live session (if any) hasn't saved yet counts as a newer save; a save that
// goes through ends the session (its editors load the document again).
router.patch('/documents/:documentId', authenticateJWT, requireDocument, async (req, res) => {
  if (!mayChange(req)) return forbidden(res);
  const body = req.body ?? {};
  const changes = {};
  if (body.open_editing !== undefined) {
    if (!mayManage(req)) return forbidden(res);
    changes.open_editing = body.open_editing ? 1 : 0;
  }
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

  await collab.flush(req.document.id);
  const saved = await db.transaction(async () => {
    const sets = Object.keys(changes).map((column) => `${column} = ?`);
    const { changes: updated } = await db.run(
      `UPDATE guild_documents SET ${[...sets, 'updated_by = ?', 'updated_at = ?', 'version = version + 1'].join(', ')}
       WHERE id = ? AND version = ?`,
      [...Object.values(changes), req.user.id, now(), req.document.id, body.version]
    );
    if (updated) await linkDocumentUploads(req.document.id);
    return updated > 0;
  });
  if (saved) releaseUploads();
  if (!saved) {
    return res.status(409).json({
      error: 'Someone else saved this document since you opened it',
      document: await getDocument(req.document.id),
    });
  }
  await collab.closeSession(req.document.id);
  const document = await getDocument(req.document.id);
  await sendToChannel(req.access.channel, event(req.access, 'guild_document_update', { document }));
  await announceCard(req.access, req.document.id);
  res.json(document);
});

// With its replies and reactions. In the audit log like a message delete (never its text).
router.delete('/documents/:documentId', authenticateJWT, requireDocument, async (req, res) => {
  if (!mayManage(req)) return forbidden(res);
  const { channel } = req.access;
  await collab.closeSession(req.document.id);
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
  releaseUploads();
  await sendToChannel(channel, event(req.access, 'guild_document_delete', { documentId: req.document.id, replyIds }));
  res.json({ success: true, deletedId: req.document.id });
});

// ---- Live editing (documentCollab.js) ----

// Those who may edit it; someone who no longer may is taken out of the session.
function requireEditor(req, res, next) {
  if (mayChange(req)) return next();
  const { session, clientID } = { ...req.query, ...req.body };
  collab.leave(req.document.id, req.user.id, { session, clientID });
  return forbidden(res);
}

// Runs a documentCollab call, its errors ({ status, extra }) as responses.
const collabRoute = (handler) => async (req, res) => {
  try {
    res.json(await handler(req));
  } catch (err) {
    if (!err.status) throw err;
    res.status(err.status).json({ error: err.message, ...err.extra });
  }
};

const collabRoutes = [authenticateJWT, requireDocument, requireEditor];

// Joins (or starts) the editing session: { clientID, doc?, basedOn? } (see collab.join).
router.post('/documents/:documentId/collab', ...collabRoutes, collabRoute((req) => (
  collab.join(req.document, req.user.id, req.body?.clientID, { doc: req.body?.doc, basedOn: req.body?.basedOn })
)));

// { session, clientID, version, steps }
router.post('/documents/:documentId/collab/steps', ...collabRoutes, collabRoute((req) => (
  collab.receiveSteps(req.document.id, req.user.id, req.body ?? {})
)));

// ?session&clientID&since: the steps after version `since`.
router.get('/documents/:documentId/collab/steps', ...collabRoutes, collabRoute((req) => (
  collab.stepsSince(req.document.id, req.user.id, { ...req.query, since: Number(req.query.since) })
)));

// { session, clientID, version, anchor, head }: where your selection is; also a heartbeat.
router.post('/documents/:documentId/collab/presence', ...collabRoutes, collabRoute((req) => (
  collab.setPresence(req.document.id, req.user.id, req.body ?? {})
)));

// { session, clientID, title?, cover?, open_editing? }
router.post('/documents/:documentId/collab/details', ...collabRoutes, collabRoute(async (req) => {
  const body = req.body ?? {};
  const changes = {};
  const invalid = (message) => Object.assign(new Error(message), { status: 400 });
  if (body.title !== undefined) {
    changes.title = cleanTitle(body.title);
    if (!changes.title) throw invalid(`Titles are 1–${MAX_TITLE} characters`);
  }
  const cover = cleanCover(body.cover);
  if (cover === false) throw invalid('Invalid cover image');
  if (cover !== undefined) changes.cover = cover;
  if (body.open_editing !== undefined) {
    if (!mayManage(req)) throw Object.assign(new Error("You don't have permission to do that"), { status: 403 });
    changes.openEditing = Boolean(body.open_editing);
  }
  const result = collab.setDetails(req.document.id, req.user.id, body, changes);
  // Closed to editing: whoever may no longer edit leaves the session now.
  if (changes.openEditing === false) {
    for (const userId of collab.editorUserIds(req.document.id)) {
      const access = await docChannelAccess(req.document.channel_id, userId);
      if (!access || !editing(access.permissions, req.document, userId)) collab.removeUser(req.document.id, userId);
    }
  }
  return result;
}));

// { session, clientID }
router.post('/documents/:documentId/collab/leave', authenticateJWT, requireDocument, (req, res) => {
  collab.leave(req.document.id, req.user.id, req.body ?? {});
  res.json({ success: true });
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
