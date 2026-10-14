const crypto = require('crypto');
const db = require('./db');
const { getSetting } = require('./appSettings');
const { sendToUserSockets, approvePendingSockets, closePendingSockets } = require('./sockets');
const adminAlerts = require('./adminAlerts');

// Who can make an account (Settings → Admin, the `signupMode` setting):
// - 'open': anyone;
// - 'invite': only with an app invite (made by admins, below);
// - 'request': anyone, but the account is `pending` until an admin approves it. A pending account
//   can log in, but only to its own login, devices and deleting it (auth.js authenticatePending):
//   it gets no websocket broadcasts and isn't listed to anyone, so it can't learn who's here.
//   A valid invite skips the wait. Declining removes the account altogether (it can't have
//   written anything), so the name is free again.
// Accounts from before (and every account made while sign-ups are open) are approved.

const MAX_INVITE_AGE = 30 * 24 * 60 * 60;
const MAX_INVITE_USES = 1000;
const INVITE_CODE = /^[A-Za-z0-9]{1,32}$/;

const now = () => Math.floor(Date.now() / 1000);

class SignupError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const signupMode = () => getSetting('signupMode');

function newInviteCode() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.randomBytes(10), (b) => alphabet[b % alphabet.length]).join('');
}

// An invite that can still be used.
const INVITE_VALID = `(expires_at IS NULL OR expires_at > strftime('%s','now'))
  AND (max_uses IS NULL OR uses < max_uses)`;

async function validInvite(code) {
  if (typeof code !== 'string' || !INVITE_CODE.test(code)) return null;
  return db.get(`SELECT code FROM app_invites WHERE code = ? AND ${INVITE_VALID}`, [code]);
}

// Whether someone may sign up now, with `invite` (a code, optional): resolves to { pending, invite }
// (the code to use up), or throws a SignupError. In open mode an invite is ignored.
async function checkSignup(invite) {
  const mode = await signupMode();
  if (mode === 'open') return { pending: false, invite: null };
  const hasCode = typeof invite === 'string' && invite.trim() !== '';
  const valid = hasCode ? await validInvite(invite.trim()) : null;
  if (hasCode && !valid) throw new SignupError(403, 'That invite is invalid or has expired', 'invalid_invite');
  if (mode === 'invite' && !valid) throw new SignupError(403, 'Signing up needs an invite', 'invite_required');
  return { pending: !valid, invite: valid?.code ?? null };
}

// Inside the transaction that makes the account: uses the invite up, or throws a SignupError if
// it ran out meanwhile.
async function useInvite(code) {
  const { changes } = await db.run(`UPDATE app_invites SET uses = uses + 1 WHERE code = ? AND ${INVITE_VALID}`, [code]);
  if (!changes) throw new SignupError(403, 'That invite is invalid or has expired', 'invalid_invite');
}

const INVITE_SELECT = `
  SELECT i.code, i.creator_id, u.username AS creator_username, i.created_at, i.expires_at, i.max_uses, i.uses
  FROM app_invites i JOIN users u ON u.id = i.creator_id`;

// Invites that still work, newest first.
const listInvites = () => db.all(
  `${INVITE_SELECT} WHERE (i.expires_at IS NULL OR i.expires_at > strftime('%s','now'))
     AND (i.max_uses IS NULL OR i.uses < i.max_uses)
   ORDER BY i.created_at DESC, i.code`
);

// `maxAge` (seconds) and `maxUses`: 0 = no limit.
async function createInvite(creatorId, { maxAge = 0, maxUses = 0 } = {}) {
  if (!Number.isInteger(maxAge) || maxAge < 0 || maxAge > MAX_INVITE_AGE) throw new SignupError(400, 'Invalid maxAge');
  if (!Number.isInteger(maxUses) || maxUses < 0 || maxUses > MAX_INVITE_USES) throw new SignupError(400, 'Invalid maxUses');
  const code = newInviteCode();
  await db.run(
    'INSERT INTO app_invites (code, creator_id, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?)',
    [code, creatorId, now(), maxAge ? now() + maxAge : null, maxUses || null]
  );
  return db.get(`${INVITE_SELECT} WHERE i.code = ?`, [code]);
}

const revokeInvite = (code) => db.run('DELETE FROM app_invites WHERE code = ?', [code]);

// Accounts waiting for approval, oldest first.
const listRequests = () => db.all(
  'SELECT id, username, display_name, account_created FROM users WHERE pending = 1 AND deleted_at IS NULL ORDER BY account_created, id'
);

async function adminIds() {
  return (await db.all('SELECT id FROM users WHERE is_admin = 1 AND deleted_at IS NULL')).map((r) => r.id);
}

// Admins' open apps update their list of requests (and its count).
async function announceRequests() {
  const count = (await db.get('SELECT COUNT(*) AS n FROM users WHERE pending = 1 AND deleted_at IS NULL')).n;
  for (const id of await adminIds()) sendToUserSockets(id, { type: 'signup_requests', count });
  await adminAlerts.announce();
}

// Resolves to false if `userId` isn't waiting.
async function approve(userId) {
  const { changes } = await db.run('UPDATE users SET pending = 0 WHERE id = ? AND pending = 1 AND deleted_at IS NULL', [userId]);
  if (!changes) return false;
  // Their open app carries on as logged in.
  approvePendingSockets(userId);
  await announceRequests();
  return true;
}

// Removes a pending account (declined, or deleted by its owner): nothing of it is kept.
// Resolves to false if `userId` isn't waiting.
async function removePending(userId) {
  const user = await db.get('SELECT username FROM users WHERE id = ? AND pending = 1 AND deleted_at IS NULL', [userId]);
  if (!user) return false;
  await db.transaction(async () => {
    for (const sql of [
      'DELETE FROM sessions WHERE user_id = ?',
      'DELETE FROM push_subscriptions WHERE user_id = ?',
    ]) {
      await db.run(sql, [userId]);
    }
    await db.run('DELETE FROM login_states WHERE username = ?', [user.username]);
    await db.run('DELETE FROM users WHERE id = ?', [userId]);
  });
  closePendingSockets(userId);
  await announceRequests();
  return true;
}

module.exports = {
  MAX_INVITE_AGE, MAX_INVITE_USES, SignupError, signupMode, checkSignup, useInvite, listInvites, createInvite,
  revokeInvite, listRequests, announceRequests, approve, removePending,
};
