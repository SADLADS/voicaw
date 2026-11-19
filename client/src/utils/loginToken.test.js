import { describe, it, expect, vi, afterEach } from 'vitest';
import { loginRejected, sameLogin, tokenClaims } from './loginToken';

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
});

const tokenFor = (claims, signature = 'sig') => `h.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.${signature}`;

describe('login tokens', () => {
  it('reads the claims, or null', () => {
    expect(tokenClaims(tokenFor({ id: 3, sid: 'abc' }))).toEqual({ id: 3, sid: 'abc' });
    expect(tokenClaims('not a token')).toBeNull();
    expect(tokenClaims(null)).toBeNull();
  });

  it('counts a renewed token as the same login, another session as not', () => {
    expect(sameLogin(tokenFor({ sid: 'a' }, 'one'), tokenFor({ sid: 'a' }, 'two'))).toBe(true);
    expect(sameLogin(tokenFor({ sid: 'a' }), tokenFor({ sid: 'b' }))).toBe(false);
    // Tokens from before login sessions: only the same token.
    expect(sameLogin(tokenFor({ id: 1 }, 'one'), tokenFor({ id: 1 }, 'two'))).toBe(false);
    expect(sameLogin('x', 'x')).toBe(true);
    expect(sameLogin('x', null)).toBe(false);
  });
});

describe('the saved login', () => {
  // A fresh copy of the module (its memory) over an empty localStorage.
  async function fresh() {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
    vi.resetModules();
    return { store, ...(await import('./loginToken')) };
  }
  const old = tokenFor({ id: 1, sid: 'old', iat: 100 });
  const login = tokenFor({ id: 1, sid: 'new', iat: 200 });

  it('keeps the newer login when storage goes back to an older one of the same account', async () => {
    const { store, saveToken, savedToken } = await fresh();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    saveToken(login);
    store.set('token', old); // the storage reverting on its own
    expect(savedToken()).toBe(login);
    expect(store.get('token')).toBe(login);
  });

  it("takes another account's login, a newer one, and none (logged out) as they are", async () => {
    const { store, saveToken, savedToken } = await fresh();
    saveToken(login);
    const other = tokenFor({ id: 2, sid: 'x', iat: 50 });
    store.set('token', other);
    expect(savedToken()).toBe(other);
    const newer = tokenFor({ id: 2, sid: 'y', iat: 300 });
    store.set('token', newer);
    expect(savedToken()).toBe(newer);
    store.delete('token');
    expect(savedToken()).toBeNull();
  });

  it('forgets it on logout, so an older one coming back is not replaced by it', async () => {
    const { store, saveToken, savedToken, forgetToken } = await fresh();
    saveToken(login);
    forgetToken();
    expect(store.has('token')).toBe(false);
    store.set('token', old);
    expect(savedToken()).toBe(old);
  });

  describe("in the desktop app, which keeps its own copy", () => {
    // The app's file (electron/loginStore.js), or null for none saved yet.
    function desktop(file = null) {
      const app = { file };
      globalThis.window = {
        voicawDesktop: {
          login: {
            get: () => ({ known: app.file !== null, token: app.file?.token ?? null }),
            set: (token) => { app.file = { token }; return true; },
          },
        },
      };
      return app;
    }
    afterEach(() => { delete globalThis.window; });

    it("uses the app's copy after a reload, whatever localStorage went back to", async () => {
      const app = desktop();
      let page = await fresh();
      page.saveToken(login);
      expect(app.file.token).toBe(login);
      page = await fresh(); // a reload: the page's memory is gone, and storage has the old one
      page.store.set('token', old);
      expect(page.savedToken()).toBe(login);
    });

    it("reads localStorage until the app has kept a login, then saves there too", async () => {
      const app = desktop();
      const { store, savedToken, saveToken } = await fresh();
      store.set('token', old);
      expect(savedToken()).toBe(old);
      saveToken(login);
      expect(app.file.token).toBe(login);
      expect(store.get('token')).toBe(login);
    });

    it('stays logged out after a logout, even if localStorage brings a token back', async () => {
      const app = desktop({ token: login });
      let page = await fresh();
      page.forgetToken();
      expect(app.file.token).toBeNull();
      page = await fresh();
      page.store.set('token', old);
      expect(page.savedToken()).toBeNull();
    });

    it('falls back to localStorage when the app can’t answer', async () => {
      globalThis.window = { voicawDesktop: { login: { get: () => { throw new Error('gone'); }, set: () => { throw new Error('gone'); } } } };
      const { store, savedToken, saveToken } = await fresh();
      saveToken(login);
      expect(store.get('token')).toBe(login);
      expect(savedToken()).toBe(login);
    });
  });
});
