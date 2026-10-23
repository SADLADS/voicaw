import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { Step } from 'prosemirror-transform';

// A pretend server (server/documentCollab.js in miniature): it applies steps in order and
// broadcasts them, but only when the test says (`deliver`), so editors can be made to race.
const server = vi.hoisted(() => ({ listeners: [], queue: [], reset: null }));

vi.mock('../utils/ws-client', () => ({
  onGuildEvent: (cb) => {
    server.listeners.push(cb);
    return () => { server.listeners = server.listeners.filter((x) => x !== cb); };
  },
  onConnectionState: () => () => {},
}));

vi.mock('../services/guildService', () => {
  const fail = (status, data = {}) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
  const broadcast = (event) => server.queue.push({ documentId: 7, session: server.session, ...event });
  return {
    joinDocumentCollab: vi.fn(async (_id, { clientID, doc, basedOn }) => {
      if (!server.doc) {
        if (!doc || basedOn !== 1) throw fail(409, { needsDoc: true, document: { id: 7, content: server.markdown, version: 1 } });
        server.doc = server.schema.nodeFromJSON(doc);
      }
      server.users[clientID] ??= server.nextUser;
      server.editors.set(clientID, { clientID, userId: server.users[clientID], anchor: null, head: null, version: server.version });
      broadcast({ type: 'guild_document_presence', editor: server.editors.get(clientID) });
      return {
        session: server.session, version: server.version, doc: server.doc.toJSON(), title: 'Plan', cover: null, open_editing: 0,
        editors: [...server.editors.values()],
      };
    }),
    sendDocumentSteps: vi.fn(async (_id, { session, clientID, version, steps }) => {
      if (session !== server.session) throw fail(410);
      if (version !== server.version) throw fail(409, { version: server.version });
      for (const json of steps) server.doc = Step.fromJSON(server.schema, json).apply(server.doc).doc;
      server.version += steps.length;
      server.log.push(...steps.map((step) => ({ step, clientID })));
      broadcast({ type: 'guild_document_steps', version: server.version, steps, clientIDs: steps.map(() => clientID) });
      return { version: server.version };
    }),
    fetchDocumentSteps: vi.fn(async (_id, { session, since }) => {
      if (session !== server.session) throw fail(410);
      const kept = server.log.slice(since);
      return { version: server.version, steps: kept.map((s) => s.step), clientIDs: kept.map((s) => s.clientID) };
    }),
    sendDocumentPresence: vi.fn(async (_id, { session, clientID, version, anchor, head }) => {
      if (session !== server.session) throw fail(410);
      const editor = { ...server.editors.get(clientID), anchor, head, version };
      server.editors.set(clientID, editor);
      broadcast({ type: 'guild_document_presence', editor });
      return { version: server.version };
    }),
    setDocumentDetails: vi.fn(async () => ({})),
    leaveDocumentCollab: vi.fn(async () => {}),
  };
});

import { schema } from './documentSchema';
import { markdownToDoc } from './documentMarkdown';
import { startDocumentCollab } from './documentCollab';
import { getCursors } from './collabCursors';
import { joinDocumentCollab, sendDocumentSteps } from '../services/guildService';

const document = { id: 7, content: '# Plan\n\nFirst line.', version: 1 };

function resetServer() {
  Object.assign(server, {
    schema, markdown: document.content, doc: null, version: 0, log: [], session: 's1', editors: new Map(),
    users: {}, nextUser: 1, queue: [],
  });
}

// Everything broadcast so far, to every editor (in order).
async function deliver() {
  for (let i = 0; i < 20 && server.queue.length; i++) {
    const events = server.queue.splice(0);
    for (const event of events) server.listeners.forEach((cb) => cb(event));
    await settle();
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// An editor: a stand-in for the EditorView (the controller only uses state, dispatch and
// updateState), started live.
function editor(userId) {
  const view = {
    state: EditorState.create({ doc: markdownToDoc(document.content) }),
    dispatch(tr) {
      view.state = view.state.apply(tr);
      view.collab?.changed(tr);
    },
    updateState(state) { view.state = state; },
  };
  const statuses = [];
  const onEditors = vi.fn();
  server.nextUser = userId;
  view.collab = startDocumentCollab({
    view,
    document,
    makeState: (doc, plugins) => EditorState.create({ doc, plugins }),
    onStatus: (s) => statuses.push(s),
    onEditors,
    onDetails: vi.fn(),
    onNotice: vi.fn(),
    onEnded: vi.fn(),
  });
  return { view, statuses, onEditors, type: (pos, text) => view.dispatch(view.state.tr.insertText(text, pos)) };
}

const text = (e) => e.view.state.doc.textContent;
const editors = [];
const make = async (userId) => {
  const e = editor(userId);
  editors.push(e);
  await vi.waitFor(() => expect(e.statuses).toContain('saved'));
  return e;
};

beforeEach(() => {
  server.listeners = [];
  resetServer();
  vi.clearAllMocks();
});
afterEach(() => {
  editors.splice(0).forEach((e) => e.view.collab.stop());
});

describe('live document editing', () => {
  it('starts the session from the document when there is none', async () => {
    const a = await make(1);
    expect(joinDocumentCollab).toHaveBeenCalledTimes(2);
    expect(joinDocumentCollab).toHaveBeenLastCalledWith(7, expect.objectContaining({ basedOn: 1, doc: markdownToDoc(document.content).toJSON() }));
    expect(text(a)).toBe('PlanFirst line.');
  });

  it('brings two editors typing at once to the same document', async () => {
    const a = await make(1);
    const b = await make(2);
    // Both type before either hears of the other's change: B's send is refused as stale, B
    // catches up, rebases and sends again.
    a.type(7, 'Hello. ');
    b.type(5, '!');
    await settle();
    await deliver();
    await vi.waitFor(async () => {
      await deliver();
      expect(server.version).toBe(2);
    });
    await deliver();
    expect(text(a)).toBe('Plan!Hello. First line.');
    expect(text(b)).toBe(text(a));
    expect(server.doc.textContent).toBe(text(a));
    expect(sendDocumentSteps.mock.calls.some(([, body]) => body.version === 0 && body.clientID === b.view.collab.clientID)).toBe(true);
  });

  it('shows the others\' cursors, kept in place as the document changes', async () => {
    const a = await make(1);
    const b = await make(2);
    await deliver();
    expect(a.onEditors).toHaveBeenLastCalledWith([{ clientID: b.view.collab.clientID, userId: 2 }]);
    // B puts the cursor after "First" (7 + 5).
    b.view.dispatch(b.view.state.tr.setSelection(b.view.state.selection.constructor.create(b.view.state.doc, 12)));
    await vi.waitFor(async () => {
      await deliver();
      expect(getCursors(a.view.state).get(b.view.collab.clientID)).toMatchObject({ userId: 2, anchor: 12, head: 12 });
    });
    // A types before it: B's cursor moves along.
    a.type(7, 'Hi ');
    expect(getCursors(a.view.state).get(b.view.collab.clientID)).toMatchObject({ anchor: 15, head: 15 });
  });

  it('joins again after the session is lost, keeping unsent changes made on the same document', async () => {
    const a = await make(1);
    a.type(7, 'Kept. ');
    await vi.waitFor(() => expect(server.version).toBe(1));
    await deliver();
    // The API restarted: a new session from the last save (which had A's change).
    const saved = server.doc;
    resetServer();
    server.doc = saved;
    server.session = 's2';
    a.type(1, 'The ');
    await vi.waitFor(async () => {
      await deliver();
      expect(server.doc.textContent).toBe('The PlanKept. First line.');
    });
    expect(text(a)).toBe('The PlanKept. First line.');
  });
});
