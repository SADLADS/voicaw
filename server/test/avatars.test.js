import './helpers/mockS3.js';
import { signedUploads, deletedObjects, objects, putMockObject } from './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const { migrateLegacyAvatars } = require('../avatars.js');
const { getUserImageUrl } = require('../push.js');
const clients = app.locals.clients;

let userCount = 0;
async function makeUser(prefix = 'avatar-user') {
  const username = `${prefix}-${++userCount}`;
  const { response: regRes } = await registerUser(app, request, username, 'pw-avatar-123');
  const { response: loginRes } = await loginUser(app, request, username, 'pw-avatar-123');
  return { id: regRes.body.id, username, token: loginRes.body.token };
}
const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const post = (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body);

const png = (width, height) => sharp({ create: { width, height, channels: 3, background: '#e33' } }).png().toBuffer();

// Starts an upload, puts `image` where it was signed for, and says it's ready.
async function upload(user, image, type = 'image/png') {
  const start = await post(user, '/profile/avatar', { type, size: image.length });
  expect(start.status).toBe(201);
  const signed = signedUploads.at(-1);
  putMockObject('profile-pics', signed.filename, image, type);
  return post(user, `/profile/avatar/${start.body.uploadId}/ready`);
}

describe('profile pictures', () => {
  it('signs the original upload for the exact type and size, only for images up to 8 MB', async () => {
    const alice = await makeUser();
    const res = await post(alice, '/profile/avatar', { type: 'image/png', size: 2048 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ uploadId: expect.any(String), url: expect.stringContaining('mock-s3.test') });
    expect(signedUploads.at(-1)).toMatchObject({
      bucket: 'profile-pics', filename: `src/${alice.id}/${res.body.uploadId}`, contentType: 'image/png', contentLength: 2048,
    });
    expect((await post(alice, '/profile/avatar', { type: 'text/html', size: 10 })).status).toBe(400);
    expect((await post(alice, '/profile/avatar', { type: 'image/png' })).status).toBe(400);
    expect((await post(alice, '/profile/avatar', { type: 'image/png', size: 8 * 1024 * 1024 + 1 })).status).toBe(413);
    expect((await request(app).post('/api/profile/avatar').send({ type: 'image/png', size: 10 })).status).toBe(401);
  });

  it('crops and shrinks it to a 256px square WebP under a new name, and tells everyone', async () => {
    const bob = await makeUser();
    const events = [];
    clients.set('999999', [{ readyState: 1, identified: true, send: (m) => events.push(JSON.parse(m)) }]);
    const res = await upload(bob, await png(600, 400));
    expect(res.status).toBe(200);
    const { avatar } = res.body;
    expect(avatar).toMatch(/^[0-9a-f-]{36}$/);
    const stored = objects.get(`profile-pics/${bob.id}/${avatar}.webp`);
    expect(stored.contentType).toBe('image/webp');
    expect(await sharp(stored.body).metadata()).toMatchObject({ format: 'webp', width: 256, height: 256 });
    // The original is gone.
    expect([...objects.keys()].some((k) => k.startsWith(`profile-pics/src/${bob.id}/`))).toBe(false);
    expect(events.find((e) => e.type === 'user_profile')).toMatchObject({ user: { id: bob.id, avatar } });
    expect((await request(app).get('/api/profile').set(authed(bob))).body.avatar).toBe(avatar);
    expect(await getUserImageUrl(bob.id)).toMatch(new RegExp(`/profile-pics/${bob.id}/${avatar}\\.webp$`));
    clients.delete('999999');
  });

  it('keeps small pictures small, and replacing or removing one deletes the old file', async () => {
    const carol = await makeUser();
    const first = (await upload(carol, await png(40, 90))).body.avatar;
    expect(await sharp(objects.get(`profile-pics/${carol.id}/${first}.webp`).body).metadata()).toMatchObject({ width: 40, height: 40 });

    const second = (await upload(carol, await png(300, 300))).body.avatar;
    expect(second).not.toBe(first);
    expect(deletedObjects).toContainEqual({ bucket: 'profile-pics', key: `${carol.id}/${first}.webp` });

    const removed = await request(app).delete('/api/profile/avatar').set(authed(carol));
    expect(removed.body.avatar).toBe(null);
    expect(deletedObjects).toContainEqual({ bucket: 'profile-pics', key: `${carol.id}/${second}.webp` });
    expect(await getUserImageUrl(carol.id)).toBe('/default.png');
  });

  it("refuses what isn't an image (dropping the upload), and other people's uploads", async () => {
    const dave = await makeUser();
    const erin = await makeUser();
    const bad = await upload(dave, Buffer.from('not really a png'));
    expect(bad.status).toBe(400);
    expect([...objects.keys()].some((k) => k.startsWith(`profile-pics/src/${dave.id}/`))).toBe(false);
    expect((await request(app).get('/api/profile').set(authed(dave))).body.avatar).toBe(null);

    const start = await post(dave, '/profile/avatar', { type: 'image/png', size: 10 });
    expect((await post(erin, `/profile/avatar/${start.body.uploadId}/ready`)).status).toBe(404);
    // Not uploaded yet.
    expect((await post(dave, `/profile/avatar/${start.body.uploadId}/ready`)).status).toBe(400);
  });

  it('converts pictures from before (profile-pics/<id>) once, on start', async () => {
    const frank = await makeUser();
    putMockObject('profile-pics', String(frank.id), await png(500, 500), 'image/png');
    putMockObject('profile-pics', '987654', Buffer.from('an orphan'), 'image/png');
    await migrateLegacyAvatars();
    const { avatar } = (await request(app).get('/api/profile').set(authed(frank))).body;
    expect(objects.has(`profile-pics/${frank.id}/${avatar}.webp`)).toBe(true);
    expect(objects.has(`profile-pics/${frank.id}`)).toBe(false);
    expect(objects.has('profile-pics/987654')).toBe(false);
  });
});
