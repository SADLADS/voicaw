import './helpers/mockS3.js';
import './helpers/mockWebPush.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const db = require('../db.js');

// Login with Voicaw (oauth.js): Discord's OAuth2 authorisation code grant.

let userCount = 0;
async function makeUser(prefix = 'oauth-user') {
  const username = `${prefix}-${++userCount}`;
  const password = 'pw-oauth-123';
  const { response: regRes } = await registerUser(app, request, username, password);
  const { response: loginRes } = await loginUser(app, request, username, password);
  return { id: regRes.body.id, username, token: loginRes.body.token };
}

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });
const api = {
  get: (user, url, query = {}) => request(app).get(`/api${url}`).query(query).set(authed(user)),
  post: (user, url, body = {}) => request(app).post(`/api${url}`).set(authed(user)).send(body),
  patch: (user, url, body = {}) => request(app).patch(`/api${url}`).set(authed(user)).send(body),
  delete: (user, url) => request(app).delete(`/api${url}`).set(authed(user)),
};

const REDIRECT = 'https://games.example/callback';

// An application with a client secret and REDIRECT as its redirect URI.
async function makeSite(owner) {
  const created = await api.post(owner, '/applications', { name: 'Games Site' });
  expect(created.status).toBe(201);
  const id = created.body.id;
  const updated = await api.patch(owner, `/applications/${id}`, { redirect_uris: [REDIRECT] });
  expect(updated.status).toBe(200);
  expect(updated.body.redirect_uris).toEqual([REDIRECT]);
  const secret = await api.post(owner, `/applications/${id}/client-secret`);
  expect(secret.status).toBe(200);
  return { id, secret: secret.body.client_secret, botToken: created.body.token };
}

const link = (site, extra = {}) => ({
  client_id: String(site.id), response_type: 'code', scope: 'identify', redirect_uri: REDIRECT, state: 'xyz', ...extra,
});

// The person agrees; resolves to the code the site gets back.
async function authorise(user, site, extra = {}) {
  const res = await api.post(user, '/oauth2/authorize', link(site, extra));
  expect(res.status).toBe(200);
  const back = new URL(res.body.location);
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
  expect(back.searchParams.get('state')).toBe(extra.state ?? 'xyz');
  return back.searchParams.get('code');
}

// The site's server, as Discord's examples call it (a form).
const token = (fields, auth = null) => {
  const req = request(app).post('/api/v10/oauth2/token').type('form').send(fields);
  return auth ? req.set('Authorization', auth) : req;
};
const exchange = (site, code, extra = {}) => token({
  client_id: String(site.id), client_secret: site.secret, grant_type: 'authorization_code', code, redirect_uri: REDIRECT, ...extra,
});
const me = (accessToken) => request(app).get('/api/v10/users/@me').set('Authorization', `Bearer ${accessToken}`);

describe('Login with Voicaw', () => {
  it('logs a person in to a site: code, token, users/@me', async () => {
    const owner = await makeUser('o-owner');
    const site = await makeSite(owner);
    const person = await makeUser('o-person');

    const info = await api.get(person, '/oauth2/authorize', link(site));
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ login: true, id: site.id, name: 'Games Site', scopes: ['identify'], redirect_uri: REDIRECT, authorized: false });
    expect(info.body.owner).toMatchObject({ id: owner.id });

    const code = await authorise(person, site);
    const res = await exchange(site, code);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.body).toMatchObject({ token_type: 'Bearer', expires_in: 604800, scope: 'identify' });
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.refresh_token).toBeTruthy();

    const user = await me(res.body.access_token);
    expect(user.status).toBe(200);
    expect(user.body).toMatchObject({ id: String(person.id), username: person.username, bot: false });
    expect(user.body.email).toBeUndefined();

    const about = await request(app).get('/api/v10/oauth2/@me').set('Authorization', `Bearer ${res.body.access_token}`);
    expect(about.status).toBe(200);
    expect(about.body).toMatchObject({ application: { id: String(site.id), name: 'Games Site' }, scopes: ['identify'], user: { id: String(person.id) } });

    // Stored as hashes only.
    const row = await db.get('SELECT * FROM oauth_tokens WHERE user_id = ?', [person.id]);
    expect(JSON.stringify(row)).not.toContain(res.body.access_token);
    expect(JSON.stringify(row)).not.toContain(res.body.refresh_token);
    const appRow = await db.get('SELECT * FROM bot_applications WHERE id = ?', [site.id]);
    expect(JSON.stringify(appRow)).not.toContain(site.secret);

    // Now it's been let in, prompt=none links needn't ask.
    expect((await api.get(person, '/oauth2/authorize', link(site))).body.authorized).toBe(true);
  });

  it('takes the client in HTTP Basic, and JSON bodies', async () => {
    const owner = await makeUser();
    const site = await makeSite(owner);
    const code = await authorise(owner, site);
    const basic = `Basic ${Buffer.from(`${site.id}:${site.secret}`).toString('base64')}`;
    const res = await request(app).post('/api/v10/oauth2/token').set('Authorization', basic)
      .send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
  });

  it('uses a code once, for its own application, with its own redirect URI', async () => {
    const owner = await makeUser();
    const site = await makeSite(owner);
    const other = await makeSite(owner);
    const person = await makeUser();

    const code = await authorise(person, site);
    expect((await exchange(other, code)).body.error).toBe('invalid_grant');
    // The failed try used it up.
    expect((await exchange(site, code)).body.error).toBe('invalid_grant');

    const second = await authorise(person, site);
    expect((await exchange(site, second, { redirect_uri: 'https://games.example/other' })).body.error).toBe('invalid_grant');

    const third = await authorise(person, site);
    expect((await exchange(site, third)).status).toBe(200);
    expect((await exchange(site, third)).body.error).toBe('invalid_grant');
  });

  it('refuses a wrong secret, unknown grants and missing fields', async () => {
    const owner = await makeUser();
    const site = await makeSite(owner);
    const code = await authorise(owner, site);
    const wrong = await exchange({ ...site, secret: 'nope' }, code);
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('invalid_client');
    expect((await token({ client_id: String(site.id), client_secret: site.secret, grant_type: 'password' })).body.error).toBe('unsupported_grant_type');
    expect((await token({ client_id: String(site.id), client_secret: site.secret, grant_type: 'authorization_code' })).body.error).toBe('invalid_request');
    // Without a client secret made, nothing works.
    const bare = (await api.post(owner, '/applications', { name: 'No Secret' })).body;
    expect((await token({ client_id: String(bare.id), client_secret: '', grant_type: 'authorization_code', code })).status).toBe(401);
  });

  it('refreshes (the old pair stops working) and revokes', async () => {
    const owner = await makeUser();
    const site = await makeSite(owner);
    const first = (await exchange(site, await authorise(owner, site))).body;

    const refreshed = await token({ client_id: String(site.id), client_secret: site.secret, grant_type: 'refresh_token', refresh_token: first.refresh_token });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).not.toBe(first.access_token);
    expect((await me(first.access_token)).status).toBe(401);
    expect((await me(refreshed.body.access_token)).status).toBe(200);
    // A refresh token works once.
    expect((await token({ client_id: String(site.id), client_secret: site.secret, grant_type: 'refresh_token', refresh_token: first.refresh_token })).body.error).toBe('invalid_grant');

    const revoked = await request(app).post('/api/v10/oauth2/token/revoke').type('form')
      .send({ client_id: String(site.id), client_secret: site.secret, token: refreshed.body.access_token });
    expect(revoked.status).toBe(200);
    expect((await me(refreshed.body.access_token)).status).toBe(401);
  });

  it('expires access tokens after 7 days', async () => {
    const owner = await makeUser();
    const site = await makeSite(owner);
    const { access_token: access } = (await exchange(site, await authorise(owner, site))).body;
    await db.run('UPDATE oauth_tokens SET expires_at = ? WHERE user_id = ?', [Math.floor(Date.now() / 1000) - 1, owner.id]);
    expect((await me(access)).status).toBe(401);
  });

  it('never sends anyone to an unregistered address', async () => {
    const owner = await makeUser();
    const site = await makeSite(owner);
    const bad = await api.get(owner, '/oauth2/authorize', link(site, { redirect_uri: 'https://evil.example/' }));
    expect(bad.status).toBe(400);
    expect(bad.body.redirect).toBeUndefined();
    expect((await api.post(owner, '/oauth2/authorize', link(site, { redirect_uri: 'https://evil.example/' }))).status).toBe(400);
    // The only one is used when the link leaves it out.
    const only = await api.get(owner, '/oauth2/authorize', link(site, { redirect_uri: undefined }));
    expect(only.body.redirect_uri).toBe(REDIRECT);

    // A bad scope or response_type goes back to the site with an error.
    const scope = await api.get(owner, '/oauth2/authorize', link(site, { scope: 'identify email' }));
    expect(scope.status).toBe(400);
    expect(new URL(scope.body.redirect).searchParams.get('error')).toBe('invalid_scope');
    const type = await api.get(owner, '/oauth2/authorize', link(site, { response_type: 'token' }));
    expect(new URL(type.body.redirect).searchParams.get('error')).toBe('unsupported_response_type');
  });

  it('sends a refusal back as access_denied', async () => {
    const owner = await makeUser();
    const site = await makeSite(owner);
    const res = await api.post(owner, '/oauth2/authorize', { ...link(site), deny: true });
    const back = new URL(res.body.location);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('code')).toBeNull();
    expect(back.searchParams.get('state')).toBe('xyz');
  });

  it('checks redirect URIs in the portal', async () => {
    const owner = await makeUser();
    const { body: created } = await api.post(owner, '/applications', { name: 'Uris' });
    for (const uri of ['http://games.example/cb', 'https://games.example/cb#frag', 'not a url', 'javascript:alert(1)']) {
      expect((await api.patch(owner, `/applications/${created.id}`, { redirect_uris: [uri] })).status).toBe(400);
    }
    const ok = await api.patch(owner, `/applications/${created.id}`, { redirect_uris: ['http://localhost:8337/callback', 'https://a.example/cb?x=1'] });
    expect(ok.status).toBe(200);
    expect(ok.body.redirect_uris).toEqual(['http://localhost:8337/callback', 'https://a.example/cb?x=1']);
    const many = Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`);
    expect((await api.patch(owner, `/applications/${created.id}`, { redirect_uris: many })).status).toBe(400);
  });

  it("lists authorised apps, and removing one ends its tokens", async () => {
    const owner = await makeUser();
    const site = await makeSite(owner);
    const person = await makeUser();
    const { access_token: access } = (await exchange(site, await authorise(person, site))).body;

    const list = await api.get(person, '/oauth2/authorised-apps');
    expect(list.body).toEqual([expect.objectContaining({ id: site.id, name: 'Games Site', scopes: ['identify'] })]);

    expect((await api.delete(person, `/oauth2/authorised-apps/${site.id}`)).status).toBe(200);
    expect((await me(access)).status).toBe(401);
    expect((await api.get(person, '/oauth2/authorised-apps')).body).toEqual([]);
  });

  it("stops working when the application or the person's account goes", async () => {
    const owner = await makeUser();
    const site = await makeSite(owner);
    const person = await makeUser();
    const { access_token: access } = (await exchange(site, await authorise(person, site))).body;
    await db.run('UPDATE users SET suspended_at = 1 WHERE id = ?', [person.id]);
    expect((await me(access)).status).toBe(401);
    await db.run('UPDATE users SET suspended_at = NULL WHERE id = ?', [person.id]);
    expect((await me(access)).status).toBe(200);

    expect((await api.delete(owner, `/applications/${site.id}`)).status).toBe(200);
    expect((await me(access)).status).toBe(401);
    expect(await db.get('SELECT 1 FROM oauth_tokens WHERE application_id = ?', [site.id])).toBeUndefined();
  });

  it("only opens users/@me and oauth2/@me to a login token", async () => {
    const owner = await makeUser();
    const site = await makeSite(owner);
    const { access_token: access } = (await exchange(site, await authorise(owner, site))).body;
    const bearer = { Authorization: `Bearer ${access}` };
    expect((await request(app).get('/api/v10/users/@me/guilds').set(bearer)).status).toBe(401);
    expect((await request(app).get('/api/v10/gateway/bot').set(bearer)).status).toBe(401);
    // A login token isn't a login to the app either.
    expect((await request(app).get('/api/applications').set(bearer)).status).toBe(403);
    // And the bot's token still gets the bot.
    const bot = await request(app).get('/api/v10/users/@me').set('Authorization', `Bot ${site.botToken}`);
    expect(bot.body).toMatchObject({ id: String(site.id), bot: true });
  });

  it('still adds bots with scope=bot links', async () => {
    const owner = await makeUser();
    const site = await makeSite(owner);
    const info = await api.get(owner, '/oauth2/authorize', { client_id: String(site.id), scope: 'bot', permissions: '0' });
    expect(info.status).toBe(200);
    expect(info.body.login).toBeUndefined();
    expect(info.body.guilds).toEqual([]);
  });
});
