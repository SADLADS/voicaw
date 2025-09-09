const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const opaque = require('@serenity-kit/opaque');
const db = require('./db');
const cors = require('cors');
const webpush = require('web-push');
const emojiData = require('unicode-emoji-json');
const { v4: uuidv4 } = require('uuid');

require('dotenv').config();

const requiredEnvVars = [
  'JWT_SECRET',
  'OPAQUE_SERVER_SETUP',
  'VAPID_EMAIL',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'S3_ENDPOINT',
  'S3_ROOT_USER',
  'S3_ROOT_PASSWORD'
];

const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error('FATAL ERROR: Missing required environment variables:');
  console.error(`- ${missingEnvVars.join('\n- ')}`);
  console.error('Please create a .env file or set these variables in your environment before starting the server.');
  process.exit(1); // Exit with a failure code
}

console.log('All required environment variables are present.');

const { getUploadUrl, getDownloadUrl } = require("./s3");


webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const max_plaintext_length = parseInt(process.env.MAX_MESSAGE_LENGTH, 10) || 5000;
const max_message_length = getMaxEncryptedLength(max_plaintext_length);

console.log(`Max plaintext length: ${max_plaintext_length}`);
console.log(`Max encrypted Base64 length: ${max_message_length}`);


function seedEmojisIfNeeded() {
  db.get("SELECT COUNT(*) as count FROM emojis", (err, row) => {
    if (err) {
      console.error("Error checking emoji table:", err);
      return;
    }

    if (row.count === 0) {
      console.log("No emojis found, seeding database...");

      db.serialize(() => {
        db.run("BEGIN TRANSACTION");

        const stmt = db.prepare(
          "INSERT OR IGNORE INTO emojis (name, unicode, is_custom) VALUES (?, ?, 0)"
        );

        const entries = Object.entries(emojiData);

        entries.forEach(([char, data]) => {
          const slug = data.slug || data.name.replace(/\s+/g, "_").toLowerCase();
          stmt.run(slug, char, function (err) {
            if (err) {
              console.error("Insert error:", slug, char, err);
            }
          });
        });

        stmt.finalize(err => {
          if (err) {
            console.error("Error finalizing statement:", err);
          } else {
            db.run("COMMIT", commitErr => {
              if (commitErr) {
                console.error("Error committing transaction:", commitErr);
              } else {
                console.log(`Seeded ${entries.length} Unicode emojis.`);
              }
            });
          }
        });
      });
    } else {
      console.log(`Emoji table already has ${row.count} entries, skipping seed.`);
    }
  });
}


seedEmojisIfNeeded();


const app = express();
const JWT_SECRET = process.env.JWT_SECRET;
app.use(express.json());


const allowedOrigins = ['https://test.voicaw.com', 'https://voicaw.com', "http://test.voicaw.com", "http://voicaw.com"];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error(`Origin ${origin} Not allowed by CORS`));
    }
  },
  credentials: true
}));


function errorHandler(err, req, res, next) {
  console.error('--- Unhandled Error ---');
  console.error(`Route: ${req.method} ${req.originalUrl}`);
  console.error(err.stack);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({ error: 'An internal server error occurred.' });
}

app.use(errorHandler);

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


let serverSetup;
(async () => {
  await opaque.ready;
  serverSetup = process.env.OPAQUE_SERVER_SETUP // || opaque.server.createSetup();
  console.log("Server setup created:", serverSetup);
})();


// Initial Login route
app.post('/api/initiatelogin', (req, res) => {
  const { clientLoginState, startLoginRequest, userIdentifier } = req.body;
  if (!clientLoginState || !startLoginRequest) return res.status(400).json({ error: 'Missing clientLoginState or startLoginRequest' });

  db.get('SELECT password FROM users WHERE username = ?', [userIdentifier], (err, user) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const registrationRecord = user.password;
    const { serverLoginState, loginResponse } = opaque.server.startLogin({
      serverSetup,
      userIdentifier,
      registrationRecord,
      startLoginRequest,
    });

    const expiresInSeconds = 300;
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + expiresInSeconds;

    db.run(`
    INSERT INTO login_states (username, server_login_state, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      server_login_state = excluded.server_login_state,
      expires_at = excluded.expires_at
  `,
      [userIdentifier, JSON.stringify(serverLoginState), expiresAt],
      function (err) {
        if (err) {
          console.error("Failed to store login state:", err);
          return res.status(500).json({ error: 'Internal server error' });
        }
        res.json({ loginResponse });
      });
  });
});


// Final Login route
app.post('/api/finaliselogin', (req, res) => {
  const { finishLoginRequest, clientSessionKey, userIdentifier } = req.body;
  console.log("finishLoginRequest", finishLoginRequest, clientSessionKey, userIdentifier)
  if (!finishLoginRequest || !clientSessionKey || !userIdentifier) return res.status(400).json({ error: 'Missing data' });
  db.get('SELECT * FROM login_states WHERE username = ?', [userIdentifier], (err, user) => { // maybe do a join with users table to get key data?
    if (err) return res.status(500).json({ error: 'DB error' });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    if (Math.floor(Date.now() / 1000) > user.expires_at) return res.status(401).json({ error: 'Login state expired' });

    const serverLoginState = JSON.parse(user.server_login_state);
    let sessionKey;
    try {
      ({ sessionKey } = opaque.server.finishLogin({
        finishLoginRequest,
        serverLoginState,
      }));
    } catch (e) {
      console.error("OPAQUE finishLogin error:", e);
      return res.status(401).json({ error: "Invalid credentials" });
    }
    if (!sessionKey || sessionKey !== clientSessionKey) {
      return res.status(401).json({ error: 'Login failed' });
    } else {
      // delete login state on successful login
      db.run(`DELETE FROM login_states WHERE username = ?`, [userIdentifier], (err) => {
        if (err) {
          console.error("Failed to delete login state:", err);
        }
      });
      db.get('SELECT id, private_key FROM users WHERE username = ?', [userIdentifier], (err, userKeyData) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        if (!userKeyData) return res.status(404).json({ error: 'User not found' });
        const { private_key } = userKeyData;
        const token = generateToken({ id: userKeyData.id, username: userIdentifier });
        console.log(userKeyData.id)
        const userId = userKeyData.id
        const vapidPubKey = process.env.VAPID_PUBLIC_KEY
        res.json({ token, id: userId, private_key, vapidPubKey, username: userIdentifier });
      });
    }
  });
});


// Initiate Register route
app.post('/api/initiateregister', (req, res) => {
  const { userIdentifier, registrationRequest } = req.body;
  // Check that all data is here
  if (!userIdentifier || !registrationRequest) return res.status(400).json({ error: 'Missing username or registrationRequest' });
  // generate registration response
  const { registrationResponse } = opaque.server.createRegistrationResponse({
    serverSetup,
    userIdentifier,
    registrationRequest,
  });
  return res.status(201).json({ registrationResponse });
});


// Register route
app.post('/api/finaliseregister', (req, res) => {
  const { registrationRecord, userIdentifier, publicKey, encryptedPrivateKey } = req.body;

  // Check that all data is here
  if (!userIdentifier || !registrationRecord) return res.status(400).json({ error: 'Missing username or registrationRecord' });
  if (!publicKey || !encryptedPrivateKey) return res.status(400).json({ error: 'Missing public key or private key' });
  // Attempt to insert user into DB
  db.run(`INSERT INTO users (username, password, public_key, private_key) VALUES (?, ?, ?, ?)`,
    [userIdentifier, registrationRecord, publicKey, encryptedPrivateKey], function (err) {
      if (err) {
        console.log("ERROR", err)
        // If username already exists, return 409
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(409).json({ error: 'Username already exists' });
        }
        return res.status(500).json({ error: 'DB error' });
      }

      // Generate JWT
      const user = { id: this.lastID, userIdentifier };
      const token = generateToken(user);
      console.log("token", { token, id: user.id, username: user.userIdentifier })
      // Return token and user info
      res.status(201).json({ token, id: user.id, username: user.userIdentifier });
    });
});


app.get('/api/profile', authenticateJWT, (req, res) => {
  if (!req.user) return res.json({ user: null });

  const userId = req.user.id;

  db.get('SELECT private_key FROM users WHERE id = ?', [userId], (err, userKeyData) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (!userKeyData) return res.status(404).json({ error: 'User not found' });

    const token = req.headers.authorization?.split(' ')[1];
    const vapidPubKey = process.env.VAPID_PUBLIC_KEY;

    res.json({
      token,
      id: userId,
      username: req.user.username,
      private_key: userKeyData.private_key,
      vapidPubKey
    });
  });
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


app.post('/api/save-subscription', authenticateJWT, (req, res) => {
  console.log("save-subscription");
  const userId = req.user.id;
  const subscription = req.body.subscription;

  if (!subscription) {
    return res.status(400).json({ error: 'Missing subscription' });
  }

  let subObj;
  try {
    subObj = typeof subscription === 'string' ? JSON.parse(subscription) : subscription;
  } catch {
    return res.status(400).json({ error: 'Invalid subscription format' });
  }
  const endpoint = subObj.endpoint;
  if (!endpoint) {
    return res.status(400).json({ error: 'Subscription endpoint missing' });
  }

  const subString = JSON.stringify(subObj);

  db.run(`
    INSERT INTO push_subscriptions (user_id, endpoint, subscription)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, endpoint) DO UPDATE SET subscription=excluded.subscription
  `, [userId, endpoint, subString], (err) => {
    if (err) {
      console.error('Failed to save subscription:', err);
      return res.status(500).json({ error: 'Failed to save subscription' });
    }
    res.json({ success: true });
  });
});




app.get('/api/dm-messages/:otherUserId', authenticateJWT, (req, res) => {
  const loggedInUserId = req.user.id;
  const otherUserId = parseInt(req.params.otherUserId, 10);
  const beforeId = req.query.before;
  const limit = 10;
  if (isNaN(otherUserId)) return res.status(400).json({ error: 'Invalid user ID' });

  const params = [loggedInUserId, otherUserId, otherUserId, loggedInUserId];

  let query = `
    SELECT 
      dm.id, dm.sender_id, dm.recipient_id, dm.content, dm.timestamp, u.username AS sender_username, dm.parent_message_id, dm.edited,
      pm.content AS parent_content,
      pu.username AS parent_username,
      pu.id AS parent_sender_id
    FROM direct_messages dm
    JOIN users u ON dm.sender_id = u.id
    LEFT JOIN direct_messages pm ON dm.parent_message_id = pm.id
    LEFT JOIN users pu ON pm.sender_id = pu.id
    WHERE
      ((dm.sender_id = ? AND dm.recipient_id = ?)
      OR
      (dm.sender_id = ? AND dm.recipient_id = ?))
  `;

  if (beforeId) {
    query += ` AND dm.id < ?`;
    params.push(beforeId);
  }

  query += `
    ORDER BY dm.id DESC
    LIMIT ?
  `;
  params.push(limit);

  db.all(query, params, (err, rows) => {
    if (err) {
      console.error('Failed to fetch DM messages:', err);
      return res.status(500).json({ error: 'Server error' });
    }
    res.json(rows.reverse());
  });
});

app.post('/api/dm-send', authenticateJWT, async (req, res) => {
  try {
    console.log("dm-send!");
    const sender_id = req.user?.id;
    const { recipient_id, content, replyTo } = req.body;

    if (!sender_id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!recipient_id || !content || !content.trim()) {
      return res.status(400).json({ error: 'Missing recipient or content' });
    }

    if (content.length > max_message_length) {
      return res.status(400).json({
        error: `Message too long. Max allowed characters: ${max_plaintext_length} bytes`
      });
    }

    db.run(
      `INSERT INTO direct_messages (sender_id, recipient_id, content, parent_message_id, timestamp)
       VALUES (?, ?, ?, ?, strftime('%s','now'))`,
      [sender_id, recipient_id, content.trim(), replyTo],
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
            dm.parent_message_id,
            dm.edited,
            u.username AS sender_username,
            u.public_key,
            pm.content AS parent_content,
            pu.id AS parent_sender_id,
            pu.username AS parent_username
          FROM direct_messages dm
          JOIN users u ON dm.sender_id = u.id
          LEFT JOIN direct_messages pm ON dm.parent_message_id = pm.id
          LEFT JOIN users pu ON pm.sender_id = pu.id
          WHERE dm.id = ?
          `,
          [insertedId],
          (err, message) => {
            if (err) {
              console.error('Failed to fetch inserted DM:', err);
              return res.status(500).json({ error: 'Failed to send message' });
            }

            console.log(`User ${message.recipient_id} received a new DM from ${message.sender_username}: "${message.content.trim()}"`);

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

            sendToUserSockets(message.recipient_id, { type: 'new_dm', message });
            sendToUserSockets(message.sender_id, { type: 'new_dm', message });

            db.all('SELECT id, subscription FROM push_subscriptions WHERE user_id = ?', [recipient_id], async (err, rows) => {
              if (err || !rows || rows.length === 0) return;
              const imageUrl = await getUserImageUrl(req.user.id);
              console.log(imageUrl)
              rows.forEach(row => {
                const subscription = JSON.parse(row.subscription);
                const payload = JSON.stringify({
                  title: req.user.username,
                  body: `New encrypted message.`,
                  url: `/dm/${req.user.id}`,
                  image: imageUrl,
                });
                webpush.sendNotification(subscription, payload)
                  .catch(error => {
                    console.log('Push notification error status code:', error.statusCode)

                    if (error.statusCode === 410) {
                      // Subscription is no longer valid, delete it
                      db.run('DELETE FROM push_subscriptions WHERE id = ?', [row.id], (delErr) => {
                        if (delErr) {
                          console.error('Failed to delete stale subscription:', delErr);
                        } else {
                          console.log('Deleted stale subscription with id:', row.id);
                        }
                      });
                    }
                  });
              });
            });

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


// DELETE a direct message by ID
app.delete('/api/messages/:id', authenticateJWT, async (req, res) => {
  try {
    const userId = req.user?.id;
    const messageId = parseInt(req.params.id, 10);

    if (!messageId) {
      return res.status(400).json({ error: 'Invalid message ID' });
    }

    // Check if the message exists and the user is sender or recipient
    db.get(
      `SELECT * FROM direct_messages WHERE id = ?`,
      [messageId],
      (err, row) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: 'Database error' });
        }

        if (!row) {
          return res.status(404).json({ error: 'Message not found' });
        }

        // Only sender can delete their message
        if (row.sender_id !== userId) {
          return res.status(403).json({ error: 'Not authorized to delete this message' });
        }

        // Delete the message
        db.run(`DELETE FROM direct_messages WHERE id = ?`, [messageId], function (err2) {
          if (err2) {
            console.error(err2);
            return res.status(500).json({ error: 'Failed to delete message' });
          }

          // Send webhooks
          sendToUserSockets(row.recipient_id, {
            type: 'delete_dm',
            messageId,
            sender_id: row.sender_id
          });
          sendToUserSockets(row.sender_id, {
            type: 'delete_dm',
            messageId,
            sender_id: row.sender_id
          });


          return res.json({ success: true, deletedId: messageId });
        });
      }
    );
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});


// UPDATE a direct message by ID
app.put('/api/update-message/:id', authenticateJWT, async (req, res) => {
  try {
    const userId = req.user?.id;
    const messageId = parseInt(req.params.id, 10);
    const { content } = req.body;

    if (!messageId || !content) {
      return res.status(400).json({ error: 'Invalid input' });
    }

    // Enforce max message length
    if (content.length > max_message_length) {
      return res.status(400).json({
        error: `Message too long. Max length is ${max_plaintext_length} characters.`,
      });
    }

    // Check if the message exists and the user is sender
    db.get(`SELECT * FROM direct_messages WHERE id = ?`, [messageId], (err, row) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Database error' });
      }

      if (!row) return res.status(404).json({ error: 'Message not found' });
      if (row.sender_id !== userId) return res.status(403).json({ error: 'Not authorized' });

      // Update the message
      db.run(`UPDATE direct_messages SET content = ?, edited = 1 WHERE id = ?`, [content, messageId], function (err2) {
        if (err2) {
          console.error(err2);
          return res.status(500).json({ error: 'Failed to update message' });
        }

        // Notify sockets
        sendToUserSockets(row.recipient_id, { type: 'edit_dm', messageId, content });
        sendToUserSockets(row.sender_id, { type: 'edit_dm', messageId, content });

        return res.json({ success: true, messageId, content });
      });
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});


app.get("/api/upload_profile_pic", authenticateJWT, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { type } = req.query;
    if (!type) {
      return res.status(400).json({ error: "Missing content type" });
    }

    const url = await getUploadUrl(`${userId}`, "profile-pics", type);

    return res.status(201).json({ url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to generate URL" });
  }
});


app.get("/api/upload_file", authenticateJWT, async (req, res) => {
  try {
    console.log("UPLOAD");
    const { type } = req.query;
    if (!type) return res.status(400).json({ error: "Missing content type" });

    const ext = type.split("/")[1] || "bin";
    const filename = `${uuidv4()}.${ext}`;

    const bucketName = "uploads";

    const uploadUrl = await getUploadUrl(filename, bucketName, type);

    const fileUrl = `${process.env.S3_ENDPOINT}/${bucketName}/${filename}`;

    console.log("Signed URL:", uploadUrl);
    console.log("Final URL:", fileUrl);

    return res.status(201).json({ uploadUrl, fileUrl });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to generate upload URL" });
  }
});



app.get('/api/config', (req, res) => {
  res.json({
    s3Endpoint: process.env.S3_ENDPOINT,
    maxPlaintextLength: max_plaintext_length,
  });
});






// FUNCTIONS

function getRecentDmsForUser(loggedInUserId, callback) {
  db.all(
    `
    SELECT u.id, u.username, u.public_key,
           MAX(m.timestamp) as last_timestamp
    FROM users u
    LEFT JOIN direct_messages m
      ON (
        (m.sender_id = ? AND m.recipient_id = u.id)
        OR
        (m.recipient_id = ? AND m.sender_id = u.id)
      )
    WHERE u.id != ?
    GROUP BY u.id
    ORDER BY last_timestamp DESC NULLS LAST
    `,
    [loggedInUserId, loggedInUserId, loggedInUserId],
    (err, rows) => {
      if (err) return callback(err);
      const enhancedRows = rows.map(user => ({
        ...user,
        online: clients.has(user.id.toString())
      }));
      callback(null, enhancedRows);
    }
  );
}

function generateToken(user) {
  // Payload can contain minimal user info
  const payload = {
    id: user.id,
    username: user.username,
  };
  console.log("Generating token for user:", payload);
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


async function getUserImageUrl(userId) {
  const endpoint = `${process.env.S3_ENDPOINT}/profile-pics/${userId}`;
  console.log(endpoint)
  try {
    const res = await fetch(endpoint, { method: "HEAD" });
    if (res.ok) {
      return endpoint;
    }
  } catch (err) {
    console.error("Error checking S3 image:", err);
  }
  return "/default.png";
}


function getMaxEncryptedLength(maxPlaintextLength) {
  const ivLength = 12;
  const tagLength = 16;
  const totalBytes = maxPlaintextLength + ivLength + tagLength;
  return Math.ceil(totalBytes * 4 / 3);
}


// WEBSOCKETS
function noop() { }
function heartbeat() {
  this.isAlive = true;
}

function broadcastUserStatus(userId, status) {
  const message = JSON.stringify({
    type: 'user_status',
    userId,
    status, // 'online' or 'offline'
  });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
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
            ws.close(1008, 'Invalid token');
            return;
          }
          ws.userId = user.id.toString();

          if (!clients.has(ws.userId)) clients.set(ws.userId, []);
          clients.get(ws.userId).push(ws);

          console.log(`User identified as ${user.id}`);
          broadcastUserStatus(user.id.toString(), 'online');
        });
      }
    } catch (err) {
      console.error('Invalid message', err);
    }
  });



  ws.on('close', () => {
    const userId = ws.userId;
    if (userId && clients.has(userId)) {
      const arr = clients.get(userId).filter(s => s !== ws);
      if (arr.length) {
        clients.set(userId, arr);
      } else {
        clients.delete(userId);
        broadcastUserStatus(userId, 'offline');
      }
    }
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

// send a webhook to all clients of a given user
function sendToUserSockets(userId, payload) {
  const sockets = clients.get(userId.toString()) || [];
  sockets.forEach(s => {
    if (s.readyState === WebSocket.OPEN) {
      s.send(JSON.stringify(payload));
    }
  });
}
