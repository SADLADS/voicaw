const crypto = require('crypto');
const db = require('./db');

// Login with Voicaw (docs/bots.md): Discord's OAuth2 authorisation code grant, so a website
// that logs people in with Discord works with Voicaw by changing its URLs. An application (the
// same ones that have bots, bots.js) gets a client secret and the redirect URIs it may use in
// the developer portal. Someone opens the app's /oauth2/authorize page with the site's link,
// agrees, and is sent back with a code; the site trades it (with its secret) for an access
// token at /api/v10/oauth2/token and calls GET /api/v10/users/@me with `Bearer <token>`.
// - The only scope is `identify`: the person's id, username, display name and picture. Nothing
//   about their chats, guilds or keys; the token works for nothing else.
// - Codes, secrets and tokens are stored as SHA-256s only. A code lasts 10 minutes and works
//   once; an access token 7 days; a refresh token until it's used (a new pair replaces it),
//   revoked, or 30 days after its access token ran out.
// - People see and remove the sites they've let in under Settings → Authorised apps.

const SCOPES = ['identify'];
const CODE_SECONDS = 10 * 60;
const ACCESS_SECONDS = 7 * 24 * 60 * 60; // Discord's
const REFRESH_GRACE_SECONDS = 30 * 24 * 60 * 60;
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2048;

const now = () => Math.floor(Date.now() / 1000);
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const random = () => crypto.randomBytes(24).toString('base64url');

class OAuthError extends Error {
  // `error` is RFC 6749's code (invalid_request, invalid_client, invalid_grant, ...).
  constructor(status, error, description) {
    super(description);
    this.status = status;
    this.error = error;
  }
}

// ---- Scopes ----

// "identify bot" (spaces, or "+" and "%20" already decoded) -> ['identify', 'bot'], in order,
// without repeats.
function parseScopes(value) {
  if (typeof value !== 'string') return [];
  return [...new Set(value.split(/[\s+]+/).filter(Boolean))];
}

// The scopes a login may ask for, or an OAuthError.
function checkScopes(scopes) {
  if (!scopes.length) throw new OAuthError(400, 'invalid_scope', 'No scope was asked for');
  const unknown = scopes.filter((s) => !SCOPES.includes(s));
  if (unknown.length) throw new OAuthError(400, 'invalid_scope', `Unknown or unsupported scope: ${unknown.join(' ')}`);
  return scopes;
}

// ---- Redirect URIs ----

// A redirect URI an application may register: https (or http to this computer, for testing),
// no fragment, no user name or password. Returns it as given, or null.
function cleanRedirectUri(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > MAX_REDIRECT_URI_LENGTH) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.hash || url.username || url.password) return null;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  return text;
}

// The list for `bot_applications.redirect_uris`, or an error message.
function cleanRedirectUris(values) {
  if (!Array.isArray(values)) return { error: 'Redirect URIs must be a list' };
  const list = [];
  for (const value of values) {
    const uri = cleanRedirectUri(value);
    if (!uri) return { error: `Not a usable redirect URI: ${String(value).slice(0, 100)}` };
    if (!list.includes(uri)) list.push(uri);
  }
  if (list.length > MAX_REDIRECT_URIS) return { error: `Up to ${MAX_REDIRECT_URIS} redirect URIs` };
  return { list };
}

function redirectUrisOf(app) {
  try {
    const list = JSON.parse(app.redirect_uris ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// The redirect URI a request names, which must be one of the application's exactly; it may be
// left out when the application has only one. Throws (never redirects to an address that isn't
// registered).
function redirectUriFor(app, given) {
  const registered = redirectUrisOf(app);
  if (given == null || given === '') {
    if (registered.length === 1) return registered[0];
    throw new OAuthError(400, 'invalid_request', 'redirect_uri is missing');
  }
  if (!registered.includes(given)) throw new OAuthError(400, 'invalid_request', 'Invalid "redirect_uri" in request.');
  return given;
}

// `uri` with `params` added to its query (keeping what it had).
function withParams(uri, params) {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) if (value != null && value !== '') url.searchParams.set(key, value);
  return url.toString();
}

// ---- Client secrets ----

// A new secret for application `id` (the old one stops working). Returns it: it's never stored.
async function resetClientSecret(id) {
  const secret = crypto.randomBytes(24).toString('base64url');
  await db.run('UPDATE bot_applications SET client_secret_hash = ?, client_secret_reset_at = ? WHERE id = ?', [hash(secret), now(), id]);
  return secret;
}

// The application a token request authenticates as: client_id and client_secret in the body,
// or HTTP Basic (both are in RFC 6749 and Discord takes both). Throws invalid_client.
async function clientFor(req) {
  let id = req.body?.client_id;
  let secret = req.body?.client_secret;
  const basic = /^Basic\s+(.+)$/i.exec(req.get('authorization') ?? '');
  if (basic) {
    const decoded = Buffer.from(basic[1], 'base64').toString();
    const colon = decoded.indexOf(':');
    if (colon > 0) {
      id = decodeURIComponent(decoded.slice(0, colon));
      secret = decodeURIComponent(decoded.slice(colon + 1));
    }
  }
  const appId = Number(id);
  const app = Number.isSafeInteger(appId) && appId > 0 && await db.get('SELECT * FROM bot_applications WHERE id = ?', [appId]);
  if (!app?.client_secret_hash || typeof secret !== 'string') throw new OAuthError(401, 'invalid_client', 'Invalid client');
  const a = Buffer.from(app.client_secret_hash, 'hex');
  const b = Buffer.from(hash(secret), 'hex');
  if (!crypto.timingSafeEqual(a, b)) throw new OAuthError(401, 'invalid_client', 'Invalid client');
  return app;
}

// ---- Authorising ----

// Whether `userId` already let application `appId` in with all of `scopes` (a token that still
// works or can be refreshed), so a link with prompt=none needn't ask again, as in Discord.
async function hasAuthorised(appId, userId, scopes) {
  const rows = await db.all(
    'SELECT scopes FROM oauth_tokens WHERE application_id = ? AND user_id = ? AND expires_at > ?',
    [appId, userId, now() - REFRESH_GRACE_SECONDS]
  );
  return rows.some((row) => scopes.every((s) => row.scopes.split(' ').includes(s)));
}

// A code for `userId` to give the site at `redirectUri`. Returns it: only its hash is kept.
async function createCode(app, userId, redirectUri, scopes) {
  const code = random();
  await db.run('DELETE FROM oauth_codes WHERE expires_at <= ?', [now()]);
  await db.run(
    'INSERT INTO oauth_codes (code_hash, application_id, user_id, redirect_uri, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    [hash(code), app.id, userId, redirectUri, scopes.join(' '), now() + CODE_SECONDS]
  );
  return code;
}

// Who may be logged in as: an account that isn't deleted, suspended, waiting for approval or a bot.
async function usableUser(userId) {
  const user = await db.get('SELECT id, bot, deleted_at, suspended_at, pending FROM users WHERE id = ?', [userId]);
  return Boolean(user && !user.bot && !user.deleted_at && !user.suspended_at && !user.pending);
}

// A new access and refresh token for `userId` (one row).
async function issueTokens(appId, userId, scopes) {
  const access = random();
  const refresh = random();
  const expiresAt = now() + ACCESS_SECONDS;
  await db.run(
    'INSERT INTO oauth_tokens (application_id, user_id, scopes, access_hash, refresh_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [appId, userId, scopes, hash(access), hash(refresh), expiresAt, now()]
  );
  // Discord's answer.
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: scopes };
}

// POST /oauth2/token: grant_type authorization_code (code, redirect_uri) or refresh_token
// (refresh_token). Resolves to Discord's token answer; throws OAuthError.
async function exchange(req) {
  const app = await clientFor(req);
  const body = req.body ?? {};
  const grant = body.grant_type;
  await db.run('DELETE FROM oauth_tokens WHERE expires_at <= ?', [now() - REFRESH_GRACE_SECONDS]);

  // A code or refresh token is used up as it's read (one statement), even if what follows
  // fails: it can never be traded twice.
  if (grant === 'authorization_code') {
    if (typeof body.code !== 'string' || !body.code) throw new OAuthError(400, 'invalid_request', 'code is missing');
    const code = await db.get('DELETE FROM oauth_codes WHERE code_hash = ? RETURNING *', [hash(body.code)]);
    if (!code || code.application_id !== app.id || code.expires_at <= now()) {
      throw new OAuthError(400, 'invalid_grant', 'Invalid "code" in request.');
    }
    // The same redirect_uri as the authorisation (RFC 6749 4.1.3), when it names one.
    if (body.redirect_uri != null && body.redirect_uri !== code.redirect_uri) {
      throw new OAuthError(400, 'invalid_grant', 'Invalid "redirect_uri" in request.');
    }
    if (!(await usableUser(code.user_id))) throw new OAuthError(400, 'invalid_grant', 'Invalid "code" in request.');
    return issueTokens(app.id, code.user_id, code.scopes);
  }

  if (grant === 'refresh_token') {
    if (typeof body.refresh_token !== 'string' || !body.refresh_token) throw new OAuthError(400, 'invalid_request', 'refresh_token is missing');
    const row = await db.get('DELETE FROM oauth_tokens WHERE refresh_hash = ? AND application_id = ? RETURNING *', [hash(body.refresh_token), app.id]);
    if (!row || !(await usableUser(row.user_id))) throw new OAuthError(400, 'invalid_grant', 'Invalid "refresh_token" in request.');
    return issueTokens(app.id, row.user_id, row.scopes);
  }

  throw new OAuthError(400, 'unsupported_grant_type', 'Unsupported grant type');
}

// POST /oauth2/token/revoke: the token (access or refresh) stops working, with its pair. An
// unknown token isn't an error (RFC 7009).
async function revoke(req) {
  const app = await clientFor(req);
  const token = req.body?.token;
  if (typeof token !== 'string' || !token) throw new OAuthError(400, 'invalid_request', 'token is missing');
  await db.run(
    'DELETE FROM oauth_tokens WHERE application_id = ? AND (access_hash = ? OR refresh_hash = ?)',
    [app.id, hash(token), hash(token)]
  );
}

// The token `Bearer <token>` names, if it still works: { user_id, application_id, scopes: [], expires_at }.
async function accessFor(header) {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!match) return null;
  const row = await db.get('SELECT * FROM oauth_tokens WHERE access_hash = ?', [hash(match[1])]);
  if (!row || row.expires_at <= now() || !(await usableUser(row.user_id))) return null;
  return { ...row, scopes: row.scopes.split(' ') };
}

// ---- Authorised apps (Settings) ----

// The applications `userId` has let in, newest first: { id, name, username, avatar, scopes,
// authorised_at } (`username` and `avatar` are its bot's, for drawing it).
async function authorisedApps(userId) {
  const rows = await db.all(
    `SELECT a.id, a.name, u.username, u.avatar, GROUP_CONCAT(t.scopes, ' ') AS scopes, MIN(t.created_at) AS authorised_at, MAX(t.created_at) AS last_at
     FROM oauth_tokens t JOIN bot_applications a ON a.id = t.application_id JOIN users u ON u.id = a.id
     WHERE t.user_id = ? AND t.expires_at > ?
     GROUP BY a.id ORDER BY last_at DESC`,
    [userId, now() - REFRESH_GRACE_SECONDS]
  );
  return rows.map(({ last_at: _, ...row }) => ({ ...row, scopes: [...new Set(row.scopes.split(' '))] }));
}

// Takes away application `appId`'s access to `userId` (every token and code).
async function deauthorise(appId, userId) {
  await db.transaction(async () => {
    await db.run('DELETE FROM oauth_tokens WHERE application_id = ? AND user_id = ?', [appId, userId]);
    await db.run('DELETE FROM oauth_codes WHERE application_id = ? AND user_id = ?', [appId, userId]);
  });
}

// When an application or an account goes (inside the caller's transaction).
async function forgetApplication(appId) {
  await db.run('DELETE FROM oauth_tokens WHERE application_id = ?', [appId]);
  await db.run('DELETE FROM oauth_codes WHERE application_id = ?', [appId]);
}

async function forgetUser(userId) {
  await db.run('DELETE FROM oauth_tokens WHERE user_id = ?', [userId]);
  await db.run('DELETE FROM oauth_codes WHERE user_id = ?', [userId]);
}

module.exports = {
  SCOPES,
  MAX_REDIRECT_URIS,
  OAuthError,
  parseScopes,
  checkScopes,
  cleanRedirectUris,
  redirectUrisOf,
  redirectUriFor,
  withParams,
  resetClientSecret,
  hasAuthorised,
  createCode,
  exchange,
  revoke,
  accessFor,
  authorisedApps,
  deauthorise,
  forgetApplication,
  forgetUser,
};
