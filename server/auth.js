const express = require('express');
const router = express.Router();

router.post('/login', (req, res) => {
  // login logic
  res.json({ message: 'logged in' });
});

module.exports = router;
