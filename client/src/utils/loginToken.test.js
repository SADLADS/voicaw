import { describe, it, expect, vi, afterEach } from 'vitest';
import { loginHeaders, loginRejected, loginReplaced, sameLogin, sameSaved, tokenClaims } from './loginToken';

describe('loginRejected', () => {
  const failed = (status, data) => ({ response: { status, data } });
  it("is a 401, or a 403/404 that is the API's own error", () => {
    expect(loginRejected(failed(401, '<html>'))).toBe(true);
    expect(loginRejected(failed(403, { error: 'Invalid token' }))).toBe(true);
    expect(loginRejected(failed(404, { error: 'User not found' }))).toBe(true);
  });
  it("isn't a proxy's page, another status or no answer", () => {
    expect(loginRejected(failed(404, '<html>404 Not Found</html>'))).toBe(false);
    expect(loginRejected(failed(403, ''))).toBe(false);
    expect(loginRejected(failed(403, { message: 'blocked' }))).toBe(false);
    expect(loginRejected(failed(502, { error: 'Bad gateway' }))).toBe(false);
    expect(loginRejected(new Error('Network Error'))).toBe(false);
    expect(loginRejected(undefined)).toBe(false);
  });
  it("isn't another login having replaced this one (409 login_changed)", () => {
    const replaced = failed(409, { error: 'Another login replaced this one', code: 'login_changed' });
    expect(loginRejected(replaced)).toBe(false);
    expect(loginReplaced(replaced)).toBe(true);
    expect(loginReplaced(failed(409, { error: 'Username already exists' }))).toBe(false);
  });
});

const tokenFor = (claims, signature = 'sig') => `h.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.${signature}`;
const bearer = (claims, signature) => {
  const token = tokenFor(claims, signature);
  return { ...claims, token };
};

describe('saved logins', () => {
  it('reads the claims, or null', () => {
    expect(tokenClaims(tokenFor({ id: 3, sid: 'abc' }))).toEqual({ id: 3, sid: 'abc' });
    expect(tokenClaims('not a token')).toBeNull();
    expect(tokenClaims(null)).toBeNull();
  });

  it('counts a renewed token as the same login, another session as not', () => {
    expect(sameLogin(bearer({ sid: 'a' }, 'one'), bearer({ sid: 'a' }, 'two'))).toBe(true);
    expect(sameLogin(bearer({ sid: 'a' }), bearer({ sid: 'b' }))).toBe(false);
    // Tokens from before login sessions: only the same token.
    expect(sameLogin(bearer({ id: 1 }, 'one'), bearer({ id: 1 }, 'two'))).toBe(false);
    expect(sameLogin({ sid: 'a' }, { sid: 'a' })).toBe(true);
    expect(sameLogin({ sid: 'a' }, null)).toBe(false);
  });

  it('counts only the very same token, or the same cookie session, as the saved one', () => {
    expect(sameSaved(bearer({ sid: 'a' }, 'one'), bearer({ sid: 'a' }, 'two'))).toBe(false);
    expect(sameSaved(bearer({ sid: 'a' }, 'one'), bearer({ sid: 'a' }, 'one'))).toBe(true);
    expect(sameSaved({ sid: 'a' }, { sid: 'a' })).toBe(true);
    expect(sameSaved({ sid: 'a' }, bearer({ sid: 'a' }))).toBe(false);
  });

  it('sends a token as Bearer, a cookie login by naming its session', () => {
    const login = bearer({ sid: 'a' });
    expect(loginHeaders(login)).toEqual({ Authorization: `Bearer ${login.token}` });
    expect(loginHeaders({ sid: 'a' })).toEqual({ 'X-Voicaw-Session': 'a' });
    expect(loginHeaders(null)).toEqual({});
  });
});

describe('the saved login', () => {
  // A fresh copy of the module (its memory) over an empty localStorage. `builtIn` false: logged
  // in to another server (the login screen's Server).
  async function fresh({ builtIn = true, androidApp = false } = {}) {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
    vi.resetModules();
    vi.doMock('./server', () => ({ isBuiltInServer: () => builtIn }));
    vi.doMock('./android', () => ({ isAndroidApp: () => androidApp }));
    return { store, ...(await import('./loginToken')) };
  }
  afterEach(() => {
    vi.doUnmock('./server');
    vi.doUnmock('./android');
  });

  const old = { id: 1, username: 'a', sid: 'old', iat: 100 };
  const login = { id: 1, username: 'a', sid: 'new', iat: 200 };
  const stored = (store) => JSON.parse(store.get('login') ?? 'null');

  it('keeps a cookie login as what it says, never a token', async () => {
    const { store, saveLogin, savedLogin } = await fresh();
    saveLogin({ login });
    expect(stored(store)).toEqual(login);
    expect(store.has('token')).toBe(false);
    expect(savedLogin()).toEqual(login);
  });

  // The Android app's WebView never sends the API's cross-site cookie: it keeps a token.
  it('keeps a token in the Android app, never the cookie', async () => {
    const { store, cookieMode, saveLogin, savedLogin } = await fresh({ androidApp: true });
    expect(cookieMode()).toBe(false);
    const token = `x.${btoa(JSON.stringify({ id: 1, username: 'a', sid: 'S', iat: 5 }))}.y`;
    saveLogin({ token });
    expect(store.get('token')).toBe(token);
    expect(store.has('login')).toBe(false);
    expect(savedLogin()).toMatchObject({ id: 1, sid: 'S', token });
  });

  it('in the Android app, a cookie login saved by 1.3.1 to 1.3.3 counts as logged out', async () => {
    const { store, savedLogin } = await fresh({ androidApp: true });
    store.set('login', JSON.stringify(login));
    expect(savedLogin()).toBe(null);
  });

  it('keeps the newer login when storage goes back to an older one of the same account', async () => {
    const { store, saveLogin, savedLogin } = await fresh();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    saveLogin({ login });
    store.set('login', JSON.stringify(old)); // the storage reverting on its own
    expect(savedLogin()).toEqual(login);
    expect(stored(store)).toEqual(login);
  });

  it("takes another account's login, a newer one, and none (logged out) as they are", async () => {
    const { store, saveLogin, savedLogin } = await fresh();
    saveLogin({ login });
    const other = { id: 2, username: 'b', sid: 'x', iat: 50 };
    store.set('login', JSON.stringify(other));
    expect(savedLogin()).toEqual(other);
    const newer = { id: 2, username: 'b', sid: 'y', iat: 300 };
    store.set('login', JSON.stringify(newer));
    expect(savedLogin()).toEqual(newer);
    store.delete('login');
    expect(savedLogin()).toBeNull();
  });

  it('forgets it on logout, so an older one coming back is not replaced by it', async () => {
    const { store, saveLogin, savedLogin, forgetSavedLogin } = await fresh();
    saveLogin({ login });
    forgetSavedLogin();
    expect(store.has('login')).toBe(false);
    store.set('login', JSON.stringify(old));
    expect(savedLogin()).toEqual(old);
  });

  it('still reads a token saved before the cookie (until it is moved), and another server keeps tokens', async () => {
    const token = tokenFor({ id: 1, username: 'a', sid: 's', iat: 5 });
    let page = await fresh();
    page.store.set('token', token);
    expect(page.savedLogin()).toEqual({ id: 1, username: 'a', sid: 's', iat: 5, token });
    page.saveLogin({ login });
    expect(page.store.has('token')).toBe(false);

    page = await fresh({ builtIn: false });
    page.saveLogin({ token });
    expect(page.store.get('token')).toBe(token);
    // A cookie login is only for the built-in server.
    page.store.set('login', JSON.stringify(login));
    expect(page.savedLogin().token).toBe(token);
  });

  describe('in the desktop app, whose main process keeps the token', () => {
    // The app's file (electron/loginStore.js): a token, null for logged out, undefined for never.
    function desktop(token) {
      const app = { token };
      globalThis.window = {
        voicawDesktop: {
          login: {
            get: () => ({ known: app.token !== undefined, login: app.token ? tokenClaims(app.token) : null }),
            set: (value) => { app.token = value; return true; },
          },
        },
      };
      return app;
    }
    afterEach(() => { delete globalThis.window; });

    const kept = tokenFor({ id: 1, username: 'a', sid: 'new', iat: 200 });

    it("uses the app's copy, whatever localStorage went back to", async () => {
      const app = desktop(kept);
      const page = await fresh();
      page.store.set('login', JSON.stringify(old));
      expect(page.savedLogin()).toEqual(login);
      page.saveLogin({ login });
      // The token stays the app's own (it took it from the server's answer).
      expect(app.token).toBe(kept);
    });

    it('hands the app a token an older version kept in localStorage, and forgets it there', async () => {
      const app = desktop(undefined);
      const page = await fresh();
      page.store.set('token', kept);
      expect(page.savedLogin()).toEqual(login);
      expect(app.token).toBe(kept);
      expect(page.store.has('token')).toBe(false);
    });

    it('stays logged out after a logout, even if localStorage brings a login back', async () => {
      const app = desktop(kept);
      let page = await fresh();
      page.forgetSavedLogin();
      expect(app.token).toBeNull();
      page = await fresh();
      page.store.set('login', JSON.stringify(old));
      expect(page.savedLogin()).toBeNull();
    });

    it('falls back to localStorage when the app can’t answer', async () => {
      globalThis.window = { voicawDesktop: { login: { get: () => { throw new Error('gone'); }, set: () => { throw new Error('gone'); } } } };
      const { savedLogin, saveLogin } = await fresh();
      saveLogin({ login });
      expect(savedLogin()).toEqual(login);
    });
  });
});
