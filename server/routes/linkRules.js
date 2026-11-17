const express = require('express');
const { authenticateJWT } = require('../auth');
const { getSetting } = require('../appSettings');
const { getLinkRules } = require('../linkRules');

// The tracking parameter list for "Remove tracking from pasted links" (linkRules.js):
// { enabled: false } when Settings → Admin turned it off, { enabled: true, list: null } before
// the first download, { enabled: true, etag, unchanged: true } when `have` is the etag the app
// already has, else { enabled: true, etag, list }.
const router = express.Router();

router.get('/link-rules', authenticateJWT, async (req, res) => {
  if ((await getSetting('linkRules')) === 'off') return res.json({ enabled: false });
  const current = await getLinkRules();
  if (!current) return res.json({ enabled: true, list: null });
  if (req.query.have === current.etag) return res.json({ enabled: true, etag: current.etag, unchanged: true });
  res.json({ enabled: true, etag: current.etag, list: current.list });
});

module.exports = router;
