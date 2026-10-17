import {
  signedUploads, signedParts, multipartUploads, putMockPart, abortedUploads, objects,
} from './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');

describe('GET /api/config', () => {
  it('exposes the plaintext length limit and S3 endpoint without auth', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.maxPlaintextLength).toBe(parseInt(process.env.MAX_MESSAGE_LENGTH, 10));
    expect(res.body.s3Endpoint).toBe(process.env.S3_ENDPOINT);
  });

  // What an app that chose this server on the login screen needs (client/src/utils/server.js).
  it('names the terms and privacy policy, and the websocket only when set', async () => {
    const res = await request(app).get('/api/config');
    expect(res.body.termsUrl).toBe('https://voicaw.com/terms/');
    expect(res.body.privacyUrl).toBe('https://voicaw.com/privacy/');
    expect(res.body).not.toHaveProperty('websocketUrl');
  });

  it('lets the apps and the web app log in from elsewhere (CORS)', async () => {
    const res = await request(app).get('/api/config').set('Origin', 'voicaw://app');
    expect(res.headers['access-control-allow-origin']).toBe('voicaw://app');
    const other = await request(app).get('/api/config').set('Origin', 'https://evil.example.com');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('error handler', () => {
  it('turns an exception thrown inside a route into a JSON 500', async () => {
    const res = await request(app)
      .post('/api/initiateregister')
      .send({ userIdentifier: 'x', registrationRequest: 'not-a-valid-opaque-message' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'An internal server error occurred.' });
  });
});

describe('authenticateJWT middleware', () => {
  it('rejects a malformed Authorization header', async () => {
    const res = await request(app).get('/api/dms-list').set('Authorization', 'Token abc123');
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with a different secret', async () => {
    const jwt = require('jsonwebtoken');
    const forged = jwt.sign({ id: 1, username: 'nobody' }, 'wrong-secret');
    const res = await request(app).get('/api/dms-list').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(403);
  });

  it('accepts a valid token', async () => {
    await registerUser(app, request, 'misc-user', 'misc-password');
    const { response } = await loginUser(app, request, 'misc-user', 'misc-password');

    const res = await request(app)
      .get('/api/dms-list')
      .set('Authorization', `Bearer ${response.body.token}`);
    expect(res.status).toBe(200);
  });
});

describe('upload URL routes', () => {
  let token;
  const authed = () => ({ Authorization: `Bearer ${token}` });
  const MB = 1024 * 1024;

  it('requires auth for upload URLs', async () => {
    expect((await request(app).get('/api/upload_file').query({ type: 'image/png', size: 10 })).status).toBe(401);
  });

  it('signs the exact file size into attachment upload URLs', async () => {
    await registerUser(app, request, 'uploader1', 'uploader-pw');
    token = (await loginUser(app, request, 'uploader1', 'uploader-pw')).response.body.token;

    const res = await request(app).get('/api/upload_file').query({ type: 'application/octet-stream', size: 12345 }).set(authed());

    expect(res.status).toBe(201);
    expect(res.body.uploadUrl).toContain('mock-s3.test');
    expect(res.body.fileUrl).toMatch(/\/uploads\/[0-9a-f-]{36}\.bin$/);
    expect(signedUploads.at(-1)).toMatchObject({ bucket: 'uploads', contentType: 'application/octet-stream', contentLength: 12345 });
  });

  it('refuses single attachment uploads without a size or over 100MB', async () => {
    const get = (query) => request(app).get('/api/upload_file').query(query).set(authed());
    expect((await get({ type: 'application/octet-stream' })).status).toBe(400);
    expect((await get({ type: 'application/octet-stream', size: 0 })).status).toBe(400);
    expect((await get({ type: 'application/octet-stream', size: 'lots' })).status).toBe(400);
    expect((await get({ type: 'application/octet-stream', size: 100 * MB + 1 })).status).toBe(413);
    expect((await get({ type: 'application/octet-stream', size: 100 * MB })).status).toBe(201);
    expect((await get({ size: 10 })).status).toBe(400);
  });
});

describe('multipart attachment uploads', () => {
  const MB = 1024 * 1024;
  const db = require('../db.js');
  const { PART_BYTES } = require('../routes/uploads.js');
  let user;
  let admin;
  let other;
  const as = (who) => ({ Authorization: `Bearer ${who.token}` });
  const start = (who, body) => request(app).post('/api/upload_file/multipart').set(as(who)).send(body);
  const partUrl = (who, name, n) => request(app).post(`/api/upload_file/multipart/${name}/parts/${n}`).set(as(who));
  const complete = (who, name) => request(app).post(`/api/upload_file/multipart/${name}/complete`).set(as(who));
  const setLimit = (value) => request(app).put('/api/admin/settings/uploadLimit').set(as(admin)).send({ value });

  async function makeUser(username, { isAdmin = false } = {}) {
    const { response } = await registerUser(app, request, username, 'multipart-pw');
    if (isAdmin) await db.run('UPDATE users SET is_admin = 1 WHERE id = ?', [response.body.id]);
    return { id: response.body.id, token: (await loginUser(app, request, username, 'multipart-pw')).response.body.token };
  }

  it('starts an upload in parts, signs each part at its length and puts them together', async () => {
    user = await makeUser('multipart1');
    other = await makeUser('multipart2');
    admin = await makeUser('multipart-admin', { isAdmin: true });
    const size = 2 * PART_BYTES + 1234;

    const started = await start(user, { type: 'application/octet-stream', size });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ partSize: PART_BYTES, partCount: 3 });
    expect(started.body.fileUrl).toMatch(/\/uploads\/[0-9a-f-]{36}\.bin$/);
    const { name } = started.body;
    expect(await db.get('SELECT user_id FROM uploads WHERE key = ?', [name])).toEqual({ user_id: user.id });
    const [uploadId] = [...multipartUploads.keys()].filter((id) => multipartUploads.get(id).key === name);

    for (const n of [1, 2, 3]) expect((await partUrl(user, name, n)).status).toBe(200);
    expect(signedParts.slice(-3).map((p) => p.contentLength)).toEqual([PART_BYTES, PART_BYTES, 1234]);
    expect((await partUrl(user, name, 4)).status).toBe(400);
    expect((await partUrl(user, name, 0)).status).toBe(400);
    // Someone else's upload doesn't exist for them.
    expect((await partUrl(other, name, 1)).status).toBe(404);
    expect((await complete(other, name)).status).toBe(404);

    // Not until every part is there, at its length.
    putMockPart(uploadId, 1, PART_BYTES);
    putMockPart(uploadId, 3, 1234);
    expect((await complete(user, name)).status).toBe(409);
    putMockPart(uploadId, 2, PART_BYTES - 1);
    expect((await complete(user, name)).status).toBe(409);
    putMockPart(uploadId, 2, PART_BYTES);
    const done = await complete(user, name);
    expect(done.status).toBe(200);
    expect(done.body.fileUrl).toBe(started.body.fileUrl);
    expect(objects.get(`uploads/${name}`).size).toBe(size);
    // Finished: no more parts.
    expect((await partUrl(user, name, 1)).status).toBe(404);
  });

  it('abandons an upload', async () => {
    const { name } = (await start(user, { type: 'application/octet-stream', size: 20 * MB })).body;
    expect((await request(app).delete(`/api/upload_file/multipart/${name}`).set(as(other))).status).toBe(404);
    expect((await request(app).delete(`/api/upload_file/multipart/${name}`).set(as(user))).status).toBe(204);
    expect(abortedUploads.at(-1).key).toBe(name);
    expect((await complete(user, name)).status).toBe(404);
  });

  it("follows the admin's file size limit, 500MB by default", async () => {
    const config = async () => (await request(app).get('/api/config')).body.maxUploadBytes;
    expect(await config()).toBe(500 * MB);
    expect((await start(user, { type: 'application/octet-stream', size: 500 * MB + 1 })).status).toBe(413);
    expect((await start(user, { type: 'application/octet-stream', size: 500 * MB })).status).toBe(201);
    expect((await start(user, { type: 'application/octet-stream' })).status).toBe(400);
    expect((await start(user, { size: 10 })).status).toBe(400);

    expect((await setLimit('300')).status).toBe(400);
    expect((await setLimit('50')).status).toBe(200);
    try {
      expect(await config()).toBe(50 * MB);
      expect((await start(user, { type: 'application/octet-stream', size: 50 * MB + 1 })).status).toBe(413);
      // Single uploads too.
      const single = (size) => request(app).get('/api/upload_file').query({ type: 'application/octet-stream', size }).set(as(user));
      expect((await single(50 * MB + 1)).status).toBe(413);
      expect((await single(50 * MB)).status).toBe(201);
    } finally {
      await setLimit(null);
    }
  });

  it('limits how many uploads one person has going', async () => {
    const someone = await makeUser('multipart3');
    for (let i = 0; i < 10; i++) {
      expect((await start(someone, { type: 'application/octet-stream', size: MB })).status).toBe(201);
    }
    expect((await start(someone, { type: 'application/octet-stream', size: MB })).status).toBe(429);
    expect((await start(user, { type: 'application/octet-stream', size: MB })).status).toBe(201);
  });
});
