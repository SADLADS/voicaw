const express = require('express');
const { authenticateJWT } = require('../auth');
const { inboxFor } = require('../inbox');

// The desktop app's inbox (inbox.js): what notified you lately, newest first,
// [{ id, unread, payload }] with `payload` as its push's.
const router = express.Router();

router.get('/inbox', authenticateJWT, async (req, res) => {
  res.json(await inboxFor(req.user.id));
});

module.exports = router;
