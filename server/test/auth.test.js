import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { registerUser, loginUser } from './helpers/authFlow.js';
import { generateUserKeys } from '../../client/src/services/encryptionService.js';

const app = require('../index.js');

describe('registration', () => {
  it('registers a new user and returns a JWT', async () => {
    const { response } = await registerUser(app, request, 'alice', 'correct horse battery staple');

    expect(response.status).toBe(201);
    expect(response.body.token).toBeTruthy();
    expect(response.body.username).toBe('alice');
    expect(typeof response.body.id).toBe('number');
  });

  it('issues a registration token that carries the username', async () => {
    const { response } = await registerUser(app, request, 'regtoken', 'password123');

    const decoded = jwt.verify(response.body.token, process.env.JWT_SECRET);
    expect(decoded.username).toBe('regtoken');
    expect(decoded.id).toBe(response.body.id);
  });

  it('rejects a duplicate username with 409', async () => {
    await registerUser(app, request, 'bob', 'password123');
    const { response } = await registerUser(app, request, 'bob', 'different-password');

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/already exists/i);
  });

  it('rejects initiateregister missing fields with 400', async () => {
    const res = await request(app).post('/api/initiateregister').send({ userIdentifier: 'nouser' });
    expect(res.status).toBe(400);
  });

  it('rejects finaliseregister missing key material with 400', async () => {
    const res = await request(app)
      .post('/api/finaliseregister')
      .send({ userIdentifier: 'nouser', registrationRecord: 'x' });
    expect(res.status).toBe(400);
  });

  it('rejects an encryption key that is not signed by the identity key', async () => {
    const real = await generateUserKeys();
    const other = await generateUserKeys();
    const res = await request(app)
      .post('/api/finaliseregister')
      .send({
        userIdentifier: 'forger', registrationRecord: 'x', keyBackup: '{}',
        ...real.public, encryptionKey: other.public.encryptionKey,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature/i);
  });
});

describe('login', () => {
  it('logs in and returns the key backup, which opens with the login\'s exportKey', async () => {
    const { keys, exportKey: registrationExportKey } = await registerUser(app, request, 'carol', 'hunter2-hunter2');
    const { response, keys: fromBackup, exportKey } = await loginUser(app, request, 'carol', 'hunter2-hunter2');

    expect(response.status).toBe(200);
    expect(response.body.token).toBeTruthy();
    expect(response.body.username).toBe('carol');
    // OPAQUE's exportKey is stable across registration and every login...
    expect(exportKey).toBe(registrationExportKey);
    // ...so the backup opens, and holds the same keys the server publishes.
    expect(fromBackup).toEqual({ public: keys.public, private: keys.private });
    expect(response.body).toMatchObject(keys.public);
    // The server only ever has the encrypted backup.
    expect(response.body.keyBackup).not.toContain(keys.private.encryptionKey);
  });

  it('fails login with the wrong password', async () => {
    await registerUser(app, request, 'dave', 'correct-password');
    const { response, failedAt } = await loginUser(app, request, 'dave', 'wrong-password');

    expect(failedAt).toBeTruthy();
    expect(response.body.token).toBeFalsy();
  });

  it('does not reveal whether a username exists to logged-out visitors', async () => {
    await registerUser(app, request, 'real-user', 'real-password');

    // Unknown user: a normal-looking OPAQUE response, failing at the end like a bad password.
    const unknown = await loginUser(app, request, 'nobody-registered', 'whatever');
    const wrongPassword = await loginUser(app, request, 'real-user', 'not-the-password');

    for (const attempt of [unknown, wrongPassword]) {
      expect(attempt.failedAt).toBe('finishLogin-client');
      expect(attempt.response.status).toBe(200);
      expect(Object.keys(attempt.response.body)).toEqual(['loginResponse']);
    }
    expect(unknown.response.body.loginResponse.length).toBe(wrongPassword.response.body.loginResponse.length);
  });

  it('rejects a forged finaliselogin for an unknown user without saying why', async () => {
    const res = await request(app)
      .post('/api/finaliselogin')
      .send({ userIdentifier: 'nobody-2', finishLoginRequest: 'x', clientSessionKey: 'y' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  it('never needs the client\'s secret login state', async () => {
    const res = await request(app).post('/api/initiatelogin').send({ userIdentifier: 'someone' });
    expect(res.status).toBe(400);
    expect(res.body.error).not.toMatch(/clientLoginState/);
  });

  it('issues a token whose id/username round-trip through JWT_SECRET', async () => {
    await registerUser(app, request, 'erin', 'super-secret-pw');
    const { response } = await loginUser(app, request, 'erin', 'super-secret-pw');

    const decoded = jwt.verify(response.body.token, process.env.JWT_SECRET);
    expect(decoded.username).toBe('erin');
    expect(decoded.id).toBe(response.body.id);
  });
});

describe('GET /api/profile', () => {
  it('rejects requests with no Authorization header', async () => {
    const res = await request(app).get('/api/profile');
    expect(res.status).toBe(401);
  });

  it('rejects an invalid token', async () => {
    const res = await request(app).get('/api/profile').set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(403);
  });

  it('returns the profile for a valid token', async () => {
    await registerUser(app, request, 'frank', 'password-for-frank');
    const { response: loginRes } = await loginUser(app, request, 'frank', 'password-for-frank');

    const res = await request(app)
      .get('/api/profile')
      .set('Authorization', `Bearer ${loginRes.body.token}`);

    expect(res.status).toBe(200);
    expect(res.body.username).toBe('frank');
    expect(res.body.keyBackup).toBeUndefined();
  });
});
