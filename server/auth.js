const jwt = require('jsonwebtoken');
const { jwtSecret } = require('./config');

// Logins last a day. The payload is just who the user is.
function generateToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, jwtSecret, { expiresIn: '1d' });
}

// Resolves to the token's user ({ id, username }), or null if it isn't valid.
function verifyToken(token) {
  return new Promise((resolve) => {
    jwt.verify(token, jwtSecret, (err, user) => resolve(err ? null : user));
  });
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
