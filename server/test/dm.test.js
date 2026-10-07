import './helpers/mockS3.js';
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');

// "v1." + base64(IV || ciphertext || tag)
function maxEncryptedLength(maxPlaintextLength) {
  return 'v1.'.length + Math.ceil((maxPlaintextLength + 12 + 16) / 3) * 4;
}

async function makeAuthedUser(username, password) {
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  return { id: regRes.body.id, token: loginRes.body.token };
}

function authed(token) {
  return { Authorization: `Bearer ${token}` };
}

describe('direct messages', () => {
  it('sends a message and returns the persisted row', async () => {
    const alice = await makeAuthedUser('dm-alice', 'pw-alice-123');
    const bob = await makeAuthedUser('dm-bob', 'pw-bob-123');

    const res = await request(app)
      .post('/api/dm-send')
      .set(authed(alice.token))
      .send({ recipient_id: bob.id, content: 'ciphertext-blob-1' });

    expect(res.status).toBe(201);
    expect(res.body.content).toBe('ciphertext-blob-1');
    expect(res.body.sender_id).toBe(alice.id);
    expect(res.body.recipient_id).toBe(bob.id);
    expect(res.body.sender_username).toBe('dm-alice');
  });

  it('rejects dm-send with missing recipient or content', async () => {
    const alice = await makeAuthedUser('dm-alice2', 'pw-alice-123');

    const missingContent = await request(app)
      .post('/api/dm-send')
      .set(authed(alice.token))
      .send({ recipient_id: 999 });
    expect(missingContent.status).toBe(400);

    const missingRecipient = await request(app)
      .post('/api/dm-send')
      .set(authed(alice.token))
      .send({ content: 'hi' });
    expect(missingRecipient.status).toBe(400);
  });

  it('rejects dm-send without auth', async () => {
    const res = await request(app).post('/api/dm-send').send({ recipient_id: 1, content: 'hi' });
    expect(res.status).toBe(401);
  });

  it('enforces the max encrypted message length', async () => {
    const alice = await makeAuthedUser('dm-alice3', 'pw-alice-123');
    const bob = await makeAuthedUser('dm-bob3', 'pw-bob-123');
    const limit = maxEncryptedLength(parseInt(process.env.MAX_MESSAGE_LENGTH, 10));

    const tooLong = await request(app)
      .post('/api/dm-send')
      .set(authed(alice.token))
      .send({ recipient_id: bob.id, content: 'a'.repeat(limit + 1) });
    expect(tooLong.status).toBe(400);

    const atLimit = await request(app)
      .post('/api/dm-send')
      .set(authed(alice.token))
      .send({ recipient_id: bob.id, content: 'a'.repeat(limit) });
    expect(atLimit.status).toBe(201);
  });

  it('accepts the longest message the client can actually produce', async () => {
    const { generateUserKeys, importEncryptionPrivateKey, deriveConversationKey, encryptMessage, dmContext } =
      await import('../../client/src/services/encryptionService.js');
    const alice = await makeAuthedUser('dm-alice-max', 'pw-alice-123');
    const bob = await makeAuthedUser('dm-bob-max', 'pw-bob-123');
    const a = await generateUserKeys();
    const b = await generateUserKeys();
    const key = await deriveConversationKey(await importEncryptionPrivateKey(a.private.encryptionKey), b.public.encryptionKey);

    const envelope = await encryptMessage('a'.repeat(parseInt(process.env.MAX_MESSAGE_LENGTH, 10)), key, dmContext(alice.id, bob.id));
    const res = await request(app).post('/api/dm-send').set(authed(alice.token)).send({ recipient_id: bob.id, content: envelope });

    expect(res.status).toBe(201);
  });

  it('fetches message history in chronological order with cursor pagination', async () => {
    const alice = await makeAuthedUser('dm-alice4', 'pw-alice-123');
    const bob = await makeAuthedUser('dm-bob4', 'pw-bob-123');

    const sent = [];
    for (const content of ['msg-1', 'msg-2', 'msg-3']) {
      const res = await request(app)
        .post('/api/dm-send')
        .set(authed(alice.token))
        .send({ recipient_id: bob.id, content });
      sent.push(res.body);
    }

    const all = await request(app)
      .get(`/api/dm-messages/${bob.id}`)
      .set(authed(alice.token));
    expect(all.status).toBe(200);
    expect(all.body.map(m => m.content)).toEqual(['msg-1', 'msg-2', 'msg-3']);

    const beforeThird = await request(app)
      .get(`/api/dm-messages/${bob.id}`)
      .query({ before: sent[2].id })
      .set(authed(alice.token));
    expect(beforeThird.body.map(m => m.content)).toEqual(['msg-1', 'msg-2']);
  });

  it('honours a requested page size, clamped to 1–100, defaulting to 10', async () => {
    const alice = await makeAuthedUser('dm-alice-limit', 'pw-alice-123');
    const bob = await makeAuthedUser('dm-bob-limit', 'pw-bob-123');
    for (let i = 1; i <= 12; i++) {
      await request(app)
        .post('/api/dm-send')
        .set(authed(alice.token))
        .send({ recipient_id: bob.id, content: `m${i}` });
    }
    const fetchPage = (query) =>
      request(app).get(`/api/dm-messages/${bob.id}`).query(query).set(authed(alice.token));

    expect((await fetchPage({})).body).toHaveLength(10);
    expect((await fetchPage({ limit: 3 })).body.map((m) => m.content)).toEqual(['m10', 'm11', 'm12']);
    expect((await fetchPage({ limit: 50 })).body).toHaveLength(12);
    expect((await fetchPage({ limit: 0 })).body).toHaveLength(1);
    expect((await fetchPage({ limit: 'abc' })).body).toHaveLength(10);
  });

  it('tracks and clears unread counts', async () => {
    const alice = await makeAuthedUser('dm-alice5', 'pw-alice-123');
    const bob = await makeAuthedUser('dm-bob5', 'pw-bob-123');

    const first = await request(app)
      .post('/api/dm-send')
      .set(authed(alice.token))
      .send({ recipient_id: bob.id, content: 'hey bob' });
    await request(app).post('/api/dm-send').set(authed(alice.token)).send({ recipient_id: bob.id, content: 'still there?' });

    const unread = await request(app).get('/api/dm-get-unread/').set(authed(bob.token));
    expect(unread.status).toBe(200);
    const entry = unread.body.find(r => r.from_user_id === alice.id);
    expect(entry.count).toBe(2);
    // When their newest message came (the rail's DM button shows whoever sent the newest).
    expect(entry.last_timestamp).toEqual(expect.any(Number));

    const markRead = await request(app)
      .post(`/api/dm-mark-read/${alice.id}`)
      .set(authed(bob.token));
    expect(markRead.status).toBe(200);
    // What was unread from (where the chat's "New" divider goes); nothing the second time.
    expect(markRead.body.first_unread_id).toBe(first.body.id);
    expect((await request(app).post(`/api/dm-mark-read/${alice.id}`).set(authed(bob.token))).body.first_unread_id).toBeNull();

    const unreadAfter = await request(app).get('/api/dm-get-unread/').set(authed(bob.token));
    expect(unreadAfter.body.find(r => r.from_user_id === alice.id)).toBeUndefined();
  });

  it('lists conversations with the most recent one first', async () => {
    const alice = await makeAuthedUser('dm-alice6', 'pw-alice-123');
    const bob = await makeAuthedUser('dm-bob6', 'pw-bob-123');
    const carol = await makeAuthedUser('dm-carol6', 'pw-carol-123');

    await request(app)
      .post('/api/dm-send')
      .set(authed(alice.token))
      .send({ recipient_id: bob.id, content: 'hi bob' });

    const list = await request(app).get('/api/dms-list').set(authed(alice.token));
    expect(list.status).toBe(200);

    const bobEntry = list.body.find(u => u.id === bob.id);
    const carolEntry = list.body.find(u => u.id === carol.id);
    expect(bobEntry.last_timestamp).not.toBeNull();
    expect(carolEntry.last_timestamp).toBeNull();
    expect(list.body.findIndex(u => u.id === bob.id))
      .toBeLessThan(list.body.findIndex(u => u.id === carol.id));
  });

  describe('editing and deleting', () => {
    async function sendMessage(sender, recipientId, content) {
      const res = await request(app)
        .post('/api/dm-send')
        .set(authed(sender.token))
        .send({ recipient_id: recipientId, content });
      return res.body;
    }

    it('lets only the sender edit their message', async () => {
      const alice = await makeAuthedUser('dm-alice7', 'pw-alice-123');
      const bob = await makeAuthedUser('dm-bob7', 'pw-bob-123');
      const message = await sendMessage(alice, bob.id, 'original');

      const forbidden = await request(app)
        .put(`/api/update-message/${message.id}`)
        .set(authed(bob.token))
        .send({ content: 'hijacked' });
      expect(forbidden.status).toBe(403);

      const ok = await request(app)
        .put(`/api/update-message/${message.id}`)
        .set(authed(alice.token))
        .send({ content: 'edited' });
      expect(ok.status).toBe(200);
      expect(ok.body.content).toBe('edited');
    });

    it('lets only the sender delete their message', async () => {
      const alice = await makeAuthedUser('dm-alice8', 'pw-alice-123');
      const bob = await makeAuthedUser('dm-bob8', 'pw-bob-123');
      const message = await sendMessage(alice, bob.id, 'to-delete');

      const forbidden = await request(app)
        .delete(`/api/messages/${message.id}`)
        .set(authed(bob.token));
      expect(forbidden.status).toBe(403);

      const ok = await request(app)
        .delete(`/api/messages/${message.id}`)
        .set(authed(alice.token));
      expect(ok.status).toBe(200);

      const history = await request(app)
        .get(`/api/dm-messages/${bob.id}`)
        .set(authed(alice.token));
      expect(history.body.find(m => m.id === message.id)).toBeUndefined();
    });

    it('returns 404 for editing/deleting a message that does not exist', async () => {
      const alice = await makeAuthedUser('dm-alice9', 'pw-alice-123');

      const editRes = await request(app)
        .put('/api/update-message/999999')
        .set(authed(alice.token))
        .send({ content: 'nope' });
      expect(editRes.status).toBe(404);

      const delRes = await request(app)
        .delete('/api/messages/999999')
        .set(authed(alice.token));
      expect(delRes.status).toBe(404);
    });
  });

  describe('validation', () => {
    it('rejects a recipient that does not exist or is not an id', async () => {
      const alice = await makeAuthedUser('dm-val-alice', 'pw-alice-123');
      const send = (recipient_id) => request(app).post('/api/dm-send').set(authed(alice.token)).send({ recipient_id, content: 'ENC' });

      expect((await send(999999)).status).toBe(404);
      expect((await send('abc')).status).toBe(400);
    });

    it('rejects non-string content', async () => {
      const alice = await makeAuthedUser('dm-val-alice2', 'pw-alice-123');
      const bob = await makeAuthedUser('dm-val-bob2', 'pw-bob-123');
      const res = await request(app).post('/api/dm-send').set(authed(alice.token)).send({ recipient_id: bob.id, content: { a: 1 } });
      expect(res.status).toBe(400);
    });

    it('only allows replying to a message in the same conversation', async () => {
      const alice = await makeAuthedUser('dm-val-alice3', 'pw-alice-123');
      const bob = await makeAuthedUser('dm-val-bob3', 'pw-bob-123');
      const carol = await makeAuthedUser('dm-val-carol3', 'pw-carol-123');
      const send = (from, to, extra = {}) =>
        request(app).post('/api/dm-send').set(authed(from.token)).send({ recipient_id: to.id, content: 'ENC', ...extra });

      const aliceToBob = (await send(alice, bob)).body;
      const bobToCarol = (await send(bob, carol)).body;

      // Bob replying to Alice's message in their chat: fine, and the parent comes back.
      const reply = await send(bob, alice, { replyTo: aliceToBob.id });
      expect(reply.status).toBe(201);
      expect(reply.body.parent_message_id).toBe(aliceToBob.id);

      // Alice can't reply (and so read the ciphertext of) a message from Bob and Carol's chat.
      expect((await send(alice, bob, { replyTo: bobToCarol.id })).status).toBe(400);
      expect((await send(alice, bob, { replyTo: 999999 })).status).toBe(400);
      expect((await send(alice, bob, { replyTo: 'x' })).status).toBe(400);
    });
  });
});

describe('DM link previews', () => {
  const put = (user, id, previews) => request(app).put(`/api/dm-messages/${id}/link-previews`).set(authed(user.token)).send({ previews });

  it('lets only the sender set them, and an edit clears them', async () => {
    const alice = await makeAuthedUser('lp-alice', 'pw-alice-123');
    const bob = await makeAuthedUser('lp-bob', 'pw-bob-123');
    const sent = await request(app).post('/api/dm-send').set(authed(alice.token)).send({ recipient_id: bob.id, content: 'v1.message' });
    const id = sent.body.id;
    expect(sent.body.link_previews).toBe(null);

    expect((await put(bob, id, 'v1.previews')).status).toBe(403);
    expect((await put(alice, id, 'plain')).status).toBe(400);
    expect((await put(alice, id, `v1.${'A'.repeat(maxEncryptedLength(16 * 1024))}`)).status).toBe(400);
    expect((await put(alice, 999999, 'v1.previews')).status).toBe(404);
    expect((await put(alice, id, 'v1.previews')).status).toBe(200);
    const listed = await request(app).get(`/api/dm-messages/${bob.id}`).set(authed(alice.token));
    expect(listed.body.find((m) => m.id === id).link_previews).toBe('v1.previews');

    await request(app).put(`/api/update-message/${id}`).set(authed(alice.token)).send({ content: 'v1.edited' });
    const after = await request(app).get(`/api/dm-messages/${alice.id}`).set(authed(bob.token));
    expect(after.body.find((m) => m.id === id).link_previews).toBe(null);

    expect((await put(alice, id, null)).status).toBe(200);
  });
});

