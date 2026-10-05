// Global admin panel (the client's Settings → Admin): app-wide settings (appSettings.js), who
// else is an admin, and sign-ups (signups.js): accounts waiting for approval and app invites. Admins are users with users.is_admin = 1; the first one is made with
// `npm run admin -- <username>` in server/ (scripts/admin.js).
const express = require('express');
const db = require('../db');
const { findUserByName } = require('../usernames');
const { authenticateJWT } = require('../auth');
const { SETTINGS, MAX_VALUE_LENGTH, setSetting, isValidValue, describeSettings } = require('../appSettings');
const signups = require('../signups');

const router = express.Router();

async function isAdmin(userId) {
  const row = await db.get('SELECT is_admin FROM users WHERE id = ?', [userId]);
  return Boolean(row?.is_admin);
}

// After authenticateJWT. Non-admins get 403 (the client hides the panel on that).
async function requireAdmin(req, res, next) {
  if (!(await isAdmin(req.user.id))) return res.status(403).json({ error: 'Admins only' });
  next();
}

const admin = [authenticateJWT, requireAdmin];

async function listAdmins() {
  return db.all('SELECT id, username FROM users WHERE is_admin = 1 ORDER BY username COLLATE NOCASE');
}

router.get('/admin', admin, async (req, res) => {
  res.json({
    settings: await describeSettings(),
    admins: await listAdmins(),
    requests: await signups.listRequests(),
    invites: await signups.listInvites(),
  });
});

// { value }: a string sets it; null or '' clears it (back to the .env value).
router.put('/admin/settings/:key', admin, async (req, res) => {
  const { key } = req.params;
  if (!Object.hasOwn(SETTINGS, key)) return res.status(404).json({ error: 'No such setting' });
  let { value } = req.body ?? {};
  if (value != null && typeof value !== 'string') return res.status(400).json({ error: 'value must be a string' });
  value = value?.trim() ?? null;
  if (value && value.length > MAX_VALUE_LENGTH) return res.status(400).json({ error: 'Too long' });
  if (value && !isValidValue(key, value)) return res.status(400).json({ error: 'Not one of the choices' });
  await setSetting(key, value, req.user.id);
  res.json({ settings: await describeSettings() });
});

router.post('/admin/admins', admin, async (req, res) => {
  const { username } = req.body ?? {};
  if (typeof username !== 'string' || !username.trim()) return res.status(400).json({ error: 'Missing username' });
  const user = await findUserByName(username.trim(), 'id, pending');
  if (!user) return res.status(404).json({ error: 'No user with that name' });
  if (user.pending) return res.status(400).json({ error: 'Approve their account first' });
  await db.run('UPDATE users SET is_admin = 1 WHERE id = ?', [user.id]);
  res.json({ admins: await listAdmins() });
});

// You can't remove yourself, so there's always at least one admin.
router.delete('/admin/admins/:id', admin, async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "You can't remove yourself" });
  await db.run('UPDATE users SET is_admin = 0 WHERE id = ?', [id]);
  res.json({ admins: await listAdmins() });
});

// Sign-ups waiting for approval: approve, or decline (the account is removed).
router.post('/admin/requests/:id/approve', admin, async (req, res) => {
  if (!(await signups.approve(Number(req.params.id)))) return res.status(404).json({ error: 'No such request' });
  res.json({ requests: await signups.listRequests() });
});

router.delete('/admin/requests/:id', admin, async (req, res) => {
  if (!(await signups.removePending(Number(req.params.id)))) return res.status(404).json({ error: 'No such request' });
  res.json({ requests: await signups.listRequests() });
});

// App invites: { maxAge, maxUses } (seconds and uses; 0 or missing = no limit).
router.post('/admin/invites', admin, async (req, res) => {
  try {
    const invite = await signups.createInvite(req.user.id, {
      maxAge: Number(req.body?.maxAge ?? 0), maxUses: Number(req.body?.maxUses ?? 0),
    });
    res.status(201).json({ invite, invites: await signups.listInvites() });
  } catch (err) {
    if (err instanceof signups.SignupError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.delete('/admin/invites/:code', admin, async (req, res) => {
  await signups.revokeInvite(req.params.code);
  res.json({ invites: await signups.listInvites() });
});

module.exports = router;
