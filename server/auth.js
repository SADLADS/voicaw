const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('./config');
const db = require('./db');

// Logins last 30 days from when the token was made, and keep going while the app is used:
// any authenticated request with a token older than a day gets a new one back in the
// `X-Voicaw-Token` header (the client stores it, utils/api.js). So only a device left
// unused for a month has to log in again. The payload is who the user is and the login
// session (`sid`, a `sessions` row): a token stops working once its session is logged out
// (sessions.js, Settings → Devices).
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const RENEW_AFTER_SECONDS = 24 * 60 * 60;
const RENEWED_TOKEN_HEADER = 'X-Voicaw-Token';
// A session's last use (and device) is saved at most this often, not on every request.
const SESSION_TOUCH_SECONDS = 5 * 60;

const now = () => Math.floor(Date.now() / 1000);

function generateToken(user, sessionId) {
  return jwt.sign({ id: user.id, username: user.username, sid: sessionId }, jwtSecret, { expiresIn: SESSION_SECONDS });
}

// The device a request comes from, as shown in Settings → Devices.
function deviceOf(req) {
  if (!req) return { userAgent: null, ip: null };
  return { userAgent: String(req.get?.('user-agent') ?? '').slice(0, 300) || null, ip: req.ip || null };
}

// Logs `user` in on the device making `req`: a new session (sessions left unused past a
// token's life are cleared out) and its token.
async function startSession(user, req) {
  const id = crypto.randomBytes(18).toString('base64url');
  const t = now();
  const { userAgent, ip } = deviceOf(req);
  await db.transaction(async () => {
    await db.run('DELETE FROM sessions WHERE user_id = ? AND last_used_at < ?', [user.id, t - SESSION_SECONDS]);
    await db.run(
      'INSERT INTO sessions (id, user_id, created_at, last_used_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)',
      [id, user.id, t, t, userAgent, ip]
    );
  });
  console.log(`Session started: user ${user.id}, session ${id.slice(0, 6)}, ${userAgent?.match(/Voicaw\/[\d.]+|Chrome\/\d+|Firefox\/\d+|Safari\/\d+/)?.[0] ?? 'unknown'}`);
  return generateToken(user, id);
}

// Why a token was refused, one line in the API's log (never the token: only its account, the
// start of its session id, when it was issued and where it was used), so that a device that keeps
// being logged out can be told apart: expired, signed with another secret, its session ended.
// Each token is logged at most once a minute (a dead one comes with every request it sends).
const REFUSAL_LOG_MS = 60 * 1000;
const refusalsLogged = new Map();

function refused(reason, payload, req) {
  const key = `${payload?.id}:${payload?.sid}:${payload?.iat}:${reason}`;
  const at = Date.now();
  if (at - (refusalsLogged.get(key) ?? 0) >= REFUSAL_LOG_MS) {
    refusalsLogged.set(key, at);
    if (refusalsLogged.size > 1000) refusalsLogged.clear();
    // The payload of a token that failed verification is whatever its sender wrote: only
    // checked, short values go into the line (an iat of 1e300 would make toISOString throw).
    const iat = Number(payload?.iat);
    const issued = Number.isFinite(iat) && Math.abs(iat) < 8.64e12 ? new Date(iat * 1000).toISOString() : '?';
    const id = String(payload?.id ?? '?').slice(0, 20);
    const where = req ? `${req.method} ${req.originalUrl?.split('?')[0]}` : 'websocket';
    const agent = String(req?.get?.('user-agent') ?? '').match(/Voicaw\/[\d.]+|Chrome\/\d+|Firefox\/\d+|Safari\/\d+/)?.[0] ?? '';
    console.warn(`Token refused: ${reason}; user ${id}, session ${String(payload?.sid ?? 'none').slice(0, 6)}, issued ${issued}, ${where} ${agent}`.trim());
  }
  return null;
}

// Resolves to the token's user ({ id, username, iat, sid, renew, pending }), or null if it isn't
// valid: expired, its session logged out, or the account deleted since. `req` (an HTTP request)
// updates the session's device. `renew` says the token should be replaced; `pending`, that the
// account waits for an admin's approval (signups.js).
async function verifyToken(token, req = null) {
  let failure = null;
  const payload = await new Promise((resolve) => {
    jwt.verify(token, jwtSecret, (err, decoded) => {
      failure = err;
      resolve(err ? null : decoded);
    });
  });
  if (!payload) return refused(failure?.name === 'TokenExpiredError' ? 'expired' : `not valid (${failure?.message})`, jwt.decode(token), req);
  const row = await db.get('SELECT deleted_at, suspended_at, pending FROM users WHERE id = ?', [payload.id]);
  // Deleted or suspended (Settings → Admin): the token no longer works anywhere.
  if (!row || row.deleted_at || row.suspended_at) return refused('account deleted or suspended', payload, req);

  const t = now();
  // Tokens from before login sessions (2026-10-02) carried no session id; they lasted 30 days,
  // so none can still be valid, and one without is refused.
  const sid = typeof payload.sid === 'string' ? payload.sid : null;
  if (!sid) return refused('no session', payload, req);
  const session = await db.get('SELECT last_used_at FROM sessions WHERE id = ? AND user_id = ?', [sid, payload.id]);
  if (!session) return refused('session ended', payload, req);
  if (t - session.last_used_at >= SESSION_TOUCH_SECONDS) {
    const { userAgent, ip } = deviceOf(req);
    await db.run(
      'UPDATE sessions SET last_used_at = ?, user_agent = COALESCE(?, user_agent), ip = COALESCE(?, ip) WHERE id = ?',
      [t, userAgent, ip, sid]
    );
  }
  return {
    id: payload.id,
    username: payload.username,
    iat: payload.iat,
    sid,
    renew: t - payload.iat > RENEW_AFTER_SECONDS,
    pending: Boolean(row.pending),
  };
}

// The login cookie (security audit follow-up, 2026-11-20). The web app and the Android app keep
// their login in this HttpOnly cookie, so a script in the page can't read it and use the account
// from elsewhere (SameSite=None: the Android app's page, https://localhost, is cross-site to the
// API). Every request made with it names its session in `X-Voicaw-Session` (the session id,
// `sid`). That header is what makes the cookie count at all: another site's form or link can't
// send headers, and a script on another origin can't without CORS letting it, so they never act
// as anyone. It also tells a page that a newer login replaced its own (409 `login_changed`:
// another tab logged out and in again, or logout's last requests sent late). The desktop app's
// main process keeps the token itself and sends it as Bearer beside the same header
// (electron/apiLogin.js); apps logging in to another server, bots' owners' scripts and older
// apps keep plain Bearer tokens. Clients ask for the cookie by logging in with
// `X-Voicaw-Login: cookie`, and a client that names its session never gets a token back.
const SESSION_COOKIE = 'voicaw_session';
const SESSION_HEADER = 'X-Voicaw-Session';
const LOGIN_MODE_HEADER = 'X-Voicaw-Login';
const TOKEN_TEXT = /^[A-Za-z0-9_\-.]{1,4096}$/;

function sessionCookieOf(req) {
  for (const part of String(req.headers?.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(at + 1).trim();
    return TOKEN_TEXT.test(value) ? value : null;
  }
  return null;
}

const cookieLine = (value, maxAge) => `${SESSION_COOKIE}=${value}; Path=/api; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=None`;

function setSessionCookie(res, token) {
  res.append('Set-Cookie', cookieLine(token, SESSION_SECONDS));
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', cookieLine('', 0));
}

// Whether the request comes from a page that keeps its login in the cookie (or in the desktop
// app's main process): it names its session.
const sessionMode = (req) => Boolean(req.get?.(SESSION_HEADER));

// What a page in cookie mode keeps instead of the token: who it is and which session. Not a
// secret: without the cookie (or the desktop app's copy) none of it logs anyone in.
function loginOf(token) {
  const claims = jwt.decode(token);
  return { id: claims.id, username: claims.username, sid: claims.sid, iat: claims.iat };
}

// A new session for `user` (startSession), answered the way the client asked: `{ token }`, or
// for `X-Voicaw-Login: cookie` the cookie and `{ login }` (loginOf).
async function sessionReply(user, req, res) {
  const token = await startSession(user, req);
  if (String(req.get?.(LOGIN_MODE_HEADER) ?? '').toLowerCase() === 'cookie') {
    setSessionCookie(res, token);
    return { login: loginOf(token) };
  }
  return { token };
}

// Websocket tickets: the app's socket is on another host than its API (wss://api.voicaw.com, the
// API at app.voicaw.com/api), so the cookie never reaches it. A page logged in by cookie asks
// POST /socket-ticket for one and sends it in its identify, once, within a minute. Kept in
// memory: the socket and the API are the same process.
const TICKET_MS = 60 * 1000;
const MAX_TICKETS = 10000;
const tickets = new Map();

function issueSocketTicket(token) {
  const at = Date.now();
  if (tickets.size >= MAX_TICKETS) {
    for (const [key, kept] of tickets) if (kept.expires <= at) tickets.delete(key);
    if (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value);
  }
  const ticket = crypto.randomBytes(24).toString('base64url');
  tickets.set(ticket, { token, expires: at + TICKET_MS });
  return ticket;
}

// The token a ticket stands for (once), or null.
function redeemSocketTicket(ticket) {
  if (typeof ticket !== 'string') return null;
  const kept = tickets.get(ticket);
  if (!kept) return null;
  tickets.delete(ticket);
  return kept.expires > Date.now() ? kept.token : null;
}

function authenticate(allowPending) {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization;
    const named = req.get(SESSION_HEADER);
    let token;
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else if (named) {
      token = sessionCookieOf(req);
      // Logged out here already (another tab, or the cookie cleared): nothing to log in with.
      if (!token) return res.status(401).json({ error: 'Not logged in', code: 'no_session' });
    } else {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }
    const user = await verifyToken(token, req);
    if (!user) {
      if (named) clearSessionCookie(res);
      return res.status(403).json({ error: 'Invalid token' });
    }
    if (named && named !== user.sid) {
      return res.status(409).json({ error: 'Another login replaced this one', code: 'login_changed' });
    }
    if (user.renew) {
      const renewed = generateToken(user, user.sid);
      if (named) setSessionCookie(res, renewed);
      else res.set(RENEWED_TOKEN_HEADER, renewed);
    }
    if (user.pending && !allowPending) {
      return res.status(403).json({ error: 'Your account is waiting for an admin to approve it', code: 'pending' });
    }
    req.user = user;
    // For this process only (socket tickets, moving a login into the cookie): never sent back
    // to a client that names its session.
    req.loginToken = token;
    next();
  };
}

// Express middleware for routes that need a logged-in user (`req.user`). An account waiting for
// approval (signups.js) is refused everywhere except the few routes that use
// authenticatePending: its own login, devices and deleting it.
const authenticateJWT = authenticate(false);
const authenticatePending = authenticate(true);

// Sessions unused for a token's life can't be used again (their token has expired): forgotten,
// with the address and device they last had, every hour for everyone, not only at that
// person's next login (the privacy policy, website/src/legal/privacy.html, says so).
const SESSION_SWEEP_MS = 60 * 60 * 1000;
// (The same sweep forgets reports resolved over a year ago: reports.js.)

async function pruneStaleSessions(at = now()) {
  const { changes } = await db.run('DELETE FROM sessions WHERE last_used_at < ?', [at - SESSION_SECONDS]);
  return changes;
}

function startSessionCleanup() {
  const sweep = () => {
    pruneStaleSessions().catch((err) => console.error('Session cleanup failed:', err.message));
    require('./reports').pruneReports().catch((err) => console.error('Report cleanup failed:', err.message));
  };
  sweep();
  return setInterval(sweep, SESSION_SWEEP_MS);
}

module.exports = {
  generateToken, startSession, verifyToken, authenticateJWT, authenticatePending, pruneStaleSessions, startSessionCleanup,
  sessionReply, sessionMode, setSessionCookie, clearSessionCookie, loginOf, issueSocketTicket, redeemSocketTicket,
  SESSION_SECONDS, RENEW_AFTER_SECONDS, RENEWED_TOKEN_HEADER, SESSION_TOUCH_SECONDS, SESSION_COOKIE, SESSION_HEADER, LOGIN_MODE_HEADER,
};
