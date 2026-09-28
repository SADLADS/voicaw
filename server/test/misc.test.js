import './helpers/mockS3.js';
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
  it('requires auth for profile pic upload URLs', async () => {
    const res = await request(app).get('/api/upload_profile_pic').query({ type: 'image/png' });
    expect(res.status).toBe(401);
  });

  it('requires a content type for profile pic upload URLs', async () => {
    await registerUser(app, request, 'uploader1', 'uploader-pw');
    const { response } = await loginUser(app, request, 'uploader1', 'uploader-pw');

    const res = await request(app)
      .get('/api/upload_profile_pic')
      .set('Authorization', `Bearer ${response.body.token}`);
    expect(res.status).toBe(400);
  });

  it('returns a signed upload URL for a valid request', async () => {
    await registerUser(app, request, 'uploader2', 'uploader-pw');
    const { response } = await loginUser(app, request, 'uploader2', 'uploader-pw');

    const res = await request(app)
      .get('/api/upload_profile_pic')
      .query({ type: 'image/png' })
      .set('Authorization', `Bearer ${response.body.token}`);
    expect(res.status).toBe(201);
    expect(res.body.url).toContain('mock-s3.test');
  });

  it('generates a unique filename for generic file uploads', async () => {
    await registerUser(app, request, 'uploader3', 'uploader-pw');
    const { response } = await loginUser(app, request, 'uploader3', 'uploader-pw');

    const res = await request(app)
      .get('/api/upload_file')
      .query({ type: 'image/jpeg' })
      .set('Authorization', `Bearer ${response.body.token}`);
    expect(res.status).toBe(201);
    expect(res.body.uploadUrl).toContain('mock-s3.test');
    expect(res.body.fileUrl).toMatch(/\.jpeg$/);
  });

  it('names opaque (encrypted) attachment uploads .bin', async () => {
    await registerUser(app, request, 'uploader4', 'uploader-pw');
    const { response } = await loginUser(app, request, 'uploader4', 'uploader-pw');

    const res = await request(app)
      .get('/api/upload_file')
      .query({ type: 'application/octet-stream' })
      .set('Authorization', `Bearer ${response.body.token}`);
    expect(res.status).toBe(201);
    expect(res.body.fileUrl).toMatch(/\/uploads\/[0-9a-f-]{36}\.bin$/);
  });
});
