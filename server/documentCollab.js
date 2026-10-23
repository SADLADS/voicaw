const crypto = require('crypto');
const db = require('./db');
const { sendToUserSockets } = require('./sockets');
const { sendToChannel } = require('./guilds');
const { releaseUploads } = require('./uploads');
const { MAX_CONTENT, getDocument, documentCard, linkDocumentUploads } = require('./guildDocuments');

// Live co-editing of documents (document channels, guildDocuments.js), ProseMirror's collab
// model: the server is the authority. Each document being edited has a session, in memory
// only, holding the document (a ProseMirror node in the editor's own schema,
// client/src/documents/documentSchema.js) and the steps applied to it since the session began,
// numbered by `version`. An editor sends the steps it made on top of the version it has; the
// server applies them (refusing any that don't fit the schema, or a stale version: the editor
// then fetches what it missed, rebases and sends again) and passes them to everyone else in the
// session. The server writes the document back as markdown itself (the same serializer as the
// client's), a moment after the last change, so the database, the feed and readers keep up
// without anyone pressing Save.
//
// A session starts when the first editor joins, from the document they parsed out of its
// markdown (the server has no markdown parser: that's the page's remark pipeline), and ends a
// little after the last one leaves (saved first). An API restart ends every session: the
// editors' apps rejoin (`session` changes) from the last save, at most SAVE_DELAY_MS behind.
//
// Sessions carry who is editing (`editors`, by the client id each editor made up: one person
// can be in twice, two tabs) and where their selection is, so editors see each other's
// cursors. Only editors get the session's events (`guild_document_steps`,
// `guild_document_presence`, `guild_document_details`, `guild_document_collab_end`); everyone
// else who can see the channel gets the saves, as before (`guild_document_update`). Who may
// join or send anything is checked on every request (routes/guildDocuments.js); an editor who
// stops sending heartbeats (EDITOR_TIMEOUT_MS) is dropped, so someone who lost access stops
// getting steps then.

const SAVE_DELAY_MS = 2000;
// Typing without a pause still saves this often.
const SAVE_MAX_WAIT_MS = 10000;
const EDITOR_TIMEOUT_MS = 45000;
const SWEEP_MS = 15000;
// Steps kept for editors catching up; one further behind loads the document again.
const MAX_KEPT_STEPS = 2000;
const MAX_STEPS_PER_REQUEST = 2000;
const MAX_EDITORS = 50;
const CLIENT_ID = /^[\w-]{1,40}$/;

// ProseMirror is ESM, and so are the client's schema and serializer: loaded once with import()
// (all of it that way, so steps, nodes and the schema share one copy of each class).
let proseMirror = null;
async function loadProseMirror() {
  if (!proseMirror) {
    proseMirror = Promise.all([
      import('prosemirror-model'),
      import('prosemirror-transform'),
      import('../client/src/documents/documentSchema.js'),
      import('../client/src/documents/documentSerializer.js'),
    ]).then(([model, transform, { schema }, { docToMarkdown }]) => ({
      Node: model.Node, Step: transform.Step, schema, docToMarkdown,
    }));
  }
  return proseMirror;
}

// documentId -> session
const sessions = new Map();
let sweepTimer = null;

const collabError = (status, message, extra = {}) => Object.assign(new Error(message), { status, extra });

function publicEditor(clientID, editor) {
  return { clientID, userId: editor.userId, anchor: editor.anchor, head: editor.head, version: editor.version };
}

// What an editor joining gets: everything needed to start from where the session is.
function sessionState(session) {
  return {
    session: session.id,
    version: session.version,
    doc: session.doc.toJSON(),
    title: session.title,
    cover: session.cover,
    open_editing: session.openEditing,
    editors: [...session.editors].map(([clientID, editor]) => publicEditor(clientID, editor)),
  };
}

// To every editor in the session (each person once, all their sockets; the app ignores
// sessions it isn't in).
function toEditors(session, payload) {
  const users = new Set([...session.editors.values()].map((e) => e.userId));
  for (const userId of users) sendToUserSockets(userId, { documentId: session.documentId, session: session.id, ...payload });
}

function ensureSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweep, SWEEP_MS);
  sweepTimer.unref?.();
}

// Drops editors gone quiet, and ends sessions nobody is in.
function sweep() {
  const now = Date.now();
  for (const session of sessions.values()) {
    for (const [clientID, editor] of session.editors) {
      if (now - editor.at > EDITOR_TIMEOUT_MS) removeEditor(session, clientID);
    }
  }
  if (!sessions.size) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

function removeEditor(session, clientID) {
  if (!session.editors.delete(clientID)) return;
  toEditors(session, { type: 'guild_document_presence', left: clientID });
  if (!session.editors.size) endSession(session).catch((err) => console.error('Failed to end a document session', err));
}

// ---- Saving ----

function scheduleSave(session) {
  session.dirty = true;
  session.dirtySince ??= Date.now();
  clearTimeout(session.saveTimer);
  const wait = Math.max(0, Math.min(SAVE_DELAY_MS, session.dirtySince + SAVE_MAX_WAIT_MS - Date.now()));
  session.saveTimer = setTimeout(() => {
    save(session).catch((err) => console.error('Failed to save a live document', err));
  }, wait);
  session.saveTimer.unref?.();
}

// Writes the session's document, title, cover and open editing to the database (one at a time:
// a save asked for while one runs follows it), and tells the channel.
function save(session) {
  clearTimeout(session.saveTimer);
  session.saving = (session.saving ?? Promise.resolve()).then(() => writeSession(session));
  return session.saving;
}

async function writeSession(session) {
  if (!session.dirty) return;
  session.dirty = false;
  session.dirtySince = null;
  const { docToMarkdown } = await loadProseMirror();
  const content = docToMarkdown(session.doc);
  const written = await db.transaction(async () => {
    const { changes } = await db.run(
      `UPDATE guild_documents SET content = ?, title = ?, cover = ?, open_editing = ?, updated_by = ?, updated_at = ?,
       version = version + 1 WHERE id = ?`,
      [content, session.title, session.cover, session.openEditing, session.lastEditor, Math.floor(Date.now() / 1000), session.documentId]
    );
    if (changes) await linkDocumentUploads(session.documentId);
    return changes > 0;
  });
  // Deleted meanwhile (the document or its channel).
  if (!written) return;
  releaseUploads();
  const document = await getDocument(session.documentId);
  session.savedVersion = document.version;
  const channel = await db.get('SELECT id, guild_id, type FROM guild_channels WHERE id = ?', [session.channelId]);
  if (!channel) return;
  const base = { guildId: channel.guild_id, channelId: channel.id };
  await sendToChannel(channel, { type: 'guild_document_update', ...base, document });
  await sendToChannel(channel, { type: 'guild_document_upsert', ...base, document: await documentCard(session.documentId) });
  toEditors(session, { type: 'guild_document_saved', savedVersion: document.version, version: session.version });
}

// Saves what's unsaved and forgets the session. `notify`: tell its editors it's over (their apps
// load the document again).
async function endSession(session, { notify = false, saveFirst = true } = {}) {
  if (sessions.get(session.documentId) !== session) return;
  sessions.delete(session.documentId);
  clearTimeout(session.saveTimer);
  if (notify) toEditors(session, { type: 'guild_document_collab_end' });
  if (saveFirst) await save(session);
}

// ---- What the routes call ----

// The session of `document` ({ id, channel_id, title, cover, open_editing, version }), joined by
// `userId` as `clientID`. Without one, `doc` (the editor's parse of the document's markdown, as
// ProseMirror JSON, `basedOn` the document's version it was parsed from) starts it; without
// `doc`, or from an old version: 409 `needsDoc` (with the document as it is now).
async function join(document, userId, clientID, { doc, basedOn } = {}) {
  if (typeof clientID !== 'string' || !CLIENT_ID.test(clientID)) throw collabError(400, 'Invalid client id');
  let session = sessions.get(document.id);
  if (!session) {
    if (doc == null || basedOn !== document.version) {
      throw collabError(409, 'Start the session from the document as it is now', { needsDoc: true, document });
    }
    const { Node, schema } = await loadProseMirror();
    let node;
    try {
      node = Node.fromJSON(schema, doc);
      node.check();
    } catch {
      throw collabError(400, 'Invalid document');
    }
    if (node.type !== schema.topNodeType) throw collabError(400, 'Invalid document');
    // Another editor may have started it while this one was being checked.
    session = sessions.get(document.id);
    if (!session) {
      session = {
        id: crypto.randomBytes(9).toString('base64url'),
        documentId: document.id,
        channelId: document.channel_id,
        doc: node,
        version: 0,
        steps: [], // { step (JSON), clientID }, the last MAX_KEPT_STEPS
        title: document.title,
        cover: document.cover,
        openEditing: document.open_editing ? 1 : 0,
        lastEditor: userId,
        savedVersion: document.version,
        editors: new Map(),
        dirty: false,
      };
      sessions.set(document.id, session);
      ensureSweep();
    }
  }
  const existing = session.editors.get(clientID);
  if (existing && existing.userId !== userId) throw collabError(409, 'That client id is taken');
  if (!existing && session.editors.size >= MAX_EDITORS) throw collabError(400, `At most ${MAX_EDITORS} people can edit a document at once`);
  const editor = { userId, anchor: null, head: null, version: session.version, at: Date.now() };
  session.editors.set(clientID, editor);
  if (!existing) toEditors(session, { type: 'guild_document_presence', editor: publicEditor(clientID, editor) });
  return sessionState(session);
}

// The session `sessionId` of document `documentId` with `clientID` in it as `userId`, or a 410
// (the session ended: rejoin).
function editorSession(documentId, sessionId, userId, clientID) {
  const session = sessions.get(documentId);
  const editor = session && session.id === sessionId && session.editors.get(clientID);
  if (!editor || editor.userId !== userId) throw collabError(410, 'This editing session has ended');
  editor.at = Date.now();
  return { session, editor };
}

// `steps` (ProseMirror JSON) made by `clientID` on top of `version`: applied, kept and sent to
// the other editors. A stale `version` is 409 (`version`: the session's).
async function receiveSteps(documentId, userId, { session: sessionId, clientID, version, steps }) {
  const { session } = editorSession(documentId, sessionId, userId, clientID);
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS_PER_REQUEST) throw collabError(400, 'Invalid steps');
  if (version !== session.version) throw collabError(409, 'Behind the session', { version: session.version });
  const { Step, schema, docToMarkdown } = await loadProseMirror();
  let doc = session.doc;
  try {
    for (const json of steps) {
      const result = Step.fromJSON(schema, json).apply(doc);
      if (result.failed || !result.doc) throw new Error(result.failed);
      doc = result.doc;
    }
    doc.check();
  } catch {
    throw collabError(400, "Those changes don't fit the document");
  }
  if (docToMarkdown(doc).length > MAX_CONTENT) throw collabError(400, `Documents are at most ${MAX_CONTENT} characters`);
  // Another request's steps, or the session's end, may have come in during the await above.
  if (sessions.get(documentId) !== session || version !== session.version) throw collabError(409, 'Behind the session', { version: session.version });
  session.doc = doc;
  session.version += steps.length;
  for (const step of steps) session.steps.push({ step, clientID });
  if (session.steps.length > MAX_KEPT_STEPS) session.steps.splice(0, session.steps.length - MAX_KEPT_STEPS);
  session.lastEditor = userId;
  scheduleSave(session);
  toEditors(session, { type: 'guild_document_steps', version: session.version, steps, clientIDs: steps.map(() => clientID) });
  return { version: session.version };
}

// The steps since `since` (for an editor that missed some), or 410 when they're no longer kept.
function stepsSince(documentId, userId, { session: sessionId, clientID, since }) {
  const { session } = editorSession(documentId, sessionId, userId, clientID);
  const first = session.version - session.steps.length;
  if (!Number.isInteger(since) || since > session.version) throw collabError(400, 'Invalid version');
  if (since < first) throw collabError(410, 'Too far behind: load the document again');
  const kept = session.steps.slice(since - first);
  return { version: session.version, steps: kept.map((s) => s.step), clientIDs: kept.map((s) => s.clientID) };
}

const position = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

// Where `clientID`'s selection is (positions in the document at `version`), which also says
// they're still there.
function setPresence(documentId, userId, { session: sessionId, clientID, version, anchor, head }) {
  const { session, editor } = editorSession(documentId, sessionId, userId, clientID);
  const at = Number.isInteger(version) && version <= session.version ? version : null;
  const next = at == null ? { anchor: null, head: null } : { anchor: position(anchor), head: position(head) };
  if (next.anchor !== editor.anchor || next.head !== editor.head || at !== editor.version) {
    Object.assign(editor, next, { version: at });
    toEditors(session, { type: 'guild_document_presence', editor: publicEditor(clientID, editor) });
  }
  return { version: session.version };
}

function leave(documentId, userId, { session: sessionId, clientID }) {
  const session = sessions.get(documentId);
  if (!session || session.id !== sessionId || session.editors.get(clientID)?.userId !== userId) return;
  removeEditor(session, clientID);
}

// The title, cover or open editing (`changes`, already checked) of the document being edited:
// the session's from now on, saved with its text.
function setDetails(documentId, userId, { session: sessionId, clientID }, changes) {
  const { session } = editorSession(documentId, sessionId, userId, clientID);
  if (changes.title !== undefined) session.title = changes.title;
  if (changes.cover !== undefined) session.cover = changes.cover;
  if (changes.openEditing !== undefined) session.openEditing = changes.openEditing ? 1 : 0;
  session.lastEditor = userId;
  scheduleSave(session);
  toEditors(session, {
    type: 'guild_document_details', by: clientID, title: session.title, cover: session.cover, open_editing: session.openEditing,
  });
  return { title: session.title, cover: session.cover, open_editing: session.openEditing };
}

// The session's open editing (1 or 0: newer than the saved row's), or null without a session.
function openEditingOf(documentId) {
  return sessions.get(documentId)?.openEditing ?? null;
}

// The people editing the document now.
function editorUserIds(documentId) {
  return [...new Set([...(sessions.get(documentId)?.editors.values() ?? [])].map((e) => e.userId))];
}

// Takes `userId` (every tab of theirs) out of the session; their apps are told it ended for
// them, so they join again (and are refused).
function removeUser(documentId, userId) {
  const session = sessions.get(documentId);
  if (!session) return;
  const theirs = [...session.editors].filter(([, e]) => e.userId === userId).map(([clientID]) => clientID);
  if (!theirs.length) return;
  sendToUserSockets(userId, { type: 'guild_document_collab_end', documentId, session: session.id });
  for (const clientID of theirs) removeEditor(session, clientID);
}

// Before a save that doesn't go through the session (PATCH with the whole document): what the
// session hasn't saved yet is saved, so that save's version check sees it.
async function flush(documentId) {
  const session = sessions.get(documentId);
  if (session) await save(session);
}

// A document changed outside its session (a whole-document save) or deleted: the session ends
// (its editors' apps load the document again, or see it's gone), without saving.
async function closeSession(documentId) {
  const session = sessions.get(documentId);
  if (session) await endSession(session, { notify: true, saveFirst: false });
}

// Every session's unsaved changes, written (tests; and before the process exits).
async function saveAll() {
  await Promise.all([...sessions.values()].map((s) => save(s)));
}

module.exports = {
  SAVE_DELAY_MS,
  EDITOR_TIMEOUT_MS,
  MAX_KEPT_STEPS,
  join,
  receiveSteps,
  stepsSince,
  setPresence,
  setDetails,
  leave,
  openEditingOf,
  editorUserIds,
  removeUser,
  flush,
  closeSession,
  saveAll,
  sweep,
  // Tests
  sessions,
};
