import { signedUploads } from './helpers/mockS3.js';
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
    expect((await request(app).get('/api/upload_profile_pic').query({ type: 'image/png', size: 10 })).status).toBe(401);
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

  it('refuses attachment uploads without a size or over 100MB', async () => {
    const get = (query) => request(app).get('/api/upload_file').query(query).set(authed());
    expect((await get({ type: 'application/octet-stream' })).status).toBe(400);
    expect((await get({ type: 'application/octet-stream', size: 0 })).status).toBe(400);
    expect((await get({ type: 'application/octet-stream', size: 'lots' })).status).toBe(400);
    expect((await get({ type: 'application/octet-stream', size: 100 * MB + 1 })).status).toBe(413);
    expect((await get({ type: 'application/octet-stream', size: 100 * MB })).status).toBe(201);
    expect((await get({ size: 10 })).status).toBe(400);
  });

  it('signs profile picture uploads, which must be images of at most 8MB', async () => {
    const get = (query) => request(app).get('/api/upload_profile_pic').query(query).set(authed());

    const ok = await get({ type: 'image/png', size: 2048 });
    expect(ok.status).toBe(201);
    expect(ok.body.url).toContain('mock-s3.test');
    expect(signedUploads.at(-1)).toMatchObject({ bucket: 'profile-pics', contentType: 'image/png', contentLength: 2048 });

    expect((await get({ type: 'image/png' })).status).toBe(400);
    expect((await get({ size: 10 })).status).toBe(400);
    expect((await get({ type: 'text/html', size: 10 })).status).toBe(400);
    expect((await get({ type: 'image/png', size: 8 * MB + 1 })).status).toBe(413);
  });
});
