import { describe, it, expect } from 'vitest';

const { createApiLogin, apiFromConfig, claimsOf } = require('../apiLogin');

const tokenFor = (claims, signature = 'sig') => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;
const API = apiFromConfig(JSON.stringify({ api: 'https://app.voicaw.com/api/' }));

function setUp(token) {
  const file = { known: token !== undefined, token: token ?? null };
  const store = { get: () => ({ ...file }), set: (value) => { file.known = true; file.token = value; return true; } };
  return { file, apiLogin: createApiLogin({ api: API, store }) };
}

const cookieLine = (value, maxAge = 2592000) => `voicaw_session=${value}; Path=/api; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=None`;

describe('apiFromConfig', () => {
  it("takes the build's https API address, nothing else", () => {
    expect(API).toEqual({ origin: 'https://app.voicaw.com', prefix: 'https://app.voicaw.com/api/' });
    expect(apiFromConfig(JSON.stringify({ api: 'https://x.test/api' })).prefix).toBe('https://x.test/api/');
    expect(apiFromConfig(JSON.stringify({ api: 'http://evil.test/api/' }))).toBeNull();
    expect(apiFromConfig(JSON.stringify({ api: 'http://localhost:3402/api/' })).origin).toBe('http://localhost:3402');
    expect(apiFromConfig(null)).toBeNull();
    expect(apiFromConfig('not json')).toBeNull();
  });
});

describe('the desktop login', () => {
  const login = tokenFor({ id: 1, username: 'a', sid: 'S1', iat: 10 });

  it('tells the page who is logged in, never the token', () => {
    const { apiLogin } = setUp(login);
    expect(apiLogin.pageLogin()).toEqual({ known: true, login: { id: 1, username: 'a', sid: 'S1', iat: 10 } });
    expect(JSON.stringify(apiLogin.pageLogin())).not.toContain(login);
    expect(setUp(undefined).apiLogin.pageLogin()).toEqual({ known: false, login: null });
    expect(claimsOf('junk')).toBeNull();
  });

  it('only matches the built-in API', () => {
    const { apiLogin } = setUp(login);
    expect(apiLogin.urls).toEqual(['https://app.voicaw.com/api/*']);
    expect(apiLogin.matches('https://app.voicaw.com/api/profile')).toBe(true);
    expect(apiLogin.matches('https://app.voicaw.com.evil.test/api/profile')).toBe(false);
    expect(apiLogin.matches('https://other.test/api/profile')).toBe(false);
    expect(createApiLogin({ api: null, store: setUp(login).file }).urls).toEqual([]);
  });

  it('adds the token to requests that name their session, and only those', () => {
    const { apiLogin } = setUp(login);
    const named = apiLogin.requestHeaders({ id: 1, url: 'https://app.voicaw.com/api/profile', requestHeaders: { 'X-Voicaw-Session': 'S1' } });
    expect(named.Authorization).toBe(`Bearer ${login}`);
    const plain = apiLogin.requestHeaders({ id: 2, url: 'https://app.voicaw.com/api/config', requestHeaders: {} });
    expect(plain.Authorization).toBeUndefined();
    const own = apiLogin.requestHeaders({ id: 3, url: 'https://app.voicaw.com/api/x', requestHeaders: { 'x-voicaw-session': 'S1', Authorization: 'Bearer other' } });
    expect(own.Authorization).toBe('Bearer other');
  });

  it('takes a login out of the answer, strips the cookie and keeps the others', () => {
    const { apiLogin, file } = setUp(null);
    const fresh = tokenFor({ id: 2, username: 'b', sid: 'S2', iat: 20 });
    const headers = apiLogin.responseHeaders({ id: 9, responseHeaders: { 'Set-Cookie': [cookieLine(fresh), 'other=1; Path=/'], 'Content-Type': ['application/json'] } });
    expect(file.token).toBe(fresh);
    expect(headers['Set-Cookie']).toEqual(['other=1; Path=/']);
    expect(headers['Content-Type']).toEqual(['application/json']);
    const only = apiLogin.responseHeaders({ id: 10, responseHeaders: { 'set-cookie': [cookieLine(fresh)] } });
    expect(only['set-cookie']).toBeUndefined();
  });

  it("takes a renewal and a logout for the saved session, not an older one's late answers", () => {
    const { apiLogin, file } = setUp(login);
    const renewed = tokenFor({ id: 1, username: 'a', sid: 'S1', iat: 99 });
    apiLogin.requestHeaders({ id: 1, requestHeaders: { 'X-Voicaw-Session': 'S1' } });
    apiLogin.responseHeaders({ id: 1, responseHeaders: { 'Set-Cookie': [cookieLine(renewed)] } });
    expect(file.token).toBe(renewed);

    apiLogin.requestHeaders({ id: 2, requestHeaders: { 'X-Voicaw-Session': 'OLD' } });
    apiLogin.responseHeaders({ id: 2, responseHeaders: { 'Set-Cookie': [cookieLine('', 0)] } });
    expect(file.token).toBe(renewed);

    apiLogin.requestHeaders({ id: 3, requestHeaders: { 'X-Voicaw-Session': 'S1' } });
    apiLogin.responseHeaders({ id: 3, responseHeaders: { 'Set-Cookie': [cookieLine('', 0)] } });
    expect(file.token).toBeNull();
  });

  it('ignores a cookie value that is not a token', () => {
    const { apiLogin, file } = setUp(null);
    apiLogin.responseHeaders({ id: 1, responseHeaders: { 'Set-Cookie': [cookieLine('a b"c')] } });
    expect(file.token).toBeNull();
  });
});
