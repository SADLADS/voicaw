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
