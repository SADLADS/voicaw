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
//   A valid invite skips the wait. The form asks why they want to join (`signupReason`:
//   optional or required), kept with the request (signup_requests) for admins to read.
//   Declining removes the account altogether (it can't have written anything), so the name is
//   free again; the request stays in the history (name, reason, who decided) for a year, as
//   approved ones do.
// Accounts from before (and every account made while sign-ups are open) are approved.

const MAX_INVITE_AGE = 30 * 24 * 60 * 60;
const MAX_REASON = 1000;
// Decided requests are forgotten this long after the decision.
const HISTORY_SECONDS = 365 * 24 * 60 * 60;
const HISTORY_PAGE = 50;
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

// Whether someone may sign up now, with `invite` (a code, optional) and `reason` (why they want
// to join, for a request): resolves to { pending, invite (the code to use up), reason (kept
// with a request, else null) }, or throws a SignupError. In open mode an invite is ignored.
async function checkSignup(invite, reason) {
  const mode = await signupMode();
  if (mode === 'open') return { pending: false, invite: null, reason: null };
  const hasCode = typeof invite === 'string' && invite.trim() !== '';
  const valid = hasCode ? await validInvite(invite.trim()) : null;
  if (hasCode && !valid) throw new SignupError(403, 'That invite is invalid or has expired', 'invalid_invite');
  if (mode === 'invite' && !valid) throw new SignupError(403, 'Signing up needs an invite', 'invite_required');
  if (valid) return { pending: false, invite: valid.code, reason: null };
  if (reason != null && typeof reason !== 'string') throw new SignupError(400, 'Invalid reason');
  const text = reason?.trim() || null;
  if (text && text.length > MAX_REASON) {
    throw new SignupError(400, `Your reason can be up to ${MAX_REASON} characters`, 'reason_too_long');
  }
  if (!text && (await getSetting('signupReason')) === 'required') {
    throw new SignupError(400, 'Tell us why you want to join', 'reason_required');
  }
  return { pending: true, invite: null, reason: text };
}

// Inside the transaction that makes a pending account: its request.
const addRequest = (user, reason) => db.run(
  'INSERT INTO signup_requests (user_id, username, display_name, reason, requested_at) VALUES (?, ?, ?, ?, ?)',
  [user.id, user.username, user.display_name ?? null, reason ?? null, now()]
);

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

// Accounts waiting for approval, oldest first, with why they want to join.
const listRequests = () => db.all(
  `SELECT u.id, u.username, u.display_name, u.account_created, r.reason
   FROM users u LEFT JOIN signup_requests r ON r.user_id = u.id AND r.status = 'waiting'
   WHERE u.pending = 1 AND u.deleted_at IS NULL ORDER BY u.account_created, u.id`
);

// Decided requests, newest decision first, a page at a time: `before` is the last row's
// { decided_at, id } from the page before. Resolves to { history, more }.
async function listHistory(before = null) {
  await pruneHistory();
  const rows = await db.all(
    `SELECT r.id, r.user_id, r.username, r.display_name, r.reason, r.requested_at, r.status, r.decided_at,
       r.decided_by, a.username AS decided_by_username
     FROM signup_requests r LEFT JOIN users a ON a.id = r.decided_by
     WHERE r.status != 'waiting' ${before ? 'AND (r.decided_at < ? OR (r.decided_at = ? AND r.id < ?))' : ''}
     ORDER BY r.decided_at DESC, r.id DESC LIMIT ?`,
    before ? [before.decided_at, before.decided_at, before.id, HISTORY_PAGE + 1] : [HISTORY_PAGE + 1]
  );
  return { history: rows.slice(0, HISTORY_PAGE), more: rows.length > HISTORY_PAGE };
}

// Resolves to false if there's no such decided request.
async function deleteHistoryEntry(id) {
  const { changes } = await db.run("DELETE FROM signup_requests WHERE id = ? AND status != 'waiting'", [id]);
  return changes > 0;
}

// Forgets decisions over a year old.
async function pruneHistory(at = now()) {
  const { changes } = await db.run(
    "DELETE FROM signup_requests WHERE status != 'waiting' AND decided_at < ?", [at - HISTORY_SECONDS]
  );
  return changes;
}

async function adminIds() {
  return (await db.all('SELECT id FROM users WHERE is_admin = 1 AND deleted_at IS NULL')).map((r) => r.id);
}

// Admins' open apps update their list of requests (and its count).
async function announceRequests() {
  const count = (await db.get('SELECT COUNT(*) AS n FROM users WHERE pending = 1 AND deleted_at IS NULL')).n;
  for (const id of await adminIds()) sendToUserSockets(id, { type: 'signup_requests', count });
  await adminAlerts.announce();
}

// `adminId` approves `userId`'s request. Resolves to false if `userId` isn't waiting.
async function approve(userId, adminId) {
  let changes;
  await db.transaction(async () => {
    ({ changes } = await db.run('UPDATE users SET pending = 0 WHERE id = ? AND pending = 1 AND deleted_at IS NULL', [userId]));
    if (changes) await decide(userId, 'approved', adminId);
  });
  if (!changes) return false;
  // Their open app carries on as logged in.
  approvePendingSockets(userId);
  await announceRequests();
  return true;
}

// The request's decision, inside the transaction that carries it out.
const decide = (userId, status, adminId) => db.run(
  `UPDATE signup_requests SET status = ?, decided_at = ?, decided_by = ?, user_id = ?
   WHERE user_id = ? AND status = 'waiting'`,
  [status, now(), adminId, status === 'approved' ? userId : null, userId]
);

// Removes a pending account: declined by admin `adminId` (its request stays in the history),
// or withdrawn by its owner (no `adminId`: nothing of it is kept). Resolves to false if
// `userId` isn't waiting.
async function removePending(userId, adminId = null) {
  const user = await db.get('SELECT username FROM users WHERE id = ? AND pending = 1 AND deleted_at IS NULL', [userId]);
  if (!user) return false;
  await db.transaction(async () => {
    if (adminId != null) await decide(userId, 'declined', adminId);
    else await db.run('DELETE FROM signup_requests WHERE user_id = ?', [userId]);
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

// Forgets old decisions now and then (started by index.js).
function startHistoryPrune() {
  const prune = () => pruneHistory().catch((err) => console.error('Sign-up history cleanup failed:', err.message));
  prune();
  return setInterval(prune, 24 * 60 * 60 * 1000).unref();
}

module.exports = {
  MAX_INVITE_AGE, MAX_INVITE_USES, MAX_REASON, HISTORY_SECONDS, SignupError, signupMode, checkSignup, addRequest,
  useInvite, listInvites, createInvite, revokeInvite, listRequests, listHistory, deleteHistoryEntry, pruneHistory,
  announceRequests, approve, removePending, startHistoryPrune,
};
