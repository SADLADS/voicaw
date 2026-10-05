const express = require('express');
const db = require('../db');
const { authenticatePending } = require('../auth');
const { listSessions, endSessions } = require('../sessions');

// Where you're logged in (Settings → Devices), and logging out: this device, another one, or
// every other one.
const router = express.Router();

router.get('/sessions', authenticatePending, async (req, res) => {
  res.json(await listSessions(req.user.id, req.user.sid));
});

// Every session but this one.
router.delete('/sessions', authenticatePending, async (req, res) => {
  const rows = await db.all('SELECT id FROM sessions WHERE user_id = ? AND id != ?', [req.user.id, req.user.sid]);
  await endSessions(req.user.id, rows.map((r) => r.id));
  res.json(await listSessions(req.user.id, req.user.sid));
});

router.delete('/sessions/:id', authenticatePending, async (req, res) => {
  const row = await db.get('SELECT id FROM sessions WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ error: 'Session not found' });
  await endSessions(req.user.id, [row.id]);
  res.json(await listSessions(req.user.id, req.user.sid));
});

// Logging out on this device: its token stops working.
router.post('/logout', authenticatePending, async (req, res) => {
  await endSessions(req.user.id, [req.user.sid], { fromSettings: false });
  res.json({ ok: true });
});

module.exports = router;
