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
    const issued = payload?.iat ? new Date(payload.iat * 1000).toISOString() : '?';
    const where = req ? `${req.method} ${req.originalUrl?.split('?')[0]}` : 'websocket';
    const agent = String(req?.get?.('user-agent') ?? '').match(/Voicaw\/[\d.]+|Chrome\/\d+|Firefox\/\d+|Safari\/\d+/)?.[0] ?? '';
    console.warn(`Token refused: ${reason}; user ${payload?.id ?? '?'}, session ${String(payload?.sid ?? 'none').slice(0, 6)}, issued ${issued}, ${where} ${agent}`.trim());
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
  const row = await db.get('SELECT deleted_at, suspended_at, sessions_reset_at, pending FROM users WHERE id = ?', [payload.id]);
  // Deleted or suspended (Settings → Admin): the token no longer works anywhere.
  if (!row || row.deleted_at || row.suspended_at) return refused('account deleted or suspended', payload, req);

  const t = now();
  let sid = payload.sid;
  if (!sid) {
    // A token from before login sessions: it becomes one, named after the token so the
    // requests a device sends at once share it, and is renewed with it. Logging any session
    // out from Settings refuses the ones that haven't been used since.
    if (row.sessions_reset_at != null && payload.iat <= row.sessions_reset_at) return refused('from before sessions, reset', payload, req);
    sid = crypto.createHash('sha256').update(token).digest('base64url').slice(0, 24);
    const { userAgent, ip } = deviceOf(req);
    await db.run(
      `INSERT OR IGNORE INTO sessions (id, user_id, created_at, last_used_at, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sid, payload.id, payload.iat, t, userAgent, ip]
    );
  }
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
    renew: !payload.sid || t - payload.iat > RENEW_AFTER_SECONDS,
    pending: Boolean(row.pending),
  };
}

function authenticate(allowPending) {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }
    const user = await verifyToken(authHeader.split(' ')[1], req);
    if (!user) return res.status(403).json({ error: 'Invalid token' });
    if (user.renew) res.set(RENEWED_TOKEN_HEADER, generateToken(user, user.sid));
    if (user.pending && !allowPending) {
      return res.status(403).json({ error: 'Your account is waiting for an admin to approve it', code: 'pending' });
    }
    req.user = user;
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
  SESSION_SECONDS, RENEW_AFTER_SECONDS, RENEWED_TOKEN_HEADER, SESSION_TOUCH_SECONDS,
};
