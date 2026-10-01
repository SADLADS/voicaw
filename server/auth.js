const jwt = require('jsonwebtoken');
const { jwtSecret } = require('./config');
const db = require('./db');

// Logins last a day. The payload is just who the user is.
function generateToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, jwtSecret, { expiresIn: '1d' });
}

// Resolves to the token's user ({ id, username }), or null if it isn't valid (or the account
// has been deleted since).
async function verifyToken(token) {
  const user = await new Promise((resolve) => {
    jwt.verify(token, jwtSecret, (err, payload) => resolve(err ? null : payload));
  });
  if (!user) return null;
  const row = await db.get('SELECT deleted_at FROM users WHERE id = ?', [user.id]);
  return row && !row.deleted_at ? user : null;
}

// Express middleware for routes that need a logged-in user (`req.user`).
async function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const user = await verifyToken(authHeader.split(' ')[1]);
  if (!user) return res.status(403).json({ error: 'Invalid token' });
  req.user = user;
  next();
}

module.exports = { generateToken, verifyToken, authenticateJWT };
