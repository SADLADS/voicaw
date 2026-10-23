import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { Transform } from 'prosemirror-transform';
import { registerUser, loginUser } from './helpers/authFlow.js';
import { schema } from '../../client/src/documents/documentSchema.js';
import { markdownToDoc } from '../../client/src/documents/documentMarkdown.js';

const app = require('../index.js');
const collab = require('../documentCollab.js');
const { PERMISSIONS: P } = require('../permissions.js');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser(prefix = 'collab-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-collab-123';
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  return { id: regRes.body.id, username, token: loginRes.body.token };
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
  patch: (user, url, body = {}) => request(app).patch(`/api${url}`).set(authed(user)).send(body),
  delete: (user, url) => request(app).delete(`/api${url}`).set(authed(user)),
};

function listen(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)) };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return events;
}

// A guild with an owner, members and a document channel holding one of the owner's documents.
async function setUp(count = 2, content = '# Plan\n\nFirst line.') {
  const owner = await makeUser('c-owner');
  const guild = (await api.post(owner, '/guilds', { name: 'Collab Guild' })).body;
  const members = [];
  for (let i = 0; i < count; i++) {
    const user = await makeUser('c-member');
    const invite = await api.post(owner, `/guilds/${guild.id}/invites`);
    await api.post(user, `/invites/${invite.body.code}`);
    members.push(user);
  }
  const channel = (await api.post(owner, `/guilds/${guild.id}/channels`, { name: 'Notes', type: 'doc' })).body;
  const document = (await api.post(owner, `/channels/${channel.id}/documents`, { title: 'Plan', content })).body;
  return { owner, members, guild, channel, document };
}

// Joins as `clientID`, starting the session from the document's markdown if there's none.
async function join(user, document, clientID) {
  const res = await api.post(user, `/documents/${document.id}/collab`, { clientID });
  if (res.status !== 409) return res;
  const { document: now } = res.body;
  return api.post(user, `/documents/${document.id}/collab`, {
    clientID, doc: markdownToDoc(now.content).toJSON(), basedOn: now.version,
  });
}

// Steps typing `text` at `pos` of `state` (a join's response): { steps, doc }.
function typing(docJson, pos, text) {
  const tr = new Transform(schema.nodeFromJSON(docJson)).insert(pos, schema.text(text));
  return { steps: tr.steps.map((s) => s.toJSON()), doc: tr.doc.toJSON() };
}

const sendSteps = (user, document, body) => api.post(user, `/documents/${document.id}/collab/steps`, body);

describe('live document editing', () => {
  it('starts a session from the first editor\'s parse of the document, then others join it', async () => {
    const { owner, document } = await setUp(0);
    const asks = await api.post(owner, `/documents/${document.id}/collab`, { clientID: 'tab-a' });
    expect(asks.status).toBe(409);
    expect(asks.body).toMatchObject({ needsDoc: true, document: { id: document.id, content: '# Plan\n\nFirst line.' } });

    // A parse of an older version is refused too.
    const stale = await api.post(owner, `/documents/${document.id}/collab`, {
      clientID: 'tab-a', doc: markdownToDoc('old').toJSON(), basedOn: document.version - 1,
    });
    expect(stale.status).toBe(409);
    const bad = await api.post(owner, `/documents/${document.id}/collab`, {
      clientID: 'tab-a', doc: { type: 'doc', content: [{ type: 'no_such_node' }] }, basedOn: document.version,
    });
    expect(bad.status).toBe(400);
    expect((await api.post(owner, `/documents/${document.id}/collab`, { clientID: 'no spaces!' })).status).toBe(400);

    const first = await join(owner, document, 'tab-a');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ version: 0, title: 'Plan', open_editing: 0, editors: [{ clientID: 'tab-a', userId: owner.id }] });
    expect(first.body.doc.content[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });

    const events = listen(owner);
    const second = await api.post(owner, `/documents/${document.id}/collab`, { clientID: 'tab-b' });
    expect(second.body.session).toBe(first.body.session);
    expect(second.body.editors.map((e) => e.clientID)).toEqual(['tab-a', 'tab-b']);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'guild_document_presence', documentId: document.id, editor: expect.objectContaining({ clientID: 'tab-b' }),
    }));
  });

  it('applies steps in order, passes them to the other editors and refuses stale or broken ones', async () => {
    const { owner, members: [alice], document } = await setUp(1);
    await api.patch(owner, `/documents/${document.id}`, { version: document.version, open_editing: true });
    const a = (await join(owner, document, 'owner-1')).body;
    const b = (await join(alice, document, 'alice-1')).body;
    const aliceEvents = listen(alice);

    // "# Plan" is positions 0..6 (its text 1..5); the paragraph's text starts at 7.
    const mine = typing(a.doc, 7, 'Hello. ');
    const sent = await sendSteps(owner, document, { session: a.session, clientID: 'owner-1', version: 0, steps: mine.steps });
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ version: 1 });
    expect(aliceEvents).toContainEqual({
      type: 'guild_document_steps', documentId: document.id, session: a.session, version: 1, steps: mine.steps, clientIDs: ['owner-1'],
    });

    // Alice's change was made on version 0: refused, she catches up and sends it again.
    const hers = typing(b.doc, 1, 'The ');
    const stale = await sendSteps(alice, document, { session: b.session, clientID: 'alice-1', version: 0, steps: hers.steps });
    expect(stale.status).toBe(409);
    expect(stale.body.version).toBe(1);
    const missed = await api.get(alice, `/documents/${document.id}/collab/steps?session=${b.session}&clientID=alice-1&since=0`);
    expect(missed.body).toEqual({ version: 1, steps: mine.steps, clientIDs: ['owner-1'] });
    const rebased = typing(mine.doc, 1, 'The ');
    expect((await sendSteps(alice, document, { session: b.session, clientID: 'alice-1', version: 1, steps: rebased.steps })).body).toEqual({ version: 2 });

    // A step that doesn't fit the document, someone else's client id, an old session.
    const broken = [{ stepType: 'replace', from: 500, to: 501 }];
    expect((await sendSteps(alice, document, { session: b.session, clientID: 'alice-1', version: 2, steps: broken })).status).toBe(400);
    expect((await sendSteps(alice, document, { session: b.session, clientID: 'owner-1', version: 2, steps: rebased.steps })).status).toBe(410);
    expect((await sendSteps(alice, document, { session: 'old', clientID: 'alice-1', version: 2, steps: rebased.steps })).status).toBe(410);

    // Saved as markdown by the server, and everyone who can see the channel is told.
    const ownerEvents = listen(owner);
    await collab.saveAll();
    const saved = (await api.get(owner, `/documents/${document.id}`)).body;
    expect(saved).toMatchObject({ content: '# The Plan\n\nHello. First line.', version: document.version + 2, updated_by: alice.id });
    expect(ownerEvents).toContainEqual(expect.objectContaining({ type: 'guild_document_update', document: expect.objectContaining({ content: saved.content }) }));
    expect(ownerEvents).toContainEqual(expect.objectContaining({ type: 'guild_document_upsert' }));
    expect(ownerEvents).toContainEqual(expect.objectContaining({ type: 'guild_document_saved', savedVersion: saved.version, version: 2 }));
  });

  it('keeps editing to those allowed: others once the author opens the document to editing', async () => {
    const { owner, members: [alice, bob], channel, guild, document } = await setUp(2);
    expect((await join(alice, document, 'alice-1')).status).toBe(403);

    const a = (await join(owner, document, 'owner-1')).body;
    const opened = await api.post(owner, `/documents/${document.id}/collab/details`, { session: a.session, clientID: 'owner-1', open_editing: true, title: '  New   plan ' });
    expect(opened.body).toEqual({ title: 'New plan', cover: null, open_editing: 1 });
    await collab.saveAll();
    expect((await api.get(owner, `/documents/${document.id}`)).body).toMatchObject({ open_editing: 1, title: 'New plan' });

    const b = (await join(alice, document, 'alice-1')).body;
    expect(b.session).toBe(a.session);
    // Only the author (or Manage Messages) opens or closes it, or deletes it.
    expect((await api.post(alice, `/documents/${document.id}/collab/details`, { session: b.session, clientID: 'alice-1', open_editing: false })).status).toBe(403);
    expect((await api.delete(alice, `/documents/${document.id}`)).status).toBe(403);
    expect((await api.post(alice, `/documents/${document.id}/collab/details`, { session: b.session, clientID: 'alice-1', title: '' })).status).toBe(400);

    // Losing Create Documents takes Bob out of the session at his next request.
    const c = (await join(bob, document, 'bob-1')).body;
    const res = await api.put(owner, `/guilds/${guild.id}/channels/${channel.id}/overrides/member/${bob.id}`, { allow: 0, deny: P.CREATE_DOCUMENTS });
    expect(res.status).toBe(200);
    const step = typing(c.doc, 1, 'x');
    expect((await sendSteps(bob, document, { session: c.session, clientID: 'bob-1', version: c.version, steps: step.steps })).status).toBe(403);
    expect([...collab.sessions.get(document.id).editors.keys()]).toEqual(['owner-1', 'alice-1']);

    // Closed to editing again (not saved yet): Alice is taken out at once, and refused.
    const aliceEvents = listen(alice);
    await api.post(owner, `/documents/${document.id}/collab/details`, { session: a.session, clientID: 'owner-1', open_editing: false });
    expect(aliceEvents).toContainEqual({ type: 'guild_document_collab_end', documentId: document.id, session: a.session });
    expect([...collab.sessions.get(document.id).editors.keys()]).toEqual(['owner-1']);
    expect((await join(alice, document, 'alice-1')).status).toBe(403);
  });

  it('shares where everyone\'s selection is, and ends the session (saved) when the last editor leaves', async () => {
    const { owner, document } = await setUp(0);
    const a = (await join(owner, document, 'tab-a')).body;
    await join(owner, document, 'tab-b');
    const events = listen(owner);
    const at = await api.post(owner, `/documents/${document.id}/collab/presence`, { session: a.session, clientID: 'tab-a', version: 0, anchor: 3, head: 5 });
    expect(at.body).toEqual({ version: 0 });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'guild_document_presence', editor: { clientID: 'tab-a', userId: owner.id, anchor: 3, head: 5, version: 0 },
    }));

    const step = typing(a.doc, 7, 'More. ');
    await sendSteps(owner, document, { session: a.session, clientID: 'tab-a', version: 0, steps: step.steps });
    await api.post(owner, `/documents/${document.id}/collab/leave`, { session: a.session, clientID: 'tab-a' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'guild_document_presence', left: 'tab-a' }));
    expect(collab.sessions.has(document.id)).toBe(true);
    await api.post(owner, `/documents/${document.id}/collab/leave`, { session: a.session, clientID: 'tab-b' });
    expect(collab.sessions.has(document.id)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await api.get(owner, `/documents/${document.id}`)).body.content).toBe('# Plan\n\nMore. First line.');
  });

  it('drops editors who stop sending heartbeats', async () => {
    const { owner, document } = await setUp(0);
    await join(owner, document, 'tab-a');
    collab.sessions.get(document.id).editors.get('tab-a').at -= collab.EDITOR_TIMEOUT_MS + 1;
    collab.sweep();
    expect(collab.sessions.has(document.id)).toBe(false);
  });

  it('a whole-document save counts the session\'s unsaved changes, and ends the session when it goes through', async () => {
    const { owner, document } = await setUp(0);
    const a = (await join(owner, document, 'tab-a')).body;
    const step = typing(a.doc, 7, 'Live. ');
    await sendSteps(owner, document, { session: a.session, clientID: 'tab-a', version: 0, steps: step.steps });

    const stale = await api.patch(owner, `/documents/${document.id}`, { version: document.version, content: 'Overwritten' });
    expect(stale.status).toBe(409);
    expect(stale.body.document.content).toBe('# Plan\n\nLive. First line.');

    const events = listen(owner);
    const saved = await api.patch(owner, `/documents/${document.id}`, { version: stale.body.document.version, content: 'Replaced' });
    expect(saved.status).toBe(200);
    expect(events).toContainEqual({ type: 'guild_document_collab_end', documentId: document.id, session: a.session });
    expect(collab.sessions.has(document.id)).toBe(false);
  });

  it('deleting the document ends its session', async () => {
    const { owner, document } = await setUp(0);
    const a = (await join(owner, document, 'tab-a')).body;
    expect((await api.delete(owner, `/documents/${document.id}`)).status).toBe(200);
    expect(collab.sessions.has(document.id)).toBe(false);
    const step = typing(a.doc, 7, 'x');
    expect((await sendSteps(owner, document, { session: a.session, clientID: 'tab-a', version: 0, steps: step.steps })).status).toBe(404);
  });

  it('refuses changes that make the document too long', async () => {
    const { owner, document } = await setUp(0, 'x');
    const a = (await join(owner, document, 'tab-a')).body;
    const step = typing(a.doc, 1, 'y'.repeat(100001));
    const res = await sendSteps(owner, document, { session: a.session, clientID: 'tab-a', version: 0, steps: step.steps });
    expect(res.status).toBe(400);
    expect(collab.sessions.get(document.id).version).toBe(0);
  });
});
