import { isBuiltInServer } from './server';
import { isAndroidApp } from './android';

// What a login token ("<JWT>", server/auth.js) says: { id, username, sid }, or null. Only read,
// never trusted: the server checks it.
export function tokenClaims(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

// The saved login (security audit follow-up, 2026-11-20). On the built-in server it's an
// HttpOnly cookie the page can't read (server/auth.js), and the page keeps only what it says:
// `{ id, username, sid, iat }`, no secret (without the cookie none of it logs anyone in). Every
// request names that session (`X-Voicaw-Session`), which is what makes the cookie count. The
// desktop app's main process keeps the token itself (electron/apiLogin.js) and hands the page
// the same `{ id, username, sid, iat }`. Logged in to another server (the login screen's
// Server: cross-site, where browsers block cookies) the page keeps a Bearer token as before:
// `{ id, username, sid, iat, token }`.
//
// The Android app keeps a Bearer token too (since 2026-11-23): its WebView never sends the API's
// cookie, which is cross-site to its page (https://localhost), whatever it's told
// (setAcceptThirdPartyCookies, before or after the page loads; the API's access log showed a
// cookie set by /session-cookie missing from /profile a second later). The cookie had it logging
// out at every start from android-v1.3.1 to 1.3.3.
//
// Whether this app keeps its login in the cookie: on the built-in server, outside the Android app.
export const cookieMode = () => isBuiltInServer() && !isAndroidApp();

const loginFromToken = (token) => {
  const claims = tokenClaims(token);
  return { id: claims?.id ?? null, username: claims?.username ?? null, sid: claims?.sid ?? null, iat: claims?.iat ?? null, token };
};

function cleanLogin(value) {
  if (!value || typeof value !== 'object' || typeof value.sid !== 'string' || !value.sid) return null;
  return { id: value.id ?? null, username: value.username ?? null, sid: value.sid, iat: Number(value.iat) || 0 };
}

// What to send a request with: the token, or the session's name (the cookie goes by itself).
export function loginHeaders(login) {
  if (!login) return {};
  if (login.token) return { Authorization: `Bearer ${login.token}` };
  return { 'X-Voicaw-Session': login.sid };
}

// Whether two saved logins are the same login session: a renewed token (a day old,
// server/auth.js) keeps its session id. Tokens from before login sessions have none: only the
// same token is.
export function sameLogin(a, b) {
  if (!a || !b) return false;
  if (a.token && a.token === b.token) return true;
  return Boolean(a.sid) && a.sid === b.sid;
}

// Whether `a` is exactly the login saved as `b`: a token renewed since counts as another one.
export function sameSaved(a, b) {
  if (!a || !b) return false;
  if (a.token || b.token) return a.token === b.token;
  return a.sid === b.sid;
}

// Read and written only through these. In a browser localStorage's 'login' (cookie mode) or
// 'token' (another server, or saved by an older app and not yet moved into the cookie). The
// desktop app's copy (electron/loginStore.js) wins in cookie mode once it holds one: on one
// Windows PC (2026-11-16 to 19) Chromium's storage kept handing the page a month-old, expired
// login of the same account (deleting its files didn't help, and a reload lost the memory below).
// The newest login this page saved (logging in, a renewal) is also kept in memory: a saved login
// never rightly becomes an older one of the same account. Another account's, or a newer one
// (another tab logging in), is taken as it is; none means logged out.
let newest = null;

const appStore = () => (typeof window !== 'undefined' ? window.voicawDesktop?.login : null) ?? null;

// The desktop app's copy: a login, null (logged out), or undefined (no desktop app, not cookie
// mode, or it never kept a login: localStorage's is used then).
function keptByApp() {
  if (!cookieMode()) return undefined;
  try {
    const kept = appStore()?.get();
    if (!kept?.known) return undefined;
    return cleanLogin(kept.login);
  } catch {
    return undefined;
  }
}

function fromStorage() {
  try {
    if (cookieMode()) {
      const login = cleanLogin(JSON.parse(localStorage.getItem('login') ?? 'null'));
      if (login) return login;
    }
    const token = localStorage.getItem('token');
    return token ? loginFromToken(token) : null;
  } catch {
    return null;
  }
}

function readSaved() {
  const kept = keptByApp();
  if (kept !== undefined) return kept;
  const stored = fromStorage();
  // The desktop app's main process takes over a token an older version kept in localStorage.
  if (stored?.token && cookieMode() && appStore()) {
    try {
      if (appStore().set(stored.token)) {
        localStorage.removeItem('token');
        return keptByApp() ?? null;
      }
    } catch { /* kept as it was */ }
  }
  return stored;
}

function writeSaved(login) {
  try {
    if (cookieMode() && appStore()) {
      // The main process saved the login itself from the server's answer; only logging out
      // (or a token from before the cookie, being moved) is said to it.
      if (!login) appStore().set(null);
      else if (login.token) appStore().set(login.token);
    }
  } catch { /* not kept by the app */ }
  try {
    if (!login) {
      localStorage.removeItem('token');
      localStorage.removeItem('login');
    } else if (login.token) {
      localStorage.setItem('token', login.token);
      localStorage.removeItem('login');
    } else {
      localStorage.setItem('login', JSON.stringify(cleanLogin(login)));
      localStorage.removeItem('token');
    }
  } catch { /* storage blocked */ }
}

export function savedLogin() {
  const saved = readSaved();
  if (!saved || !newest || sameSaved(saved, newest)) {
    if (saved) newest = saved;
    return saved;
  }
  if (saved.id != null && saved.id === newest.id && (saved.iat ?? 0) < (newest.iat ?? 0)) {
    console.warn('The saved login went back to an older one: keeping the newer one');
    writeSaved(newest);
    return newest;
  }
  newest = saved;
  return saved;
}

// Keeps what a login answered: `{ token }` (another server, or a renewal) or `{ login }`
// (cookie mode).
export function saveLogin(answer) {
  const login = answer?.token ? loginFromToken(answer.token) : cleanLogin(answer?.login);
  if (!login) return null;
  newest = login;
  writeSaved(login);
  return login;
}

export function forgetSavedLogin() {
  newest = null;
  writeSaved(null);
}

// Whether a failed request means the server refused this login, so the device should forget
// it: a 401, or a 403/404 that is the API's own JSON error (server/auth.js answers a revoked or
// unknown token with 403 "Invalid token", GET /profile a deleted account with 404). A 403 or
// 404 page from a proxy in front of the server (one being redeployed, a firewall), which isn't
// JSON, counts as out of reach: forgetting the login also wipes this device's keys and its
// offline copy (security audit, 2026-11-19). A 409 `login_changed` (another login replaced this
// page's, loginReplaced below) is not.
export function loginRejected(err) {
  const status = err?.response?.status;
  if (status === 401) return true;
  if (status !== 403 && status !== 404) return false;
  const data = err.response.data;
  return Boolean(data) && typeof data === 'object' && typeof data.error === 'string';
}

// The server says this page's login isn't the one the device has now (another tab logged out
// and in again): the page reloads with the new one (App).
export const loginReplaced = (err) => err?.response?.status === 409 && err.response.data?.code === 'login_changed';

const replacedListeners = new Set();

export function onLoginReplaced(callback) {
  replacedListeners.add(callback);
  return () => replacedListeners.delete(callback);
}

export function announceLoginReplaced() {
  replacedListeners.forEach((cb) => cb());
}
