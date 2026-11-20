import './helpers/mockS3.js';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { registerUser, loginUser } from './helpers/authFlow.js';

const app = require('../index.js');
const { SESSION_SECONDS, RENEW_AFTER_SECONDS, issueSocketTicket, redeemSocketTicket } = require('../auth');

const now = () => Math.floor(Date.now() / 1000);

// The login cookie's value from a response's Set-Cookie, or undefined ('' when it's cleared).
function sessionCookie(res) {
  const line = (res.headers['set-cookie'] ?? []).find((l) => l.startsWith('voicaw_session='));
  return line === undefined ? undefined : line.split(';')[0].slice('voicaw_session='.length);
}

// A user logged in the web app's way: { cookie, login, as(req) } where as() sends a request with
// the cookie and the session's header, as the page does.
async function cookieLogin(name) {
  await registerUser(app, request, name, 'pw');
  const { response } = await loginUser(app, request, name, 'pw', { cookie: true });
  const cookie = sessionCookie(response);
  const { login } = response.body;
  return { response, cookie, login, as: (req, sid = login.sid) => req.set('Cookie', `voicaw_session=${cookie}`).set('X-Voicaw-Session', sid) };
}

describe('login cookie', () => {
  it('a cookie login gets an HttpOnly cookie and no token', async () => {
    const { response, cookie, login } = await cookieLogin('cookie-login');
    expect(response.status).toBe(200);
    expect(response.body.token).toBeUndefined();
    expect(cookie).toBeTruthy();
    const line = response.headers['set-cookie'].find((l) => l.startsWith('voicaw_session='));
    expect(line).toMatch(/HttpOnly/);
    expect(line).toMatch(/Secure/);
    expect(line).toMatch(/SameSite=None/);
    expect(line).toMatch(/Path=\/api/);
    expect(line).toMatch(new RegExp(`Max-Age=${SESSION_SECONDS}`));
    expect(login).toEqual({ id: response.body.id, username: 'cookie-login', sid: jwt.decode(cookie).sid, iat: jwt.decode(cookie).iat });
  });

  it('a login without the header still gets a token (older apps, other servers)', async () => {
    await registerUser(app, request, 'cookie-bearer', 'pw');
    const { response } = await loginUser(app, request, 'cookie-bearer', 'pw');
    expect(response.body.token).toBeTruthy();
    expect(sessionCookie(response)).toBeUndefined();
  });

  it('requests with the cookie and the session header work, and the profile has no token', async () => {
    const user = await cookieLogin('cookie-profile');
    const res = await user.as(request(app).get('/api/profile'));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(user.login.id);
    expect(res.body.token).toBeUndefined();
  });

  it('the cookie alone logs nobody in (another site\'s form or link)', async () => {
    const user = await cookieLogin('cookie-csrf');
    const res = await request(app).post('/api/logout').set('Cookie', `voicaw_session=${user.cookie}`);
    expect(res.status).toBe(401);
    expect((await user.as(request(app).get('/api/profile'))).status).toBe(200);
  });

  it('the header without the cookie is not logged in (401 no_session)', async () => {
    const user = await cookieLogin('cookie-none');
    const res = await request(app).get('/api/profile').set('X-Voicaw-Session', user.login.sid);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('no_session');
  });

  it('a page naming an older session is told another login replaced it (409, not a logout)', async () => {
    const user = await cookieLogin('cookie-replaced');
    const res = await user.as(request(app).get('/api/profile'), 'some-older-session');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('login_changed');
    expect((await user.as(request(app).get('/api/profile'))).status).toBe(200);
  });

  it('a cookie over a day old is renewed as a cookie, never as a token header', async () => {
    const user = await cookieLogin('cookie-renew');
    const claims = jwt.decode(user.cookie);
    const old = jwt.sign({ id: claims.id, username: claims.username, sid: claims.sid, iat: now() - RENEW_AFTER_SECONDS - 60 }, process.env.JWT_SECRET, { expiresIn: SESSION_SECONDS });
    const res = await request(app).get('/api/profile').set('Cookie', `voicaw_session=${old}`).set('X-Voicaw-Session', claims.sid);
    expect(res.status).toBe(200);
    expect(res.headers['x-voicaw-token']).toBeUndefined();
    const renewed = sessionCookie(res);
    expect(renewed).toBeTruthy();
    expect(jwt.decode(renewed).sid).toBe(claims.sid);
  });

  it('a Bearer request naming its session (the desktop app) is renewed as a cookie too', async () => {
    const user = await cookieLogin('cookie-desktop');
    const claims = jwt.decode(user.cookie);
    const old = jwt.sign({ id: claims.id, username: claims.username, sid: claims.sid, iat: now() - RENEW_AFTER_SECONDS - 60 }, process.env.JWT_SECRET, { expiresIn: SESSION_SECONDS });
    const res = await request(app).get('/api/profile').set('Authorization', `Bearer ${old}`).set('X-Voicaw-Session', claims.sid);
    expect(res.status).toBe(200);
    expect(res.body.token).toBeUndefined();
    expect(res.headers['x-voicaw-token']).toBeUndefined();
    expect(sessionCookie(res)).toBeTruthy();
    const wrong = await request(app).get('/api/profile').set('Authorization', `Bearer ${user.cookie}`).set('X-Voicaw-Session', 'not-this-one');
    expect(wrong.status).toBe(409);
  });

  it('logging out ends the session and clears the cookie', async () => {
    const user = await cookieLogin('cookie-logout');
    const res = await user.as(request(app).post('/api/logout'));
    expect(res.status).toBe(200);
    expect(sessionCookie(res)).toBe('');
    const after = await user.as(request(app).get('/api/profile'));
    expect(after.status).toBe(403);
    expect(sessionCookie(after)).toBe('');
  });

  it('a Bearer login moves into the cookie, the same session', async () => {
    await registerUser(app, request, 'cookie-move', 'pw');
    const { token } = (await loginUser(app, request, 'cookie-move', 'pw')).response.body;
    const res = await request(app).post('/api/session-cookie').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(sessionCookie(res)).toBe(token);
    expect(res.body.login.sid).toBe(jwt.decode(token).sid);
    expect(res.body.token).toBeUndefined();
    const again = await request(app).post('/api/session-cookie').set('Cookie', `voicaw_session=${token}`).set('X-Voicaw-Session', res.body.login.sid);
    expect(again.status).toBe(400);
  });

  it('socket tickets work once, for the login that asked', async () => {
    const user = await cookieLogin('cookie-ticket');
    const res = await user.as(request(app).post('/api/socket-ticket'));
    expect(res.status).toBe(200);
    expect(typeof res.body.ticket).toBe('string');
    expect(res.body.token).toBeUndefined();
    expect(redeemSocketTicket(res.body.ticket)).toBe(user.cookie);
    expect(redeemSocketTicket(res.body.ticket)).toBeNull();
    expect(redeemSocketTicket('made-up')).toBeNull();
    expect(redeemSocketTicket({})).toBeNull();
    expect((await request(app).post('/api/socket-ticket')).status).toBe(401);
  });

  it('a ticket expires after a minute', async () => {
    const ticket = issueSocketTicket('t');
    const realNow = Date.now;
    Date.now = () => realNow() + 61 * 1000;
    try {
      expect(redeemSocketTicket(ticket)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});
