const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
require('dotenv').config();

const db = require('./db');
const app = express();
app.use(express.json());

const cors = require('cors');

const allowedOrigins = ['https://test.voicaw.com', 'https://voicaw.com'];

app.use(cors({
  origin: function(origin, callback){
    if (!origin) return callback(null, true); // Allow non-browser tools like Postman or curl
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));


const saltRounds = 10;

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });

  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    bcrypt.compare(password, user.password, (err, result) => {
      if (err) return res.status(500).json({ error: 'Error checking password' });
      if (!result) return res.status(401).json({ error: 'Invalid credentials' });

      // Login success: return minimal user info (or JWT/session if you add that)
      res.json({ id: user.id, username: user.username });
    });
  });
});

// Register route
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });

  bcrypt.hash(password, 10, (err, passwordHash) => {
    if (err) return res.status(500).json({ error: 'Error hashing password' });

    // Generate RSA keypair (2048 bits)
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    // Derive encryption key from password (PBKDF2)
    const salt = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(password, salt, 100_000, 32, 'sha256');

    // Encrypt private key using AES-256-GCM
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(privateKey, 'utf8'),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();

    // Store base64 encoded combined salt + iv + tag + encryptedPrivateKey
    const encryptedPrivateKey = Buffer.concat([salt, iv, tag, encrypted]).toString('base64');

    db.run(`INSERT INTO users (username, password, public_key, private_key) VALUES (?, ?, ?, ?)`,
      [username, passwordHash, publicKey, encryptedPrivateKey], function (err) {
        if (err) {
          if (err.message.includes('UNIQUE constraint failed')) {
            return res.status(409).json({ error: 'Username already exists' });
          }
          return res.status(500).json({ error: 'DB error' });
        }
        res.status(201).json({ id: this.lastID, username });
      });
  });
});

// Minimal protected route example
app.get('/api/profile', (req, res) => {
  // No real auth yet, so just send dummy response
  res.json({ message: 'Logged in successfully!' });
});

const PORT = process.env.PORT || 3000;
console.log(PORT)
app.listen(PORT, (err) => {
  if (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
  console.log(`Server running on port ${PORT}`);
});
