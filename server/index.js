const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const WebSocket = require('ws');

require('dotenv').config();

const db = require('./db');
const app = express();
app.use(express.json());

const cors = require('cors');

const allowedOrigins = ['https://test.voicaw.com', 'https://voicaw.com'];

const saltRounds = 10;

app.use(cors({
  origin: function(origin, callback){
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(session({
  store: new SQLiteStore({
    db: 'sessions.sqlite',
  }),
  secret: process.env.SESSION_SECRET || 'defaultsecretkey',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24,
  }
}));

const PORT = process.env.PORT || 3000;
console.log(PORT)
const server = app.listen(PORT, (err) => {
  if (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
  console.log(`Server running on port ${PORT}`);
});

const wss = new WebSocket.Server({ server });

const clients = new Map();


app.post('/api/login', (req, res) => {
  console.log("login")
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });

  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    bcrypt.compare(password, user.password, (err, result) => {
      if (err) return res.status(500).json({ error: 'Error checking password' });
      if (!result) return res.status(401).json({ error: 'Invalid credentials' });
      req.session.user = { id: user.id, username: user.username };

      res.json({ id: user.id, username: user.username });
    });
  });
});

// Register route
app.post('/api/register', (req, res) => {
  console.log("register")
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
  if (req.session.user) {
    res.json({ user: req.session.user });
  } else {
    res.json({ user: null });
  }
});



app.get('/api/dms-list', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });

  const loggedInUserId = req.session.user.id;
  getRecentDmsForUser(loggedInUserId, (err, users) => {
    if (err) {
      console.error("Failed to fetch recent DMs:", err);
      return res.status(500).json({ error: 'Server error' });
    }

    res.json(users);
  });
});

app.get('/api/dm-messages/:otherUserId', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });

  const loggedInUserId = req.session.user.id;
  const otherUserId = parseInt(req.params.otherUserId, 10);
  if (isNaN(otherUserId)) return res.status(400).json({ error: 'Invalid user ID' });

  db.all(
    `SELECT id, sender_id, recipient_id, content, timestamp
     FROM direct_messages
     WHERE
       (sender_id = ? AND recipient_id = ?)
       OR
       (sender_id = ? AND recipient_id = ?)
     ORDER BY timestamp ASC`,
    [loggedInUserId, otherUserId, otherUserId, loggedInUserId],
    (err, rows) => {
      if (err) {
        console.error('Failed to fetch DM messages:', err);
        return res.status(500).json({ error: 'Server error' });
      }
      res.json(rows);
    }
  );
});

app.post('/api/dm-send', async (req, res) => {
  console.log("dm-send!");
  const sender_id = req.session.user?.id;
  const { recipient_id, content } = req.body;

  if (!sender_id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!recipient_id || !content || !content.trim()) {
    return res.status(400).json({ error: 'Missing recipient or content' });
  }

  try {
    db.run(
      `INSERT INTO direct_messages (sender_id, recipient_id, content, timestamp)
       VALUES (?, ?, ?, strftime('%s','now'))`,
      [sender_id, recipient_id, content.trim()],
      function (err) {
        if (err) {
          console.error('Failed to insert DM:', err);
          return res.status(500).json({ error: 'Failed to send message' });
        }

        const insertedId = this.lastID;

        // Fetch the inserted message to return it
        db.get(
          `SELECT id, sender_id, recipient_id, content, timestamp FROM direct_messages WHERE id = ?`,
          [insertedId],
          (err, message) => {
            if (err) {
              console.error('Failed to fetch inserted DM:', err);
              return res.status(500).json({ error: 'Failed to send message' });
            }

            // Notify recipient - just console.log for now
            console.log(`User ${recipient_id} received a new DM from user ${sender_id}: "${content.trim()}"`);
            const recipientSocket = clients.get(recipient_id.toString());

            console.log('Clients keys:', [...clients.keys()]);
            console.log('Recipient ID:', recipient_id);
            console.log(recipientSocket)
            console.log(clients)
            if (recipientSocket && recipientSocket.readyState === WebSocket.OPEN) {
              console.log("socket is open")
              recipientSocket.send(JSON.stringify({
                type: 'new_dm',
                message: message, // the inserted DM
              }));
            }

            res.status(201).json(message);
          }
        );
      }
    );
  } catch (err) {
    console.error('Failed to insert DM:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.clearCookie('connect.sid', { domain: '.voicaw.com', path: '/' });
    res.json({ message: 'Logged out' });
  });
});





// FUNCTIONS

function getRecentDmsForUser(loggedInUserId, callback) {
  db.all(
    `
    SELECT u.id, u.username,
           MAX(m.timestamp) as last_timestamp
    FROM users u
    LEFT JOIN direct_messages m
      ON (
        (m.sender_id = ? AND m.recipient_id = u.id)
        OR
        (m.recipient_id = ? AND m.sender_id = u.id)
      )
    GROUP BY u.id
    ORDER BY last_timestamp DESC NULLS LAST, u.id = ? DESC
    `,
    [loggedInUserId, loggedInUserId, loggedInUserId],
    (err, rows) => {
      if (err) return callback(err);
      callback(null, rows);
    }
  );
}




// WEBSOCKETS

wss.on('connection', (ws) => {
  console.log('New connection');

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'identify') {
        const { userId } = data;
        console.log(`User identified as ${userId}`);
        clients.set(userId, ws);

        ws.on('close', (code, reason) => {
          console.log(`WebSocket closed for user ${userId}. Code: ${code}, Reason: ${reason.toString()}`);
          clients.delete(userId);
        });

        ws.on('error', (error) => {
          console.error(`WebSocket error for user ${userId}:`, error);
        });
      }
    } catch (err) {
      console.error('Invalid message', err);
    }
  });

  // Also add error and close handlers outside identify, for any socket (if identify not yet received)
  ws.on('close', (code, reason) => {
    console.log(`WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});
