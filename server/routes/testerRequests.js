// The Android app's closed test on Google Play: people ask to join on voicaw.com (website/
// src/index.html's form, no account needed) with their Google account's email; admins see the
// requests in Settings → Admin, add the emails to Play's tester list by hand (the Play Console),
// mark them added, and delete them when done. Nothing is sent to anyone: Play itself lets the
// tester in once their email is on the list.
const express = require('express');
const db = require('../db');
const { rateLimitsEnabled } = require('../config');
const { createLimiter, tooManyAttempts } = require('../rateLimit');
const { sendToUserSockets } = require('../sockets');
const { admin } = require('./admin');
const adminAlerts = require('../adminAlerts');

const router = express.Router();

const MAX_EMAIL = 254;
const MAX_NAME = 100;
const MAX_NOTE = 500;
// Beyond this many waiting, new requests are refused (the form is open to anyone).
const MAX_WAITING = 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const perIp = createLimiter({ windowMs: 60 * 60 * 1000, max: 5 });

const now = () => Math.floor(Date.now() / 1000);

function text(value, max) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > max ? undefined : trimmed || null;
}

const listRequests = () => db.all(
  'SELECT id, email, name, note, created_at, added_at FROM tester_requests ORDER BY added_at IS NOT NULL, created_at, id'
);

// Admins' open Settings → Admin reload the list.
async function announce() {
  const rows = await db.all('SELECT id FROM users WHERE is_admin = 1 AND deleted_at IS NULL');
  for (const { id } of rows) sendToUserSockets(id, { type: 'tester_requests' });
  await adminAlerts.announce();
}

// { email, name?, note?, website? } from voicaw.com. `website` is a field people don't see:
// a bot that fills it in is told it worked, and nothing is kept. Asking again with the same
// email updates the name and note (and says nothing about whether it was already there).
router.post('/tester-requests', async (req, res) => {
  if (rateLimitsEnabled) {
    const { allowed, retryAfterMs } = perIp.hit(req.ip);
    if (!allowed) return tooManyAttempts(res, retryAfterMs);
  }
  const body = req.body ?? {};
  if (body.website) return res.status(201).json({ ok: true });
  const email = text(body.email, MAX_EMAIL)?.toLowerCase();
  if (!email || !EMAIL.test(email)) return res.status(400).json({ error: 'Enter the email address of your Google account.' });
  const name = text(body.name, MAX_NAME);
  const note = text(body.note, MAX_NOTE);
  if (name === undefined) return res.status(400).json({ error: `Your name can be up to ${MAX_NAME} characters.` });
  if (note === undefined) return res.status(400).json({ error: `The note can be up to ${MAX_NOTE} characters.` });

  const existing = await db.get('SELECT id FROM tester_requests WHERE email = ?', [email]);
  if (existing) {
    await db.run('UPDATE tester_requests SET name = ?, note = ? WHERE id = ?', [name, note, existing.id]);
  } else {
    const { n } = await db.get('SELECT COUNT(*) AS n FROM tester_requests WHERE added_at IS NULL');
    if (n >= MAX_WAITING) return res.status(503).json({ error: "We aren't taking more requests right now. Try again later." });
    await db.run('INSERT INTO tester_requests (email, name, note, created_at) VALUES (?, ?, ?, ?)', [email, name, note, now()]);
    adminAlerts.notify('tester');
  }
  await announce();
  res.status(201).json({ ok: true });
});

router.get('/admin/tester-requests', admin, async (req, res) => {
  res.json({ testers: await listRequests() });
});

// { added: true | false }: on Play's tester list now (or not after all).
router.put('/admin/tester-requests/:id', admin, async (req, res) => {
  const added = req.body?.added;
  if (typeof added !== 'boolean') return res.status(400).json({ error: 'added must be true or false' });
  const { changes } = await db.run('UPDATE tester_requests SET added_at = ? WHERE id = ?', [added ? now() : null, Number(req.params.id)]);
  if (!changes) return res.status(404).json({ error: 'No such request' });
  await announce();
  res.json({ testers: await listRequests() });
});

router.delete('/admin/tester-requests/:id', admin, async (req, res) => {
  const { changes } = await db.run('DELETE FROM tester_requests WHERE id = ?', [Number(req.params.id)]);
  if (!changes) return res.status(404).json({ error: 'No such request' });
  await announce();
  res.json({ testers: await listRequests() });
});

module.exports = router;
