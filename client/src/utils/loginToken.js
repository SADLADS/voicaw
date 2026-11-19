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

// Whether two tokens are the same login session: a renewed token (a day old, server/auth.js)
// keeps its session id. Tokens from before login sessions have none: only the same token is.
export function sameLogin(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const sid = tokenClaims(a)?.sid;
  return Boolean(sid) && sid === tokenClaims(b)?.sid;
}

// The saved login, read and written only through these. In a browser it's localStorage 'token'.
// The desktop app also keeps it in its own file (electron/loginStore.js), which wins once it
// holds one: on one Windows PC (2026-11-16 to 19) Chromium's storage kept handing the page a
// month-old, expired token of the same account after logging in (deleting its files didn't
// help, and a reload lost the memory below), so every request got "Invalid token". The newest
// token this page saved (logging in, a renewal) is also kept in memory: a saved login never
// rightly becomes an older one of the same account. Another account's, or a newer one (another
// tab logging in), is taken as it is; none means logged out.
let newest = null;

const appStore = () => (typeof window !== 'undefined' ? window.voicawDesktop?.login : null) ?? null;

// The desktop app's copy: a token, null (logged out), or undefined (no desktop app, an older
// one, or it never kept a login: localStorage's is used then).
function keptByApp() {
  try {
    const kept = appStore()?.get();
    return kept?.known ? (kept.token ?? null) : undefined;
  } catch {
    return undefined;
  }
}

function readSaved() {
  const kept = keptByApp();
  if (kept !== undefined) return kept;
  try {
    return localStorage.getItem('token');
  } catch {
    return null;
  }
}

function writeSaved(token) {
  try { appStore()?.set(token); } catch { /* not kept by the app */ }
  try {
    if (token) localStorage.setItem('token', token);
    else localStorage.removeItem('token');
  } catch { /* storage blocked */ }
}

export function savedToken() {
  const saved = readSaved();
  if (!saved || !newest || saved === newest) {
    if (saved) newest = saved;
    return saved;
  }
  const was = tokenClaims(saved);
  const ours = tokenClaims(newest);
  if (was?.id != null && was.id === ours?.id && (was.iat ?? 0) < (ours.iat ?? 0)) {
    console.warn('The saved login went back to an older one: keeping the newer one');
    writeSaved(newest);
    return newest;
  }
  newest = saved;
  return saved;
}

export function saveToken(token) {
  newest = token;
  writeSaved(token);
}

export function forgetToken() {
  newest = null;
  writeSaved(null);
}
