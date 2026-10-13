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
// 200×100: the left half red, the right half blue.
async function halves(format = 'png', metadata) {
  const red = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#f00' } }).png().toBuffer();
  let image = sharp({ create: { width: 200, height: 100, channels: 3, background: '#00f' } }).composite([{ input: red, left: 0, top: 0 }]);
  if (metadata) image = image.withMetadata(metadata);
  return image[format]().toBuffer();
}
// The middle pixel's [r, g, b], each rounded to 0 or 255.
async function middle(buffer) {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const i = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
  return [data[i], data[i + 1], data[i + 2]].map((v) => (v > 128 ? 255 : 0));
}
const RIGHT_HALF = { x: 0.5, y: 0, width: 0.5, height: 1 };

// Starts an upload, puts `image` where it was signed for, and says it's ready.
async function upload(user, image, type = 'image/png', crop, kind = 'avatar') {
  const start = await post(user, `/profile/${kind}`, { type, size: image.length });
  expect(start.status).toBe(201);
  const signed = signedUploads.at(-1);
  putMockObject('profile-pics', signed.filename, image, type);
  return post(user, `/profile/${kind}/${start.body.uploadId}/ready`, crop ? { crop } : {});
}
const stored = (user, avatar) => objects.get(`profile-pics/${user.id}/${avatar}.webp`).body;

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

  it("keeps the square chosen in the cropper, from the picture as it's shown", async () => {
    const gina = await makeUser();
    const res = await upload(gina, await halves(), 'image/png', RIGHT_HALF);
    expect(res.status).toBe(200);
    const picture = stored(gina, res.body.avatar);
    expect(await sharp(picture).metadata()).toMatchObject({ width: 100, height: 100 });
    expect(await middle(picture)).toEqual([0, 0, 255]);

    // A photo turned by its EXIF orientation is cropped as shown: 6 stands it up, red on top.
    const top = { x: 0, y: 0, width: 1, height: 0.5 };
    const photo = await upload(gina, await halves('jpeg', { orientation: 6 }), 'image/jpeg', top);
    expect(await middle(stored(gina, photo.body.avatar))).toEqual([255, 0, 0]);

    // Crops that don't fit are refused, and the upload dropped.
    for (const crop of [{ x: 0.6, y: 0, width: 0.5, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }, 'all']) {
      expect((await upload(gina, await halves(), 'image/png', crop)).status).toBe(400);
    }
    expect([...objects.keys()].some((k) => k.startsWith(`profile-pics/src/${gina.id}/`))).toBe(false);
  });

  it('keeps animated pictures animated when cropped', async () => {
    const hal = await makeUser();
    const frame = (colour) => sharp({ create: { width: 80, height: 40, channels: 4, background: colour } }).png().toBuffer();
    const gif = await sharp([await frame('#0f0'), await frame('#f00'), await frame('#00f')], { join: { animated: true } }).gif().toBuffer();
    const res = await upload(hal, gif, 'image/gif', { x: 0.25, y: 0.25, width: 0.25, height: 0.5 });
    expect(res.status).toBe(200);
    expect(await sharp(stored(hal, res.body.avatar), { animated: true }).metadata()).toMatchObject({ pages: 3, width: 20, pageHeight: 20 });
  });

  it("crops bots' pictures too", async () => {
    const owner = await makeUser();
    const created = await post(owner, '/applications', { name: 'Cropped bot' });
    const avatar = `data:image/png;base64,${(await halves()).toString('base64')}`;
    const patch = (body) => request(app).patch(`/api/applications/${created.body.id}`).set(authed(owner)).send(body);
    const res = await patch({ avatar, avatarCrop: RIGHT_HALF });
    expect(res.status).toBe(200);
    expect(await middle(objects.get(`profile-pics/${res.body.bot.id}/${res.body.bot.avatar}.webp`).body)).toEqual([0, 0, 255]);
    expect((await patch({ avatar, avatarCrop: { x: 2 } })).status).toBe(400);
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

describe('profile banners', () => {
  it('makes a 960×384 WebP from the chosen rectangle, never enlarged, and replaces or removes it', async () => {
    const fay = await makeUser();
    const events = [];
    clients.set('999998', [{ readyState: 1, identified: true, send: (m) => events.push(JSON.parse(m)) }]);
    const res = await upload(fay, await halves(), 'image/png', RIGHT_HALF, 'banner');
    expect(res.status).toBe(200);
    const { banner } = res.body;
    expect(banner).toMatch(/^[0-9a-f-]{36}$/);
    const body = objects.get(`profile-pics/${fay.id}/banner-${banner}.webp`).body;
    // The right half (100 px wide): kept small, 5:2.
    expect(await sharp(body).metadata()).toMatchObject({ format: 'webp', width: 100, height: 40 });
    expect(await middle(body)).toEqual([0, 0, 255]);
    expect(events.find((e) => e.type === 'user_profile')).toMatchObject({ user: { id: fay.id, banner } });
    clients.delete('999998');

    const big = (await upload(fay, await png(2000, 1000), 'image/png', undefined, 'banner')).body.banner;
    expect(await sharp(objects.get(`profile-pics/${fay.id}/banner-${big}.webp`).body).metadata()).toMatchObject({ width: 960, height: 384 });
    expect(deletedObjects).toContainEqual({ bucket: 'profile-pics', key: `${fay.id}/banner-${banner}.webp` });
    // The avatar is untouched by banners.
    expect((await request(app).get('/api/profile').set(authed(fay))).body).toMatchObject({ avatar: null, banner: big });

    const removed = await request(app).delete('/api/profile/banner').set(authed(fay));
    expect(removed.body.banner).toBe(null);
    expect(deletedObjects).toContainEqual({ bucket: 'profile-pics', key: `${fay.id}/banner-${big}.webp` });
  });

  it("doesn't take an avatar upload as a banner's", async () => {
    const gus = await makeUser();
    const start = await post(gus, '/profile/avatar', { type: 'image/png', size: 10 });
    expect((await post(gus, `/profile/banner/${start.body.uploadId}/ready`)).status).toBe(404);
  });

  it('keeps a banner colour (0xRRGGBB or null)', async () => {
    const hal = await makeUser();
    const put = (body) => request(app).put('/api/profile').set(authed(hal)).send(body);
    expect((await put({ bannerColor: 0x5865f2 })).body.banner_color).toBe(0x5865f2);
    expect((await put({ bannerColor: 0x1000000 })).status).toBe(400);
    expect((await put({ bannerColor: '#fff' })).status).toBe(400);
    expect((await put({ bio: 'hi' })).body.banner_color).toBe(0x5865f2);
    expect((await put({ bannerColor: null })).body.banner_color).toBe(null);
  });
});
