const express = require('express');
const { getImage } = require('../activities');

const router = express.Router();

// A game's picture for an activity (activities.js), by the hash of its bytes. No login: <img>
// can't send one, and a hash says nothing about who plays it (as Discord's app assets).
router.get('/activity-images/:id', (req, res) => {
  const image = /^[0-9a-f]{32}$/.test(req.params.id) ? getImage(req.params.id) : null;
  if (!image) return res.status(404).end();
  res.set({ 'Content-Type': image.type, 'Cache-Control': 'public, max-age=86400, immutable', 'X-Content-Type-Options': 'nosniff' });
  res.send(image.data);
});

module.exports = router;
