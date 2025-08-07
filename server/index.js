const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

require('dotenv').config();

const db = require('./db');
const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
app.use(express.json());

const cors = require('cors');

const allowedOrigins = ['https://test.voicaw.com', 'https://voicaw.com'];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

const PORT = process.env.PORT || 3000;
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
      const token = generateToken(user);
      res.json({ token, id: user.id, username: user.username });

    });
  });
});

// Register route
app.post('/api/register', (req, res) => {
  console.log("register");
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

        // Generate JWT with new user info
        const user = { id: this.lastID, username };
        const token = generateToken(user);

        // Return token and user info
        res.status(201).json({ token, id: user.id, username: user.username });
      });
  });
});

// Minimal protected route example
app.get('/api/profile', authenticateJWT, (req, res) => {
  if (req.user) {
    res.json({ user: req.user });
  } else {
    res.json({ user: null });
  }
});

app.get('/api/dms-list', authenticateJWT, (req, res) => {
  const loggedInUserId = req.user.id;

  getRecentDmsForUser(loggedInUserId, (err, users) => {
    if (err) {
      console.error("Failed to fetch recent DMs:", err);
      return res.status(500).json({ error: 'Server error' });
    }

    res.json(users);
  });
});


app.get('/api/dm-messages/:otherUserId', authenticateJWT, (req, res) => {
  const loggedInUserId = req.user.id;
  const otherUserId = parseInt(req.params.otherUserId, 10);
  const beforeId = req.query.before;
  const params = [loggedInUserId, otherUserId, otherUserId, loggedInUserId];
  const limit = 20;
  if (isNaN(otherUserId)) return res.status(400).json({ error: 'Invalid user ID' });
  var query = `
    SELECT dm.id, dm.sender_id, dm.recipient_id, dm.content, dm.timestamp, u.username AS sender_username
    FROM direct_messages dm
    JOIN users u ON dm.sender_id = u.id
    WHERE
      (dm.sender_id = ? AND dm.recipient_id = ?)
      OR
      (dm.sender_id = ? AND dm.recipient_id = ?)
  `

  if (beforeId){
    query += `AND dm.id < ?`
    params.push(beforeId)
  }

  query += `
  ORDER BY dm.id DESC
  LIMIT ?
  `
  params.push(limit)

  db.all(query
    ,
    params,
    (err, rows) => {
      if (err) {
        console.error('Failed to fetch DM messages:', err);
        return res.status(500).json({ error: 'Server error' });
      }
      res.json(rows.reverse());
    }
  );
});

app.post('/api/dm-send', authenticateJWT, async (req, res) => {
  console.log("dm-send!");
  const sender_id = req.user?.id;
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
          `
          SELECT 
            dm.id, 
            dm.sender_id, 
            dm.recipient_id, 
            dm.content, 
            dm.timestamp,
            u.username AS sender_username
          FROM direct_messages dm
          JOIN users u ON dm.sender_id = u.id
          WHERE dm.id = ?
          `,
          [insertedId],
          (err, message) => {
            if (err) {
              console.error('Failed to fetch inserted DM:', err);
              return res.status(500).json({ error: 'Failed to send message' });
            }

            console.log(`User ${message.recipient_id} received a new DM from ${message.sender_name}: "${message.content.trim()}"`);

            db.run(
              `
              INSERT INTO dm_unread (user_id, from_user_id, count)
              VALUES (?, ?, 1)
              ON CONFLICT(user_id, from_user_id)
              DO UPDATE SET count = count + 1
              `,
              [message.recipient_id, message.sender_id],
              (err) => {
                if (err) {
                  console.error('Failed to update unread count:', err);
                }
              }
            );

            const recipientSocket = clients.get(message.recipient_id.toString());

            if (recipientSocket && recipientSocket.readyState === WebSocket.OPEN) {
              recipientSocket.send(JSON.stringify({
                type: 'new_dm',
                message: message,
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


app.post('/api/dm-mark-read/:fromUserId', authenticateJWT, (req, res) => {
  console.log(`attempt to mark read`);
  const userId = req.user?.id;
  const fromUserId = parseInt(req.params.fromUserId, 10);

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (isNaN(fromUserId)) {
    return res.status(400).json({ error: 'Invalid fromUserId' });
  }

  db.run(
    `DELETE FROM dm_unread WHERE user_id = ? AND from_user_id = ?`,
    [userId, fromUserId],
    function (err) {
      if (err) {
        console.error('Failed to mark messages as read:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      console.log(`Marked DMs from user ${fromUserId} as read for user ${userId}`);
      res.json({ success: true });
    }
  );
});

app.get('/api/dm-get-unread/', authenticateJWT, (req, res) => {
  console.log(`attempt to get unread`);
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  db.all(
    `SELECT * FROM dm_unread WHERE user_id = ?`,
    [userId],
    (err, rows) => {
      if (err) {
        console.error('Failed to fetch unread messages:', err);
        return res.status(500).json({ error: 'Server error' });
      }
      res.json(rows);
    }
  );
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

function generateToken(user) {
  // Payload can contain minimal user info
  const payload = {
    id: user.id,
    username: user.username,
  };
  // Token expires in 1 day
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1d' });
}


function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.split(' ')[1];

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

// WEBSOCKETS
function noop() { }
function heartbeat() {
  this.isAlive = true;
}

// -- Set up WebSocket Server --
wss.on('connection', (ws) => {
  // console.log('New connection');

  ws.isAlive = true;
  ws.on('pong', heartbeat);

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'identify') {
        const token = data.token;
        jwt.verify(token, JWT_SECRET, (err, user) => {
          if (err) {
            ws.close(1008, 'Invalid token'); // Policy Violation
            return;
          }
          clients.set(user.id.toString(), ws);
          ws.userId = user.id.toString();
          console.log(`User identified as ${user.id}`);
        });
      }
    } catch (err) {
      console.error('Invalid message', err);
    }
  });


  ws.on('close', (code, reason) => {
    const id = ws.userId || 'unknown';
    // console.log(`WebSocket closed for user ${id}. Code: ${code}, Reason: ${reason?.toString() || 'No reason'}`);
    clients.delete(id);
  });

  ws.on('error', (err) => {
    const id = ws.userId || 'unknown';
    console.error(`WebSocket error for user ${id}:`, err);
  });
});

// -- Global heartbeat check every 30s --
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.warn('Terminating stale connection');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping(noop);
  });
}, 30000);

// Optional: Clean up interval when server shuts down
wss.on('close', () => {
  clearInterval(interval);
});