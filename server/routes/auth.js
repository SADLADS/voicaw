const crypto = require('crypto');
const express = require('express');
const opaque = require('@serenity-kit/opaque');
const db = require('../db');
const { opaqueServerSetup } = require('../config');
const { generateToken, authenticateJWT } = require('../auth');
const { rateLimitsEnabled } = require('../config');
const { createLimiter, tooManyAttempts } = require('../rateLimit');

// Registration and login use OPAQUE (the password never reaches the server), each in two
// round trips. Login state between them lives in login_states for 5 minutes.
const router = express.Router();
const LOGIN_STATE_SECONDS = 300;

const now = () => Math.floor(Date.now() / 1000);

// Password guessing has to go through the server (OPAQUE gives nothing to guess offline), so
// attempts are limited per address and per username. The username limit applies whether or
// not the account exists, so it can't be used to find out which ones do. A successful login
// clears its username's count.
const MINUTE = 60 * 1000;
const limits = {
  loginPerIp: createLimiter({ windowMs: 15 * MINUTE, max: 30 }),
  loginPerUsername: createLimiter({ windowMs: 15 * MINUTE, max: 20 }),
  registerStartPerIp: createLimiter({ windowMs: 60 * MINUTE, max: 30 }),
  registerPerIp: createLimiter({ windowMs: 60 * MINUTE, max: 10 }),
};

// Middleware: counts this request against `limiters` ([limiter, keyOf(req)] pairs) and
// answers 429 once any of them is used up.
function limit(...limiters) {
  return (req, res, next) => {
    if (!rateLimitsEnabled) return next();
    for (const [limiter, keyOf] of limiters) {
      const { allowed, retryAfterMs } = limiter.hit(keyOf(req));
      if (!allowed) return tooManyAttempts(res, retryAfterMs);
    }
    next();
  };
}

const byIp = (req) => req.ip;
const byUsername = (req) => String(req.body?.userIdentifier).slice(0, 100);

// ECDSA P-256 / SHA-256 over "voicaw/encryption-key/v1\n<encryptionKey>" (see the client's
// encryptionService); keys and signature are base64.
async function isValidEncryptionKeySignature(identityKey, encryptionKey, signature) {
  try {
    const key = await crypto.webcrypto.subtle.importKey(
      'raw', Buffer.from(identityKey, 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
    );
    return await crypto.webcrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      Buffer.from(signature, 'base64'),
      new TextEncoder().encode(`voicaw/encryption-key/v1\n${encryptionKey}`)
    );
  } catch {
    return false;
  }
}

router.post('/initiatelogin', limit([limits.loginPerIp, byIp], [limits.loginPerUsername, byUsername]), async (req, res) => {
  const { startLoginRequest, userIdentifier } = req.body;
  if (!startLoginRequest || !userIdentifier || typeof userIdentifier !== 'string') return res.status(400).json({ error: 'Missing startLoginRequest or userIdentifier' });
  await opaque.ready;

  // Forget abandoned login attempts (states are only removed on successful login).
  await db.run('DELETE FROM login_states WHERE expires_at < ?', [now()]);

  const user = await db.get('SELECT password FROM users WHERE username = ?', [userIdentifier]);
  // Unknown usernames get OPAQUE's dummy response (registrationRecord = null), which is
  // indistinguishable from a real one and just fails at the end like a wrong password,
  // so logged-out visitors can't find out which usernames exist.
  const { serverLoginState, loginResponse } = opaque.server.startLogin({
    serverSetup: opaqueServerSetup,
    userIdentifier,
    registrationRecord: user ? user.password : null,
    startLoginRequest,
  });

  await db.run(
    `INSERT INTO login_states (username, server_login_state, expires_at)
     VALUES (?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET
       server_login_state = excluded.server_login_state,
       expires_at = excluded.expires_at`,
    [userIdentifier, JSON.stringify(serverLoginState), now() + LOGIN_STATE_SECONDS]
  );
  res.json({ loginResponse });
});

router.post('/finaliselogin', async (req, res) => {
  const { finishLoginRequest, clientSessionKey, userIdentifier } = req.body;
  if (!finishLoginRequest || !clientSessionKey || !userIdentifier || typeof userIdentifier !== 'string') return res.status(400).json({ error: 'Missing data' });
  await opaque.ready;

  const state = await db.get('SELECT * FROM login_states WHERE username = ?', [userIdentifier]);
  if (!state) return res.status(401).json({ error: 'Invalid credentials' });
  if (now() > state.expires_at) return res.status(401).json({ error: 'Login state expired' });

  let sessionKey;
  try {
    ({ sessionKey } = opaque.server.finishLogin({
      finishLoginRequest,
      serverLoginState: JSON.parse(state.server_login_state),
    }));
  } catch (e) {
    console.error('OPAQUE finishLogin error:', e);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (!sessionKey || sessionKey !== clientSessionKey) {
    return res.status(401).json({ error: 'Login failed' });
  }

  await db.run('DELETE FROM login_states WHERE username = ?', [userIdentifier]);
  limits.loginPerUsername.reset(byUsername(req));
  const user = await db.get(
    'SELECT id, identity_key, encryption_key, encryption_key_signature, key_backup FROM users WHERE username = ?',
    [userIdentifier]
  );
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  // The client decrypts the backup with its OPAQUE exportKey and checks the published
  // public keys against the ones inside it.
  res.json({
    token: generateToken({ id: user.id, username: userIdentifier }),
    id: user.id,
    username: userIdentifier,
    keyBackup: user.key_backup,
    identityKey: user.identity_key,
    encryptionKey: user.encryption_key,
    encryptionKeySignature: user.encryption_key_signature,
  });
});

router.post('/initiateregister', limit([limits.registerStartPerIp, byIp]), async (req, res) => {
  const { userIdentifier, registrationRequest } = req.body;
  if (!userIdentifier || !registrationRequest || typeof userIdentifier !== 'string') return res.status(400).json({ error: 'Missing username or registrationRequest' });
  await opaque.ready;

  const { registrationResponse } = opaque.server.createRegistrationResponse({
    serverSetup: opaqueServerSetup,
    userIdentifier,
    registrationRequest,
  });
  res.status(201).json({ registrationResponse });
});

router.post('/finaliseregister', limit([limits.registerPerIp, byIp]), async (req, res) => {
  const { registrationRecord, userIdentifier, identityKey, encryptionKey, encryptionKeySignature, keyBackup } = req.body;
  if (!userIdentifier || !registrationRecord || typeof userIdentifier !== 'string') return res.status(400).json({ error: 'Missing username or registrationRecord' });
  if (!identityKey || !encryptionKey || !encryptionKeySignature || !keyBackup) {
    return res.status(400).json({ error: 'Missing keys' });
  }
  // Clients verify this themselves; checking here just keeps broken keys out of the DB.
  if (!(await isValidEncryptionKeySignature(identityKey, encryptionKey, encryptionKeySignature))) {
    return res.status(400).json({ error: 'Invalid key signature' });
  }

  let lastID;
  try {
    ({ lastID } = await db.run(
      `INSERT INTO users (username, password, identity_key, encryption_key, encryption_key_signature, key_backup)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userIdentifier, registrationRecord, identityKey, encryptionKey, encryptionKeySignature, keyBackup]
    ));
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    throw err;
  }
  const user = { id: lastID, username: userIdentifier };
  res.status(201).json({ token: generateToken(user), id: user.id, username: user.username });
});

// Restores a session from its token (the client keeps it in localStorage).
router.get('/profile', authenticateJWT, async (req, res) => {
  const user = await db.get('SELECT id FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const token = req.headers.authorization.split(' ')[1];
  res.json({ token, id: req.user.id, username: req.user.username });
});

module.exports = router;
