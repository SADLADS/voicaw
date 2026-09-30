import './helpers/mockS3.js';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { registerUser } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db');
const auth = (token) => ({ Authorization: `Bearer ${token}` });

const MEDIA = 'https://static.klipy.com/ii/abc/';
function klipyItem(id, extra = {}) {
  const size = (name, w, h) => ({ url: `${MEDIA}${id}-${name}`, width: w, height: h, size: 1000 });
  return {
    id,
    slug: `gif-${id}`,
    title: `GIF ${id}`,
    type: 'gif',
    file: {
      hd: { gif: size('hd.gif', 498, 373), webp: size('hd.webp', 498, 374) },
      sm: { gif: size('sm.gif', 220, 165), webp: size('sm.webp', 220, 165) },
    },
    ...extra,
  };
}

function stubKlipy(body = { result: true, data: { data: [klipyItem(1), klipyItem(2)], has_next: true } }, ok = true) {
  const fetchMock = vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

let admin;
let user;
beforeAll(async () => {
  admin = (await registerUser(app, request, 'gif-admin', 'password1234')).response.body;
  user = (await registerUser(app, request, 'gif-user', 'password1234')).response.body;
  await db.run('UPDATE users SET is_admin = 1 WHERE id = ?', [admin.id]);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.KLIPY_API_KEY;
  await request(app).put('/api/admin/settings/klipyApiKey').set(auth(admin.token)).send({ value: null });
});

describe('admin settings', () => {
  it('is only for admins', async () => {
    expect((await request(app).get('/api/admin').set(auth(user.token))).status).toBe(403);
    expect((await request(app).put('/api/admin/settings/klipyApiKey').set(auth(user.token)).send({ value: 'x' })).status).toBe(403);
    expect((await request(app).get('/api/admin')).status).toBe(401);
  });

  it('falls back to .env, lets an admin override it, and never shows a secret', async () => {
    process.env.KLIPY_API_KEY = 'from-env-1234';
    let res = await request(app).get('/api/admin').set(auth(admin.token));
    expect(res.status).toBe(200);
    let setting = res.body.settings.find((s) => s.key === 'klipyApiKey');
    expect(setting).toMatchObject({ source: 'env', secret: true, value: null, hint: '…1234', env: 'KLIPY_API_KEY' });
    expect(JSON.stringify(res.body)).not.toContain('from-env');

    res = await request(app).put('/api/admin/settings/klipyApiKey').set(auth(admin.token)).send({ value: ' saved-by-admin-9876 ' });
    setting = res.body.settings.find((s) => s.key === 'klipyApiKey');
    expect(setting).toMatchObject({ source: 'admin', hint: '…9876' });

    const fetchMock = stubKlipy();
    await request(app).get('/api/gifs/trending').set(auth(user.token));
    expect(String(fetchMock.mock.calls[0][0])).toContain('/saved-by-admin-9876/gifs/trending');

    res = await request(app).put('/api/admin/settings/klipyApiKey').set(auth(admin.token)).send({ value: null });
    expect(res.body.settings.find((s) => s.key === 'klipyApiKey').source).toBe('env');
  });

  it('rejects unknown settings and non-string values', async () => {
    expect((await request(app).put('/api/admin/settings/nope').set(auth(admin.token)).send({ value: 'x' })).status).toBe(404);
    expect((await request(app).put('/api/admin/settings/klipyApiKey').set(auth(admin.token)).send({ value: 5 })).status).toBe(400);
  });

  it('adds and removes admins, but not yourself', async () => {
    let res = await request(app).post('/api/admin/admins').set(auth(admin.token)).send({ username: 'gif-user' });
    expect(res.body.admins.map((a) => a.username)).toEqual(['gif-admin', 'gif-user']);
    expect((await request(app).get('/api/admin').set(auth(user.token))).status).toBe(200);

    res = await request(app).delete(`/api/admin/admins/${user.id}`).set(auth(admin.token));
    expect(res.body.admins.map((a) => a.username)).toEqual(['gif-admin']);
    expect((await request(app).delete(`/api/admin/admins/${admin.id}`).set(auth(admin.token))).status).toBe(400);
    expect((await request(app).post('/api/admin/admins').set(auth(admin.token)).send({ username: 'nobody-here' })).status).toBe(404);
  });
});

describe('GIF search', () => {
  it('is off without a key', async () => {
    expect((await request(app).get('/api/config')).body.gifsEnabled).toBe(false);
    expect((await request(app).get('/api/gifs/trending').set(auth(user.token))).status).toBe(503);
  });

  it('proxies Klipy with a pseudonymous customer id, dropping ads and foreign URLs', async () => {
    process.env.KLIPY_API_KEY = 'k1';
    expect((await request(app).get('/api/config')).body.gifsEnabled).toBe(true);
    const fetchMock = stubKlipy({
      result: true,
      data: {
        data: [
          klipyItem(1),
          { type: 'ad', id: 99 },
          klipyItem(3, { file: { hd: { webp: { url: 'https://evil.example/x.webp', width: 1, height: 1 } } } }),
        ],
        has_next: false,
      },
    });
    const res = await request(app).get('/api/gifs/search?q=cats&page=2').set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      gifs: [{
        id: '1',
        title: 'GIF 1',
        url: `${MEDIA}1-hd.webp`,
        width: 498,
        height: 374,
        preview: `${MEDIA}1-sm.webp`,
        previewWidth: 220,
        previewHeight: 165,
      }],
      next: null,
    });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/k1/gifs/search');
    expect(url.searchParams.get('q')).toBe('cats');
    expect(url.searchParams.get('page')).toBe('2');
    const customer = url.searchParams.get('customer_id');
    expect(customer).toMatch(/^[0-9a-f]{32}$/);
    // Stable per user, different between users.
    await request(app).get('/api/gifs/trending').set(auth(user.token));
    await request(app).get('/api/gifs/trending').set(auth(admin.token));
    const ids = fetchMock.mock.calls.map(([u]) => new URL(String(u)).searchParams.get('customer_id'));
    expect(ids).toEqual([customer, customer, expect.not.stringMatching(customer)]);
  });

  it('says so when Klipy fails, and needs a query to search', async () => {
    process.env.KLIPY_API_KEY = 'k1';
    stubKlipy({}, false);
    const res = await request(app).get('/api/gifs/trending').set(auth(user.token));
    expect(res.status).toBe(502);
    expect((await request(app).get('/api/gifs/search?q=').set(auth(user.token))).status).toBe(400);
  });
});

describe('GIF favourites', () => {
  const gif = {
    id: '42', title: 'Hi', url: `${MEDIA}42.webp`, width: 400, height: 300,
    preview: `${MEDIA}42-sm.webp`, previewWidth: 200, previewHeight: 150,
  };

  it('saves, lists newest first, and removes', async () => {
    const other = { ...gif, id: '43', url: `${MEDIA}43.webp` };
    expect((await request(app).put('/api/gif-favorites/42').set(auth(user.token)).send({ gif })).status).toBe(204);
    expect((await request(app).put('/api/gif-favorites/43').set(auth(user.token)).send({ gif: other })).status).toBe(204);
    // Saving again is harmless.
    expect((await request(app).put('/api/gif-favorites/42').set(auth(user.token)).send({ gif })).status).toBe(204);

    let res = await request(app).get('/api/gif-favorites').set(auth(user.token));
    expect(res.body.favorites.map((g) => g.id)).toEqual(['43', '42']);
    expect(res.body.favorites[1]).toEqual(gif);
    // Someone else's list is their own.
    expect((await request(app).get('/api/gif-favorites').set(auth(admin.token))).body.favorites).toEqual([]);

    await request(app).delete('/api/gif-favorites/43').set(auth(user.token));
    res = await request(app).get('/api/gif-favorites').set(auth(user.token));
    expect(res.body.favorites.map((g) => g.id)).toEqual(['42']);
  });

  it('only takes Klipy GIFs', async () => {
    const bad = { ...gif, id: '44', url: 'https://evil.example/x.gif' };
    expect((await request(app).put('/api/gif-favorites/44').set(auth(user.token)).send({ gif: bad })).status).toBe(400);
    expect((await request(app).put('/api/gif-favorites/45').set(auth(user.token)).send({ gif })).status).toBe(400);
  });
});
