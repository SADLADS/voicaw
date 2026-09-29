import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');

// A reaction envelope: "v1." + base64(IV || 64 padded bytes || tag) is always 127 chars.
const REACTION = 'v1.' + 'A'.repeat(123) + '=';

async function makeAuthedUser(username, password = 'pw-react-123') {
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  return { id: regRes.body.id, token: loginRes.body.token };
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });

async function sendDm(from, to) {
  const res = await request(app).post('/api/dm-send').set(authed(from)).send({ recipient_id: to.id, content: 'ciphertext' });
  return res.body.id;
}

function react(user, messageId, content = REACTION) {
  return request(app).post('/api/dm-reactions').set(authed(user)).send({ messageId, content });
}

describe('DM reactions', () => {
  it('adds a reaction and returns it with the conversation', async () => {
    const alice = await makeAuthedUser('react-alice');
    const bob = await makeAuthedUser('react-bob');
    const messageId = await sendDm(alice, bob);

    const res = await react(bob, messageId);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ message_id: messageId, user_id: bob.id, content: REACTION });

    const page = await request(app).get(`/api/dm-messages/${bob.id}`).set(authed(alice));
    const message = page.body.find((m) => m.id === messageId);
    expect(message.reactions).toEqual([
      { id: res.body.id, user_id: bob.id, content: REACTION, timestamp: expect.any(Number) },
    ]);
  });

  it('only lets the two participants react', async () => {
    const alice = await makeAuthedUser('react-alice2');
    const bob = await makeAuthedUser('react-bob2');
    const eve = await makeAuthedUser('react-eve2');
    const messageId = await sendDm(alice, bob);

    expect((await react(eve, messageId)).status).toBe(404);
    expect((await react(eve, 999999)).status).toBe(404);
    expect((await request(app).post('/api/dm-reactions').send({ messageId, content: REACTION })).status).toBe(401);
  });

  it('only accepts fixed-size encrypted reactions', async () => {
    const alice = await makeAuthedUser('react-alice3');
    const bob = await makeAuthedUser('react-bob3');
    const messageId = await sendDm(alice, bob);

    expect((await react(alice, messageId, '👍')).status).toBe(400);
    expect((await react(alice, messageId, REACTION + 'AAAA')).status).toBe(400);
    expect((await react(alice, messageId, 'v2.' + REACTION.slice(3))).status).toBe(400);
    expect((await react(alice, messageId, null)).status).toBe(400);
  });

  it('limits reactions per person per message', async () => {
    const alice = await makeAuthedUser('react-alice4');
    const bob = await makeAuthedUser('react-bob4');
    const messageId = await sendDm(alice, bob);

    for (let i = 0; i < 20; i++) expect((await react(alice, messageId)).status).toBe(201);
    expect((await react(alice, messageId)).status).toBe(400);
    expect((await react(bob, messageId)).status).toBe(201);
  });

  it('removes only your own reactions', async () => {
    const alice = await makeAuthedUser('react-alice5');
    const bob = await makeAuthedUser('react-bob5');
    const messageId = await sendDm(alice, bob);
    const { body: reaction } = await react(bob, messageId);

    expect((await request(app).delete(`/api/dm-reactions/${reaction.id}`).set(authed(alice))).status).toBe(403);
    expect((await request(app).delete(`/api/dm-reactions/${reaction.id}`).set(authed(bob))).status).toBe(200);
    expect((await request(app).delete(`/api/dm-reactions/${reaction.id}`).set(authed(bob))).status).toBe(404);

    const page = await request(app).get(`/api/dm-messages/${alice.id}`).set(authed(bob));
    expect(page.body.find((m) => m.id === messageId).reactions).toEqual([]);
  });

  it('deletes reactions with their message', async () => {
    const alice = await makeAuthedUser('react-alice6');
    const bob = await makeAuthedUser('react-bob6');
    const messageId = await sendDm(alice, bob);
    const { body: reaction } = await react(bob, messageId);

    expect((await request(app).delete(`/api/messages/${messageId}`).set(authed(alice))).status).toBe(200);
    expect((await request(app).delete(`/api/dm-reactions/${reaction.id}`).set(authed(bob))).status).toBe(404);
  });
});
