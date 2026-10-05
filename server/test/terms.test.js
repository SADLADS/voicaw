import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'fs';
import path from 'path';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db');
const { TERMS_VERSION } = require('../terms');

const auth = (token) => ({ Authorization: `Bearer ${token}` });
let count = 0;
const name = () => `terms-${++count}`;

describe('terms of use', () => {
  it('is the date the terms page says it last changed', () => {
    const build = readFileSync(path.join(__dirname, '../../website/build.mjs'), 'utf8');
    expect(build).toMatch(new RegExp(`slug: 'terms', file: 'terms.html', title: 'Terms of use', updated: '${TERMS_VERSION}'`));
    expect(request(app).get('/api/config').then((r) => r.body.termsVersion)).resolves.toBe(TERMS_VERSION);
  });

  it("can't register without ticking them, or for old terms", async () => {
    for (const acceptedTerms of [null, '2020-01-01']) {
      const { response } = await registerUser(app, request, name(), 'pw-terms-1', { acceptedTerms });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('terms');
    }
  });

  it('keeps which terms a new account accepted, and when', async () => {
    const username = name();
    const { response } = await registerUser(app, request, username, 'pw-terms-1');
    expect(response.status).toBe(201);
    expect(response.body.termsAccepted).toBe(true);
    const row = await db.get('SELECT terms_version, terms_accepted_at FROM users WHERE id = ?', [response.body.id]);
    expect(row.terms_version).toBe(TERMS_VERSION);
    expect(row.terms_accepted_at).toBeGreaterThan(0);
    const login = await loginUser(app, request, username, 'pw-terms-1');
    expect(login.response.body.termsAccepted).toBe(true);
  });

  it('asks someone from before the terms (or before a change) to accept them once', async () => {
    const username = name();
    const { response } = await registerUser(app, request, username, 'pw-terms-1');
    await db.run('UPDATE users SET terms_version = NULL, terms_accepted_at = NULL WHERE id = ?', [response.body.id]);
    const { token } = response.body;

    expect((await request(app).get('/api/profile').set(auth(token))).body.termsAccepted).toBe(false);
    expect((await loginUser(app, request, username, 'pw-terms-1')).response.body.termsAccepted).toBe(false);

    // Accepting other terms than the current ones (they changed meanwhile) is refused.
    const stale = await request(app).post('/api/terms/accept').set(auth(token)).send({ version: '2020-01-01' });
    expect(stale.status).toBe(409);
    expect(stale.body.version).toBe(TERMS_VERSION);
    expect((await request(app).post('/api/terms/accept').send({ version: TERMS_VERSION })).status).toBe(401);

    const ok = await request(app).post('/api/terms/accept').set(auth(token)).send({ version: TERMS_VERSION });
    expect(ok.status).toBe(200);
    expect((await request(app).get('/api/profile').set(auth(token))).body.termsAccepted).toBe(true);
  });
});
