import './helpers/mockS3.js';
import { sentPushes, waitForPushes } from './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser(prefix = 'profile-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-profile-123';
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  return { id: regRes.body.id, username, token: loginRes.body.token };
}
const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url) => request(app).get(`/api${url}`).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  put: (user, url, body = {}) => request(app).put(`/api${url}`).set(authed(user)).send(body),
};
function listen(user) {
  const events = [];
  const ws = { readyState: 1, send: (m) => events.push(JSON.parse(m)), identified: true, presence: { at: Date.now() } };
  clients.set(String(user.id), [...(clients.get(String(user.id)) || []), ws]);
  return events;
}

describe('profiles', () => {
  it('starts empty, and saves a display name, custom status and bio (trimmed)', async () => {
    const alice = await makeUser();
    expect((await api.get(alice, '/profile')).body).toMatchObject({ display_name: null, custom_status: null, bio: null });

    const res = await api.put(alice, '/profile', { displayName: '  Alice  Liddell ', customStatus: 'In wonderland 🐇', bio: 'Curious.\n\n\n\nVery.' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: alice.id, username: alice.username, display_name: 'Alice Liddell', custom_status: 'In wonderland 🐇', bio: 'Curious.\n\nVery.' });
    expect((await api.get(alice, '/profile')).body).toMatchObject({ display_name: 'Alice Liddell', bio: 'Curious.\n\nVery.' });

    // Only what's given changes; "" or null clears.
    await api.put(alice, '/profile', { customStatus: '' });
    expect((await api.get(alice, '/profile')).body).toMatchObject({ display_name: 'Alice Liddell', custom_status: null });
  });

  it('saves an emoji for the custom status, with or without text', async () => {
    const amy = await makeUser();
    expect((await api.get(amy, '/profile')).body).toMatchObject({ custom_status: null, custom_status_emoji: null });

    const res = await api.put(amy, '/profile', { customStatusEmoji: '🐇', customStatus: 'Late' });
    expect(res.body).toMatchObject({ custom_status: 'Late', custom_status_emoji: '🐇' });
    // Only the text clears; the emoji stays on its own.
    await api.put(amy, '/profile', { customStatus: null });
    expect((await api.get(amy, '/profile')).body).toMatchObject({ custom_status: null, custom_status_emoji: '🐇' });
    // A guild's custom emoji.
    await api.put(amy, '/profile', { customStatusEmoji: '<:party_parrot:12>' });
    expect((await api.get(amy, '/profile')).body.custom_status_emoji).toBe('<:party_parrot:12>');
    await api.put(amy, '/profile', { customStatusEmoji: '' });
    expect((await api.get(amy, '/profile')).body.custom_status_emoji).toBe(null);

    for (const bad of [42, 'two words', 'x'.repeat(65)]) {
      const refused = await api.put(amy, '/profile', { customStatusEmoji: bad });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('Invalid emoji');
    }
  });

  it('refuses what is too long or not text', async () => {
    const bob = await makeUser();
    expect((await api.put(bob, '/profile', { displayName: 'x'.repeat(33) })).status).toBe(400);
    expect((await api.put(bob, '/profile', { bio: 'x'.repeat(191) })).status).toBe(400);
    expect((await api.put(bob, '/profile', { customStatus: 42 })).status).toBe(400);
    expect((await api.get(bob, '/profile')).body.display_name).toBe(null);
  });

  it('tells everyone, and shows in the users list and guild members', async () => {
    const carol = await makeUser();
    const dave = await makeUser();
    const events = listen(dave);
    await api.put(carol, '/profile', { displayName: 'Caz', customStatus: 'busy', customStatusEmoji: '⏳' });
    expect(events.find((e) => e.type === 'user_profile')).toMatchObject({ user: { id: carol.id, display_name: 'Caz', custom_status: 'busy', custom_status_emoji: '⏳' } });

    const listed = (await api.get(dave, '/dms-list')).body.find((u) => u.id === carol.id);
    expect(listed).toMatchObject({ username: carol.username, display_name: 'Caz', custom_status: 'busy', custom_status_emoji: '⏳', bio: null });

    const guild = (await api.post(carol, '/guilds', { name: 'Profiles' })).body;
    const members = (await api.get(carol, `/guilds/${guild.id}/members`)).body;
    expect(members.find((m) => m.id === carol.id)).toMatchObject({ display_name: 'Caz', custom_status: 'busy', custom_status_emoji: '⏳' });
  });

  it('uses the display name in DM notifications', async () => {
    const erin = await makeUser();
    const frank = await makeUser();
    await api.put(erin, '/profile', { displayName: 'Erin E.' });
    await api.post(frank, '/save-subscription', { subscription: { endpoint: `https://push.test/${frank.username}`, keys: { p256dh: 'p', auth: 'a' } } });
    const since = sentPushes.length;
    await api.post(erin, '/dm-send', { recipient_id: frank.id, content: 'CIPHERTEXT' });
    const [push] = await waitForPushes(1, since);
    expect(push.payload.title).toBe('Erin E.');
  });
});
