const crypto = require('crypto');
const express = require('express');
const opaque = require('@serenity-kit/opaque');
const db = require('../db');
const { opaqueServerSetup } = require('../config');
const { startSession, authenticateJWT, authenticatePending } = require('../auth');
const { rateLimitsEnabled } = require('../config');
const { createLimiter, tooManyAttempts } = require('../rateLimit');
const { LIMITS: PROFILE_LIMITS, PROFILE_COLUMNS, clean: cleanProfile } = require('../profiles');
const { sendToAllSockets } = require('../sockets');
const { normalizeUsername, findUserByName, opaqueIdOf, newOpaqueId } = require('../usernames');
const accounts = require('../accounts');
const signups = require('../signups');

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
  // Recovery codes can't be guessed (125 bits), so these only stop pointless hammering.
  recoverPerIp: createLimiter({ windowMs: 15 * MINUTE, max: 30 }),
  recoverPerUsername: createLimiter({ windowMs: 15 * MINUTE, max: 20 }),
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
const byUsername = (req) => normalizeUsername(req.body?.userIdentifier).slice(0, 100);

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

  const user = await findUserByName(userIdentifier, 'username, password, opaque_id');
  const username = user?.username ?? normalizeUsername(userIdentifier);
  // Unknown usernames get OPAQUE's dummy response (registrationRecord = null), which is
  // indistinguishable from a real one and just fails at the end like a wrong password,
  // so logged-out visitors can't find out which usernames exist.
  const { serverLoginState, loginResponse } = opaque.server.startLogin({
    serverSetup: opaqueServerSetup,
    userIdentifier: user ? opaqueIdOf(user) : username,
    registrationRecord: user ? user.password : null,
    startLoginRequest,
  });

  await db.run(
    `INSERT INTO login_states (username, server_login_state, expires_at)
     VALUES (?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET
       server_login_state = excluded.server_login_state,
       expires_at = excluded.expires_at`,
    [username, JSON.stringify(serverLoginState), now() + LOGIN_STATE_SECONDS]
  );
  res.json({ loginResponse });
});

// Checks the second half of an OPAQUE login for `username` (started with /initiatelogin; the
// account's username, or the lower-cased name typed for an unknown one).
// Resolves to null when it's right, otherwise to [status, error] to answer with.
async function checkLoginProof(username, finishLoginRequest, clientSessionKey) {
  if (!finishLoginRequest || !clientSessionKey) return [400, 'Missing data'];
  await opaque.ready;
  const state = await db.get('SELECT * FROM login_states WHERE username = ?', [username]);
  if (!state) return [401, 'Invalid credentials'];
  if (now() > state.expires_at) return [401, 'Login state expired'];

  let sessionKey;
  try {
    ({ sessionKey } = opaque.server.finishLogin({
      finishLoginRequest,
      serverLoginState: JSON.parse(state.server_login_state),
    }));
  } catch (e) {
    console.error('OPAQUE finishLogin error:', e);
    return [401, 'Invalid credentials'];
  }
  if (!sessionKey || sessionKey !== clientSessionKey) return [401, 'Login failed'];

  await db.run('DELETE FROM login_states WHERE username = ?', [username]);
  limits.loginPerUsername.reset(String(username).slice(0, 100));
  return null;
}

router.post('/finaliselogin', async (req, res) => {
  const { finishLoginRequest, clientSessionKey, userIdentifier } = req.body;
  if (!finishLoginRequest || !clientSessionKey || !userIdentifier || typeof userIdentifier !== 'string') return res.status(400).json({ error: 'Missing data' });

  const user = await findUserByName(
    userIdentifier,
    'id, username, identity_key, encryption_key, encryption_key_signature, key_backup, recovery_verifier, pending'
  );
  const failed = await checkLoginProof(user?.username ?? normalizeUsername(userIdentifier), finishLoginRequest, clientSessionKey);
  if (failed) return res.status(failed[0]).json({ error: failed[1] });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  // The client decrypts the backup with its OPAQUE exportKey and checks the published
  // public keys against the ones inside it.
  res.json({
    token: await startSession(user, req),
    id: user.id,
    username: user.username,
    hasRecoveryCode: Boolean(user.recovery_verifier),
    pending: Boolean(user.pending),
    keyBackup: user.key_backup,
    identityKey: user.identity_key,
    encryptionKey: user.encryption_key,
    encryptionKeySignature: user.encryption_key_signature,
  });
});

router.post('/initiateregister', limit([limits.registerStartPerIp, byIp]), async (req, res) => {
  const { userIdentifier, registrationRequest } = req.body;
  if (!userIdentifier || !registrationRequest || typeof userIdentifier !== 'string') return res.status(400).json({ error: 'Missing username or registrationRequest' });
  // Sign-ups that need an invite are refused before the client makes its keys (checked again,
  // and the invite used up, by /finaliseregister). A password change sends no `invite` and
  // isn't refused (it's this route too).
  if (req.body.signup === true) {
    try {
      await signups.checkSignup(req.body.invite);
    } catch (err) {
      if (err instanceof signups.SignupError) return res.status(err.status).json({ error: err.message, code: err.code });
      throw err;
    }
  }
  await opaque.ready;

  // Always the lower-case name: new accounts get it as their username, and a password change or
  // recovery stores it as the account's opaque_id when that isn't its username (newOpaqueId).
  const { registrationResponse } = opaque.server.createRegistrationResponse({
    serverSetup: opaqueServerSetup,
    userIdentifier: normalizeUsername(userIdentifier),
    registrationRequest,
  });
  res.status(201).json({ registrationResponse });
});

router.post('/finaliseregister', limit([limits.registerPerIp, byIp]), async (req, res) => {
  const { registrationRecord, userIdentifier, identityKey, encryptionKey, encryptionKeySignature, keyBackup, recoveryVerifier, recoveryBackup } = req.body;
  if (!userIdentifier || !registrationRecord || typeof userIdentifier !== 'string') return res.status(400).json({ error: 'Missing username or registrationRecord' });
  if (!identityKey || !encryptionKey || !encryptionKeySignature || !keyBackup) {
    return res.status(400).json({ error: 'Missing keys' });
  }
  // Clients verify this themselves; checking here just keeps broken keys out of the DB.
  if (!(await isValidEncryptionKeySignature(identityKey, encryptionKey, encryptionKeySignature))) {
    return res.status(400).json({ error: 'Invalid key signature' });
  }
  const recovery = recoveryVerifier || recoveryBackup ? parseRecovery(req.body) : null;
  if (recovery?.error) return res.status(400).json({ error: recovery.error });

  // Capitals typed in the username become the display name ("Alice": username "alice").
  const username = normalizeUsername(userIdentifier);
  const displayName = username === userIdentifier ? null : cleanProfile('display_name', userIdentifier) ?? null;
  // '#' is kept for bots' names (bots.js: "name#1234"), so nobody can sign up as one.
  if (username.includes('#')) return res.status(400).json({ error: "Usernames can't contain #" });
  if (await findUserByName(username, 'id')) return res.status(409).json({ error: 'Username already exists' });
  // Sign-ups (signups.js): refused without an invite when they need one; waiting for an admin
  // when they need approval.
  let signup;
  try {
    signup = await signups.checkSignup(req.body.invite);
  } catch (err) {
    if (err instanceof signups.SignupError) return res.status(err.status).json({ error: err.message, code: err.code });
    throw err;
  }
  let lastID;
  try {
    await db.transaction(async () => {
      if (signup.invite) await signups.useInvite(signup.invite);
      ({ lastID } = await db.run(
        `INSERT INTO users (username, display_name, password, identity_key, encryption_key, encryption_key_signature,
           key_backup, recovery_verifier, recovery_backup, recovery_created, pending)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [username, displayName, registrationRecord, identityKey, encryptionKey, encryptionKeySignature, keyBackup,
          recovery?.verifier ?? null, recovery?.backup ?? null, recovery ? now() : null, signup.pending ? 1 : 0]
      ));
    });
  } catch (err) {
    if (err instanceof signups.SignupError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    throw err;
  }
  const user = { id: lastID, username };
  if (signup.pending) await signups.announceRequests();
  res.status(201).json({
    token: await startSession(user, req), id: user.id, username, display_name: displayName, hasRecoveryCode: Boolean(recovery),
    pending: signup.pending,
  });
});

// Restores a session from its token (the client keeps it in localStorage). `pending`: the account
// waits for an admin's approval (signups.js); the app shows only that.
router.get('/profile', authenticatePending, async (req, res) => {
  const user = await db.get(`SELECT id, username, recovery_verifier, pending, ${PROFILE_COLUMNS} FROM users WHERE id = ?`, [req.user.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const token = req.headers.authorization.split(' ')[1];
  res.json({
    // The username from the database: a token from before usernames were lower-cased has the old one.
    token, id: req.user.id, username: user.username, hasRecoveryCode: Boolean(user.recovery_verifier),
    pending: Boolean(user.pending), display_name: user.display_name, custom_status: user.custom_status, bio: user.bio, avatar: user.avatar,
  });
});

// Changes your profile (profiles.js): any of `displayName`, `customStatus`, `bio` (null or
// "" clears one). Everyone logged in gets `user_profile` with the new one.
router.put('/profile', authenticateJWT, async (req, res) => {
  const fields = { displayName: 'display_name', customStatus: 'custom_status', bio: 'bio' };
  const updates = [];
  const params = [];
  for (const [key, column] of Object.entries(fields)) {
    if (req.body?.[key] === undefined) continue;
    const value = cleanProfile(column, req.body[key]);
    if (value === undefined) {
      return res.status(400).json({ error: `That ${column.replace('_', ' ')} is too long (at most ${PROFILE_LIMITS[column]} characters)` });
    }
    updates.push(`${column} = ?`);
    params.push(value);
  }
  if (updates.length) await db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, [...params, req.user.id]);
  const profile = await db.get(`SELECT id, username, ${PROFILE_COLUMNS} FROM users WHERE id = ?`, [req.user.id]);
  if (updates.length) sendToAllSockets({ type: 'user_profile', user: profile });
  res.json(profile);
});

// ---------------------------------------------------------------- password and recovery code
//
// Neither the password nor the private keys ever reach the server: the client re-encrypts
// its key backup itself and sends only the result. Changes while logged in need the current
// password too (a fresh OPAQUE login: /initiatelogin, then its finishLoginRequest and
// session key sent along here), so a stolen token alone can't take over the account. A
// recovery code works without being logged in.

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_BACKUP_LENGTH = 4096;

function isBackup(value) {
  if (typeof value !== 'string' || value.length > MAX_BACKUP_LENGTH) return false;
  try {
    const { v, iv, ct } = JSON.parse(value);
    return v === 1 && typeof iv === 'string' && typeof ct === 'string';
  } catch {
    return false;
  }
}

// { verifier, backup } from a request body, or { error }.
function parseRecovery({ recoveryVerifier, recoveryBackup }) {
  if (typeof recoveryVerifier !== 'string' || !BASE64.test(recoveryVerifier)
    || Buffer.from(recoveryVerifier, 'base64').length !== 32) {
    return { error: 'Invalid recovery verifier' };
  }
  if (!isBackup(recoveryBackup)) return { error: 'Invalid recovery backup' };
  return { verifier: recoveryVerifier, backup: recoveryBackup };
}

// A registration record from /initiateregister for a new password, and the key backup
// re-encrypted with that registration's exportKey.
function newPassword({ registrationRecord, keyBackup }) {
  if (typeof registrationRecord !== 'string' || !registrationRecord || registrationRecord.length > 1024) {
    return { error: 'Missing registrationRecord' };
  }
  if (!isBackup(keyBackup)) return { error: 'Invalid key backup' };
  return { record: registrationRecord, backup: keyBackup };
}

// The key backup, for re-encrypting it (it's useless without the password).
router.get('/key-backup', authenticatePending, async (req, res) => {
  const user = await db.get('SELECT key_backup FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ keyBackup: user.key_backup });
});

// The logged-in user's username now (their token may be from before it was lower-cased).
const usernameOf = async (req) => (await db.get('SELECT username FROM users WHERE id = ?', [req.user.id])) ?? { username: '' };

router.post('/change-password', authenticatePending, async (req, res) => {
  const password = newPassword(req.body);
  if (password.error) return res.status(400).json({ error: password.error });
  const { username } = await usernameOf(req);
  const failed = await checkLoginProof(username, req.body.finishLoginRequest, req.body.clientSessionKey);
  if (failed) return res.status(failed[0]).json({ error: failed[0] === 401 ? 'Current password is incorrect' : failed[1] });

  await db.run(
    'UPDATE users SET password = ?, key_backup = ?, opaque_id = ? WHERE id = ?',
    [password.record, password.backup, newOpaqueId(username), req.user.id]
  );
  res.json({ ok: true });
});

// Sets up a recovery code, or replaces the old one (which then stops working).
router.put('/recovery-code', authenticatePending, async (req, res) => {
  const recovery = parseRecovery(req.body);
  if (recovery.error) return res.status(400).json({ error: recovery.error });
  const { username } = await usernameOf(req);
  const failed = await checkLoginProof(username, req.body.finishLoginRequest, req.body.clientSessionKey);
  if (failed) return res.status(failed[0]).json({ error: failed[0] === 401 ? 'Password is incorrect' : failed[1] });

  await db.run(
    'UPDATE users SET recovery_verifier = ?, recovery_backup = ?, recovery_created = ? WHERE id = ?',
    [recovery.verifier, recovery.backup, now(), req.user.id]
  );
  res.json({ ok: true });
});

// Your guilds that would stop the account being deleted (Settings shows them up front).
router.get('/account/owned-guilds', authenticatePending, async (req, res) => {
  res.json(await accounts.ownedGuilds(req.user.id));
});

// Deletes your account (accounts.js), with a login proof of the password like the routes above:
// { finishLoginRequest, clientSessionKey, deleteOwnedGuilds?, groupLeaves: { groupId: entry } }.
// Everything is checked before the proof is used, so a refusal doesn't cost a login.
router.delete('/account', authenticatePending, async (req, res) => {
  let plan;
  try {
    plan = await accounts.checkDeletion(req.user.id, req.body ?? {});
  } catch (err) {
    if (err instanceof accounts.DeletionError) return res.status(err.status).json({ error: err.message, ...err.extra });
    throw err;
  }
  const { username } = await usernameOf(req);
  const failed = await checkLoginProof(username, req.body.finishLoginRequest, req.body.clientSessionKey);
  if (failed) return res.status(failed[0]).json({ error: failed[0] === 401 ? 'Password is incorrect' : failed[1] });

  // Still waiting for approval: nothing of it is kept, not even the "Deleted User" row.
  if (req.user.pending && (await signups.removePending(req.user.id))) return res.json({ ok: true });
  await accounts.deleteAccount(req.user.id, plan);
  res.json({ ok: true });
});

// A made-up verifier to compare against for unknown usernames, so they take as long and
// fail the same way as a wrong code.
const DUMMY_VERIFIER = crypto.randomBytes(32);

// The user if `recoveryAuth` matches their recovery code, else null.
async function checkRecoveryAuth(username, recoveryAuth) {
  if (typeof username !== 'string' || typeof recoveryAuth !== 'string' || !BASE64.test(recoveryAuth)) return null;
  const user = await findUserByName(
    username,
    'id, username, recovery_verifier, recovery_backup, identity_key, encryption_key, encryption_key_signature, pending'
  );
  const expected = user?.recovery_verifier ? Buffer.from(user.recovery_verifier, 'base64') : DUMMY_VERIFIER;
  const actual = crypto.createHash('sha256').update(Buffer.from(recoveryAuth, 'base64')).digest();
  const matches = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  return matches && user?.recovery_verifier ? user : null;
}

const recoverLimits = limit([limits.recoverPerIp, byIp], [limits.recoverPerUsername, byUsername]);
const WRONG_RECOVERY = 'Wrong username or recovery code';

// Step 1: the recovery copy of the keys, which only the code opens.
router.post('/recover/start', recoverLimits, async (req, res) => {
  const user = await checkRecoveryAuth(req.body.userIdentifier, req.body.recoveryAuth);
  if (!user) return res.status(401).json({ error: WRONG_RECOVERY });
  res.json({
    recoveryBackup: user.recovery_backup,
    identityKey: user.identity_key,
    encryptionKey: user.encryption_key,
    encryptionKeySignature: user.encryption_key_signature,
  });
});

// Step 2: the new password (registration record, and the keys encrypted for it). Logs in.
// The recovery code stays the same.
router.post('/recover/finish', recoverLimits, async (req, res) => {
  const user = await checkRecoveryAuth(req.body.userIdentifier, req.body.recoveryAuth);
  if (!user) return res.status(401).json({ error: WRONG_RECOVERY });
  const password = newPassword(req.body);
  if (password.error) return res.status(400).json({ error: password.error });

  await db.transaction(async () => {
    await db.run(
      'UPDATE users SET password = ?, key_backup = ?, opaque_id = ? WHERE id = ?',
      [password.record, password.backup, newOpaqueId(user.username), user.id]
    );
    await db.run('DELETE FROM login_states WHERE username = ?', [user.username]);
  });
  limits.loginPerUsername.reset(byUsername(req));
  res.json({
    token: await startSession(user, req),
    id: user.id,
    username: user.username,
    hasRecoveryCode: true,
    pending: Boolean(user.pending),
  });
});

module.exports = router;
