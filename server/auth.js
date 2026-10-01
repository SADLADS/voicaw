const jwt = require('jsonwebtoken');
const { jwtSecret } = require('./config');
const db = require('./db');

// Logins last 30 days from when the token was made, and keep going while the app is used:
// any authenticated request with a token older than a day gets a new one back in the
// `X-Voicaw-Token` header (the client stores it, utils/api.js). So only a device left
// unused for a month has to log in again. The payload is just who the user is.
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const RENEW_AFTER_SECONDS = 24 * 60 * 60;
const RENEWED_TOKEN_HEADER = 'X-Voicaw-Token';

function generateToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, jwtSecret, { expiresIn: SESSION_SECONDS });
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
  if (Date.now() / 1000 - user.iat > RENEW_AFTER_SECONDS) {
    res.set(RENEWED_TOKEN_HEADER, generateToken(user));
  }
  req.user = user;
  next();
}

module.exports = { generateToken, verifyToken, authenticateJWT, SESSION_SECONDS, RENEW_AFTER_SECONDS, RENEWED_TOKEN_HEADER };
