import './helpers/mockS3.js';
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');

function maxEncryptedLength(maxPlaintextLength) {
  const ivLength = 12;
  const tagLength = 16;
  return Math.ceil((maxPlaintextLength + ivLength + tagLength) * 4 / 3);
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

  it('tracks and clears unread counts', async () => {
    const alice = await makeAuthedUser('dm-alice5', 'pw-alice-123');
    const bob = await makeAuthedUser('dm-bob5', 'pw-bob-123');

    await request(app)
      .post('/api/dm-send')
      .set(authed(alice.token))
      .send({ recipient_id: bob.id, content: 'hey bob' });

    const unread = await request(app).get('/api/dm-get-unread/').set(authed(bob.token));
    expect(unread.status).toBe(200);
    const entry = unread.body.find(r => r.from_user_id === alice.id);
    expect(entry.count).toBe(1);

    const markRead = await request(app)
      .post(`/api/dm-mark-read/${alice.id}`)
      .set(authed(bob.token));
    expect(markRead.status).toBe(200);

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
});
