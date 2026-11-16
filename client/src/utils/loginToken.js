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

// The saved login (localStorage 'token'), read and written only through these. The newest token
// this page saved (logging in, a renewal) is also kept in memory: a desktop app's storage was
// seen going back on its own to a month-old token of the same account (2026-11-16; expired, so
// every request got "Invalid token" until it logged out), and a saved login never rightly
// becomes an older one of the same account. Another account's, or a newer one (another tab
// logging in), is taken as it is; none means logged out.
let newest = null;

function readSaved() {
  try {
    return localStorage.getItem('token');
  } catch {
    return null;
  }
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
    try { localStorage.setItem('token', newest); } catch { /* storage blocked */ }
    return newest;
  }
  newest = saved;
  return saved;
}

export function saveToken(token) {
  newest = token;
  try { localStorage.setItem('token', token); } catch { /* storage blocked */ }
}

export function forgetToken() {
  newest = null;
  try { localStorage.removeItem('token'); } catch { /* storage blocked */ }
}
