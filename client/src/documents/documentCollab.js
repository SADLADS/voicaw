import { collab, getVersion, receiveTransaction, sendableSteps } from 'prosemirror-collab';
import { Selection, TextSelection } from 'prosemirror-state';
import { Step } from 'prosemirror-transform';
import { schema } from './documentSchema';
import { markdownToDoc } from './documentMarkdown';
import { collabCursorsPlugin, getCursors, setCursors } from './collabCursors';
import {
  fetchDocumentSteps, joinDocumentCollab, leaveDocumentCollab, sendDocumentPresence, sendDocumentSteps, setDocumentDetails,
} from '../services/guildService';
import { onConnectionState, onGuildEvent } from '../utils/ws-client';

// Editing a document live with everyone else editing it (the server's side, the authority, is
// server/documentCollab.js): ProseMirror's collab model. This editor's changes are sent as
// steps on top of the last version it got from the server; the server applies them in order
// and passes them on (`guild_document_steps`), so everyone ends with the same document. Steps
// refused for being behind are rebased on the ones missed (fetched) and sent again. Each
// editor's selection is shared too (collabCursors.js), mapped back to the server's version
// before it's sent and forward through whatever happened here since when one comes in.
//
// The server saves the document itself a moment after each change; `status` says whether
// everything typed here is saved. If the session goes (an API restart, a long time offline),
// this joins again: changes not yet confirmed are kept when the document there is the one they
// were made on, and otherwise dropped (`onNotice('lost')`).

// The other editors' cursors are mapped forward through at most this many steps.
const KEPT_MAPS = 500;
const PRESENCE_DELAY_MS = 250;
const HEARTBEAT_MS = 20000;
const RETRY_MS = 3000;
// After a send, the steps come back over the websocket; without them by then, they're fetched.
const ECHO_WAIT_MS = 1500;
// Done waits this long for the last changes to reach the server.
const FINISH_WAIT_MS = 5000;
// Marks a transaction as someone else's steps (or a reload), so it isn't sent back.
const REMOTE = 'documentCollabRemote';

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
const statusOf = (err) => err?.response?.status;

export const isRemote = (tr) => Boolean(tr.getMeta(REMOTE));

// Starts editing `document` ({ id, content, version }) live in `view` (made from its content,
// not editable yet). `makeState(doc, plugins)` makes an editor state with the editor's own
// plugins plus these. Calls back with:
// - onStatus('connecting' | 'saving' | 'saved' | 'offline')
// - onEditors([{ clientID, userId }]) everyone else editing
// - onDetails({ title, cover, open_editing }) when they change (also on joining)
// - onNotice('lost' | 'refused', error?) changes that couldn't be kept
// - onEnded('forbidden' | 'deleted') editing can't go on
// Returns { changed(tr) (after each transaction), details(changes), finish(), stop(), hasUnsaved(),
// refreshCursors() }.
export function startDocumentCollab({ view, document, makeState, onStatus, onEditors, onDetails, onNotice, onEnded }) {
  const documentId = document.id;
  const clientID = randomId();
  let session = null;
  let stopped = false;
  let inFlight = false;
  let catching = null;
  let joining = null;
  // The document at the version this editor has (without its own unconfirmed steps), to tell
  // whether those can be kept after joining again.
  let confirmedDoc = null;
  // The step maps of the last KEPT_MAPS versions: { from: version, maps }.
  let history = { from: 0, maps: [] };
  // Other editors as the server last said: clientID -> { userId, anchor, head, version }.
  const editors = new Map();
  // The version of this editor's last confirmed steps, and the last saved one.
  let ownVersion = 0;
  let savedVersion = 0;
  let status = null;
  // The last request failed for want of a connection (retried until one goes through).
  let offline = false;
  const timers = { presence: null, heartbeat: null, retry: null, echo: null };

  const setStatus = (next) => {
    if (next !== status) onStatus?.((status = next));
  };
  const refreshStatus = () => {
    if (!session) return;
    if (offline) setStatus('offline');
    else setStatus(sendableSteps(view.state) || inFlight || savedVersion < ownVersion ? 'saving' : 'saved');
  };
  const goOffline = (retry) => {
    offline = true;
    setStatus('offline');
    clearTimeout(timers.retry);
    timers.retry = setTimeout(retry, RETRY_MS);
  };
  const publishEditors = () => onEditors?.([...editors].map(([id, e]) => ({ clientID: id, userId: e.userId })));
  const ids = () => ({ session, clientID });

  // ---- Cursors ----

  // `editor`'s positions (in the server's version `editor.version`) in this editor's document,
  // or null when they can't be worked out (not yet caught up to theirs: they're placed when
  // this is).
  function cursorHere(editor) {
    const { state } = view;
    const local = getVersion(state);
    if (editor.anchor == null || editor.version == null || editor.version > local || editor.version < history.from) return null;
    const maps = history.maps.slice(editor.version - history.from, local - history.from);
    for (const step of sendableSteps(state)?.steps ?? []) maps.push(step.getMap());
    const map = (pos) => maps.reduce((p, m) => m.map(p), pos);
    return { userId: editor.userId, anchor: map(editor.anchor), head: map(editor.head) };
  }

  // Places every editor's cursor again (after joining, or when one moved).
  function placeCursors(only = null) {
    const cursors = new Map(only ? getCursors(view.state) : []);
    for (const [id, editor] of editors) {
      if (only && id !== only) continue;
      const here = cursorHere(editor);
      if (here) cursors.set(id, here);
      else cursors.delete(id);
    }
    view.dispatch(setCursors(view.state, cursors).setMeta(REMOTE, true).setMeta('addToHistory', false));
  }

  // ---- Joining ----

  async function joinSession() {
    // A session to start comes from the document as it is now (asked for when there's none).
    let body = { clientID };
    for (let attempt = 0; ; attempt++) {
      try {
        return await joinDocumentCollab(documentId, body);
      } catch (err) {
        const data = err.response?.data;
        if (statusOf(err) !== 409 || !data?.needsDoc || attempt > 3) throw err;
        body = { clientID, doc: markdownToDoc(data.document.content).toJSON(), basedOn: data.document.version };
      }
    }
  }

  function join() {
    if (joining) return joining;
    joining = (async () => {
      setStatus('connecting');
      const before = session && { doc: confirmedDoc, steps: sendableSteps(view.state)?.steps ?? [] };
      let state;
      try {
        state = await joinSession();
      } catch (err) {
        if (stopped) return;
        if (statusOf(err) === 403) return end('forbidden');
        if (statusOf(err) === 404) return end('deleted');
        goOffline(join);
        return;
      }
      if (stopped) return;
      offline = false;
      session = state.session;
      confirmedDoc = schema.nodeFromJSON(state.doc);
      history = { from: state.version, maps: [] };
      ownVersion = state.version;
      savedVersion = state.version;
      let next = makeState(confirmedDoc, [collab({ version: state.version, clientID }), collabCursorsPlugin()]);
      // Unconfirmed changes from before go on again if they were made on this same document.
      if (before?.steps.length) {
        if (before.doc?.eq(confirmedDoc)) {
          const tr = next.tr;
          for (const step of before.steps) tr.maybeStep(step);
          next = next.apply(tr);
        } else {
          onNotice?.('lost');
        }
      }
      const { anchor, head } = view.state.selection;
      const size = next.doc.content.size;
      try {
        next = next.apply(next.tr.setSelection(TextSelection.create(next.doc, Math.min(anchor, size), Math.min(head, size))));
      } catch {
        next = next.apply(next.tr.setSelection(Selection.atStart(next.doc)));
      }
      view.updateState(next);
      editors.clear();
      for (const editor of state.editors) if (editor.clientID !== clientID) editors.set(editor.clientID, editor);
      publishEditors();
      placeCursors();
      onDetails?.({ title: state.title, cover: state.cover, open_editing: state.open_editing });
      refreshStatus();
      return true;
    })().finally(() => { joining = null; });
    // Once joined (send waits while joining): what's kept goes, and this editor's cursor.
    joining.then((joined) => {
      if (!joined || stopped) return;
      send();
      sendPresence();
    });
    return joining;
  }

  function end(reason) {
    stop({ leave: false });
    onEnded?.(reason);
  }

  // A request about this session failed: what to do about it (true: it's been dealt with).
  function handleLost(err) {
    const code = statusOf(err);
    if (code === 410) { join(); return true; }
    if (code === 403) { end('forbidden'); return true; }
    if (code === 404) { end('deleted'); return true; }
    return false;
  }

  // ---- Steps ----

  // Someone's steps, `from` the version they start at (already-had ones are skipped).
  function receive(from, stepsJson, clientIDs) {
    const local = getVersion(view.state);
    if (from > local) { catchUp(); return; }
    const skip = local - from;
    if (skip >= stepsJson.length) return;
    const steps = stepsJson.slice(skip).map((json) => Step.fromJSON(schema, json));
    for (const step of steps) {
      const result = step.apply(confirmedDoc);
      // Can't happen while in step with the server; if it does, start again from its copy.
      if (result.failed) { join(); return; }
      confirmedDoc = result.doc;
      history.maps.push(step.getMap());
    }
    if (history.maps.length > KEPT_MAPS) {
      const drop = history.maps.length - KEPT_MAPS;
      history = { from: history.from + drop, maps: history.maps.slice(drop) };
    }
    view.dispatch(receiveTransaction(view.state, steps, clientIDs.slice(skip), { mapSelectionBackward: true }).setMeta(REMOTE, true));
    // Cursors from versions this editor hadn't reached yet can be placed now.
    for (const [id, editor] of editors) if (editor.version > local) placeCursors(id);
    refreshStatus();
    send();
  }

  function catchUp() {
    if (catching || !session) return catching;
    const forSession = session;
    catching = fetchDocumentSteps(documentId, { ...ids(), since: getVersion(view.state) })
      .then((res) => {
        if (forSession !== session || stopped) return;
        offline = false;
        receive(res.version - res.steps.length, res.steps, res.clientIDs);
      })
      .catch((err) => {
        if (stopped || forSession !== session) return;
        if (!handleLost(err)) goOffline(() => catchUp()?.then(() => send()));
      })
      .finally(() => { catching = null; });
    return catching;
  }

  async function send() {
    if (stopped || !session || inFlight || joining) return;
    const sendable = sendableSteps(view.state);
    if (!sendable) { refreshStatus(); return; }
    inFlight = true;
    refreshStatus();
    const forSession = session;
    try {
      const { version } = await sendDocumentSteps(documentId, {
        ...ids(), version: sendable.version, steps: sendable.steps.map((s) => s.toJSON()),
      });
      inFlight = false;
      if (stopped || forSession !== session) return;
      offline = false;
      ownVersion = Math.max(ownVersion, version);
      clearTimeout(timers.echo);
      if (getVersion(view.state) < version) timers.echo = setTimeout(() => { if (getVersion(view.state) < version) catchUp(); }, ECHO_WAIT_MS);
      refreshStatus();
    } catch (err) {
      inFlight = false;
      if (stopped || forSession !== session) return;
      const code = statusOf(err);
      if (code === 409) {
        await catchUp();
      } else if (code === 400) {
        // Refused (too long, or not fitting the document): this editor's unconfirmed changes go.
        onNotice?.('refused', err.response?.data?.error);
        session = null;
        await join();
        return;
      } else {
        if (!handleLost(err)) goOffline(send);
        return;
      }
    }
    send();
  }

  // ---- Presence ----

  // This editor's selection, mapped back to the server's version (before its own unconfirmed
  // steps); also a heartbeat.
  function sendPresence() {
    clearTimeout(timers.presence);
    clearTimeout(timers.heartbeat);
    timers.heartbeat = setTimeout(sendPresence, HEARTBEAT_MS);
    if (!session || stopped) return;
    const { state } = view;
    let { anchor, head } = state.selection;
    const unconfirmed = sendableSteps(state)?.steps ?? [];
    for (let i = unconfirmed.length - 1; i >= 0; i--) {
      const back = unconfirmed[i].getMap().invert();
      anchor = back.map(anchor);
      head = back.map(head);
    }
    const forSession = session;
    sendDocumentPresence(documentId, { ...ids(), version: getVersion(state), anchor, head })
      .catch((err) => { if (!stopped && forSession === session) handleLost(err); });
  }

  // ---- Events ----

  const offEvents = onGuildEvent((event) => {
    if (stopped || event.documentId !== documentId || !session || event.session !== session) return;
    switch (event.type) {
      case 'guild_document_steps':
        receive(event.version - event.steps.length, event.steps, event.clientIDs);
        break;
      case 'guild_document_presence':
        if (event.left) {
          editors.delete(event.left);
          placeCursors();
        } else if (event.editor.clientID !== clientID) {
          const isNew = !editors.has(event.editor.clientID);
          editors.set(event.editor.clientID, event.editor);
          placeCursors(event.editor.clientID);
          // Someone new: they get this editor's cursor straight away.
          if (isNew) sendPresence();
        } else {
          break;
        }
        publishEditors();
        break;
      case 'guild_document_details':
        if (event.by !== clientID) onDetails?.({ title: event.title, cover: event.cover, open_editing: event.open_editing });
        break;
      case 'guild_document_saved':
        savedVersion = Math.max(savedVersion, event.version);
        refreshStatus();
        break;
      case 'guild_document_collab_end':
        // Replaced by a whole-document save: what's unconfirmed here can't go on top of it.
        confirmedDoc = null;
        join();
        break;
      default:
    }
  });

  // Back online: whatever was missed meanwhile.
  const offConnection = onConnectionState((state) => {
    if (state !== 'online' || stopped) return;
    if (!session) join();
    else catchUp()?.then(() => send());
  });

  function stop({ leave = true } = {}) {
    if (stopped) return;
    stopped = true;
    offEvents();
    offConnection();
    Object.values(timers).forEach(clearTimeout);
    if (leave && session) leaveDocumentCollab(documentId, ids()).catch(() => {});
  }

  join();

  return {
    clientID,
    // After every transaction in the view.
    changed(tr) {
      if (stopped || isRemote(tr)) return;
      if (tr.docChanged) send();
      if (tr.docChanged || tr.selectionSet) {
        clearTimeout(timers.presence);
        timers.presence = setTimeout(sendPresence, PRESENCE_DELAY_MS);
      }
      refreshStatus();
    },
    // { title?, cover?, open_editing? }
    details(changes) {
      if (!session) return Promise.reject(new Error('Not connected'));
      return setDocumentDetails(documentId, { ...ids(), ...changes });
    },
    // Waits (a little) for what's typed here to reach the server, then leaves.
    async finish() {
      const until = Date.now() + FINISH_WAIT_MS;
      while (!stopped && session && (sendableSteps(view.state) || inFlight) && Date.now() < until) {
        send();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      stop();
    },
    stop,
    hasUnsaved: () => Boolean(sendableSteps(view.state) || inFlight),
    // Draws the others' cursors again (their names changed: a profile loaded).
    refreshCursors: () => { if (session && !stopped) placeCursors(); },
  };
}
