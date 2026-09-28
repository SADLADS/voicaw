const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const opaque = require('@serenity-kit/opaque');
const db = require('./db');
const cors = require('cors');
const webpush = require('web-push');
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


const clients = new Map();


let serverSetup;
(async () => {
  await opaque.ready;
  serverSetup = process.env.OPAQUE_SERVER_SETUP;
})();


// Initial Login route
app.post('/api/initiatelogin', (req, res) => {
  const { startLoginRequest, userIdentifier } = req.body;
  if (!startLoginRequest || !userIdentifier) return res.status(400).json({ error: 'Missing startLoginRequest or userIdentifier' });

  // Forget abandoned login attempts (states are only removed on successful login).
  db.run('DELETE FROM login_states WHERE expires_at < ?', [Math.floor(Date.now() / 1000)]);

  db.get('SELECT password FROM users WHERE username = ?', [userIdentifier], (err, user) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    // Unknown usernames get OPAQUE's dummy response (registrationRecord = null), which is
    // indistinguishable from a real one and just fails at the end like a wrong password,
    // so logged-out visitors can't find out which usernames exist.
    const registrationRecord = user ? user.password : null;
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
      db.get(
        'SELECT id, identity_key, encryption_key, encryption_key_signature, key_backup FROM users WHERE username = ?',
        [userIdentifier],
        (err, user) => {
          if (err) return res.status(500).json({ error: 'DB error' });
          if (!user) return res.status(401).json({ error: 'Invalid credentials' });
          const token = generateToken({ id: user.id, username: userIdentifier });
          // The client decrypts the backup with its OPAQUE exportKey and checks the published
          // public keys against the ones inside it.
          res.json({
            token,
            id: user.id,
            username: userIdentifier,
            keyBackup: user.key_backup,
            identityKey: user.identity_key,
            encryptionKey: user.encryption_key,
            encryptionKeySignature: user.encryption_key_signature,
          });
        }
      );
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
app.post('/api/finaliseregister', async (req, res) => {
  const { registrationRecord, userIdentifier, identityKey, encryptionKey, encryptionKeySignature, keyBackup } = req.body;

  if (!userIdentifier || !registrationRecord) return res.status(400).json({ error: 'Missing username or registrationRecord' });
  if (!identityKey || !encryptionKey || !encryptionKeySignature || !keyBackup) {
    return res.status(400).json({ error: 'Missing keys' });
  }
  // Clients verify this themselves; checking here just keeps broken keys out of the DB.
  if (!(await isValidEncryptionKeySignature(identityKey, encryptionKey, encryptionKeySignature))) {
    return res.status(400).json({ error: 'Invalid key signature' });
  }

  db.run(
    `INSERT INTO users (username, password, identity_key, encryption_key, encryption_key_signature, key_backup)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userIdentifier, registrationRecord, identityKey, encryptionKey, encryptionKeySignature, keyBackup],
    function (err) {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(409).json({ error: 'Username already exists' });
        }
        console.error('Failed to register user:', err.message);
        return res.status(500).json({ error: 'DB error' });
      }
      const user = { id: this.lastID, username: userIdentifier };
      res.status(201).json({ token: generateToken(user), id: user.id, username: user.username });
    }
  );
});


app.get('/api/profile', authenticateJWT, (req, res) => {
  if (!req.user) return res.json({ user: null });

  const userId = req.user.id;

  db.get('SELECT id FROM users WHERE id = ?', [userId], (err, user) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const token = req.headers.authorization?.split(' ')[1];
    res.json({ token, id: userId, username: req.user.username });
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

  db.serialize(() => {
    // A device (endpoint) belongs to whoever is logged in on it now; otherwise it would
    // keep receiving a previous account's notifications.
    db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id != ?', [endpoint, userId]);
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
});


// Stop sending this device notifications (logout, or notifications turned off).
app.post('/api/delete-subscription', authenticateJWT, (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });

  db.run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [req.user.id, endpoint], (err) => {
    if (err) {
      console.error('Failed to delete subscription:', err);
      return res.status(500).json({ error: 'Failed to delete subscription' });
    }
    res.json({ success: true });
  });
});


// The push service replaced a subscription (service worker `pushsubscriptionchange`).
// Unauthenticated because the service worker has no JWT; knowing the old endpoint (an
// unguessable URL only the device and this server have) is what authorises the swap.
app.post('/api/update-subscription', (req, res) => {
  const { oldEndpoint, subscription } = req.body || {};
  const newEndpoint = subscription?.endpoint;
  if (!oldEndpoint || !newEndpoint) return res.status(400).json({ error: 'Missing endpoint' });

  db.run(
    'UPDATE push_subscriptions SET endpoint = ?, subscription = ? WHERE endpoint = ?',
    [newEndpoint, JSON.stringify(subscription), oldEndpoint],
    function (err) {
      if (err) {
        console.error('Failed to update subscription:', err);
        return res.status(500).json({ error: 'Failed to update subscription' });
      }
      if (this.changes === 0) return res.status(404).json({ error: 'Unknown subscription' });
      res.json({ success: true });
    }
  );
});


// Lets a user check notifications work on their devices.
app.post('/api/test-push', authenticateJWT, async (req, res) => {
  const result = await sendPushToUser(req.user.id, {
    type: 'test',
    title: 'Voicaw',
    body: 'Notifications are working.',
    url: '/settings',
    tag: 'test',
  });
  res.json(result);
});


app.get('/api/dm-messages/:otherUserId', authenticateJWT, (req, res) => {
  const loggedInUserId = req.user.id;
  const otherUserId = parseInt(req.params.otherUserId, 10);
  const beforeId = req.query.before;
  // Page size: clients may ask for 1–100 (default 10, what older clients expect).
  const requestedLimit = parseInt(req.query.limit, 10);
  const limit = Number.isNaN(requestedLimit) ? 10 : Math.min(Math.max(requestedLimit, 1), 100);
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

    if (content != null && typeof content !== 'string') {
      return res.status(400).json({ error: 'Invalid content' });
    }

    if (!recipient_id || !content || !content.trim()) {
      return res.status(400).json({ error: 'Missing recipient or content' });
    }

    if (content.length > max_message_length) {
      return res.status(400).json({
        error: `Message too long. Max allowed characters: ${max_plaintext_length} bytes`
      });
    }

    const recipientId = Number(recipient_id);
    if (!Number.isInteger(recipientId)) {
      return res.status(400).json({ error: 'Invalid recipient' });
    }
    const recipient = await dbGet('SELECT id FROM users WHERE id = ?', [recipientId]);
    if (!recipient) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    // A reply must point at a message in this same conversation.
    let parentMessageId = null;
    if (replyTo != null) {
      parentMessageId = Number(replyTo);
      const parent = Number.isInteger(parentMessageId) && await dbGet(
        `SELECT id FROM direct_messages WHERE id = ?
           AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))`,
        [parentMessageId, sender_id, recipientId, recipientId, sender_id]
      );
      if (!parent) {
        return res.status(400).json({ error: 'Invalid reply' });
      }
    }

    db.run(
      `INSERT INTO direct_messages (sender_id, recipient_id, content, parent_message_id, timestamp)
       VALUES (?, ?, ?, ?, strftime('%s','now'))`,
      [sender_id, recipientId, content.trim(), parentMessageId],
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

            // Don't buzz someone about a conversation they're looking at right now.
            if (!isViewingConversation(message.recipient_id, message.sender_id)) {
              getUserImageUrl(message.sender_id).then((imageUrl) =>
                sendPushToUser(message.recipient_id, buildDmPushPayload(message, imageUrl), {
                  urgency: 'high',
                  topic: `dm${message.sender_id}`,
                })
              );
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


// Upload sizes are signed into the pre-signed URL (the object store rejects a body of any
// other length), so these limits can't be bypassed by uploading straight to the bucket.
// 100MB matches media.voicaw.com's nginx client_max_body_size.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_PROFILE_PIC_BYTES = 8 * 1024 * 1024;

// Parses the `size` query param; returns an error response (or null if valid).
function checkUploadSize(size, max) {
  if (!Number.isInteger(size) || size <= 0) return { status: 400, error: "Missing or invalid size" };
  if (size > max) return { status: 413, error: `File too large (max ${max} bytes)` };
  return null;
}

app.get("/api/upload_profile_pic", authenticateJWT, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { type } = req.query;
    const size = Number(req.query.size);
    if (!type) {
      return res.status(400).json({ error: "Missing content type" });
    }
    if (!type.startsWith("image/")) {
      return res.status(400).json({ error: "Profile pictures must be images" });
    }
    const sizeError = checkUploadSize(size, MAX_PROFILE_PIC_BYTES);
    if (sizeError) return res.status(sizeError.status).json({ error: sizeError.error });

    const url = await getUploadUrl(`${userId}`, "profile-pics", type, size);

    return res.status(201).json({ url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to generate URL" });
  }
});


app.get("/api/upload_file", authenticateJWT, async (req, res) => {
  try {
    const { type } = req.query;
    const size = Number(req.query.size);
    if (!type) return res.status(400).json({ error: "Missing content type" });
    const sizeError = checkUploadSize(size, MAX_UPLOAD_BYTES);
    if (sizeError) return res.status(sizeError.status).json({ error: sizeError.error });

    // Attachments are encrypted client-side and uploaded as opaque binary blobs.
    const ext = type === "application/octet-stream" ? "bin" : (type.split("/")[1] || "bin");
    const filename = `${uuidv4()}.${ext}`;

    const bucketName = "uploads";

    const uploadUrl = await getUploadUrl(filename, bucketName, type, size);

    const fileUrl = `${process.env.S3_ENDPOINT}/${bucketName}/${filename}`;

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
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY,
  });
});


// FUNCTIONS

function dbGet(sql, params) {
  return new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))
  );
}

function getRecentDmsForUser(loggedInUserId, callback) {
  db.all(
    `
    SELECT u.id, u.username, u.identity_key, u.encryption_key, u.encryption_key_signature,
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


// Messages are "v1." + base64(12-byte IV || ciphertext || 16-byte tag), see the client's
// encryptionService.
function getMaxEncryptedLength(maxPlaintextLength) {
  const prefixLength = 'v1.'.length;
  const ivLength = 12;
  const tagLength = 16;
  const totalBytes = maxPlaintextLength + ivLength + tagLength;
  return prefixLength + Math.ceil(totalBytes / 3) * 4;
}

// ECDSA P-256 / SHA-256 over "voicaw/encryption-key/v1\n<encryptionKey>" (see the client's
// encryptionService); keys and signature are base64.
async function isValidEncryptionKeySignature(identityKey, encryptionKey, signature) {
  try {
    const key = await crypto.webcrypto.subtle.importKey(
      'raw', Buffer.from(identityKey, 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
    );
    return await crypto.webcrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      Buffer.from(signature, 'base64'),
      new TextEncoder().encode(`voicaw/encryption-key/v1\n${encryptionKey}`)
    );
  } catch {
    return false;
  }
}


// A recipient is "viewing" a conversation if one of their sockets recently reported
// (see the `presence` websocket message) that it's visible and showing that chat.
// Presence has to be fresh: a phone that locks may not get to report going hidden.
const PRESENCE_FRESH_MS = 35000;

function isViewingConversation(userId, otherUserId) {
  const sockets = clients.get(String(userId)) || [];
  const now = Date.now();
  return sockets.some((s) =>
    s.readyState === WebSocket.OPEN &&
    s.presence?.visible &&
    s.presence.chatId === String(otherUserId) &&
    now - s.presence.at < PRESENCE_FRESH_MS
  );
}

// Web push payloads must stay under ~4KB, so the (end-to-end encrypted) message is only
// included when it's small enough; the service worker decrypts it on the device for the
// notification preview and falls back to a generic body otherwise.
const MAX_PUSH_CIPHERTEXT_LENGTH = 2800;

function buildDmPushPayload(message, imageUrl) {
  const payload = {
    type: 'dm',
    title: message.sender_username,
    // What service workers from before previews existed show (the current one decrypts
    // `ciphertext` instead); keeps notifications readable until every device updates.
    body: 'New message',
    url: `/dm/${message.sender_id}`,
    tag: `dm-${message.sender_id}`,
    image: imageUrl,
    senderId: message.sender_id,
    recipientId: message.recipient_id,
    timestamp: message.timestamp,
  };
  // The service worker decrypts with the sender's key it has already checked and remembered
  // (never a key from the push), so only the ciphertext is included.
  if (message.content.length <= MAX_PUSH_CIPHERTEXT_LENGTH) {
    payload.ciphertext = message.content;
  }
  return payload;
}

// Sends a web push to every device the user has subscribed; forgets devices whose
// subscription is gone. Resolves to { devices, delivered }.
function sendPushToUser(userId, payload, options = {}) {
  return new Promise((resolve) => {
    db.all('SELECT id, subscription FROM push_subscriptions WHERE user_id = ?', [userId], async (err, rows) => {
      if (err || !rows || rows.length === 0) return resolve({ devices: 0, delivered: 0 });

      const body = JSON.stringify(payload);
      const results = await Promise.all(rows.map(async (row) => {
        try {
          await webpush.sendNotification(JSON.parse(row.subscription), body, { TTL: 24 * 60 * 60, ...options });
          return true;
        } catch (error) {
          if (error.statusCode === 404 || error.statusCode === 410) {
            db.run('DELETE FROM push_subscriptions WHERE id = ?', [row.id]);
          } else {
            console.error('Push notification failed:', error.statusCode || error.message, error.body || '');
          }
          return false;
        }
      }));
      resolve({ devices: rows.length, delivered: results.filter(Boolean).length });
    });
  });
}

// send a webhook to all clients of a given user
function sendToUserSockets(userId, payload) {
  const sockets = clients.get(userId.toString()) || [];
  sockets.forEach(s => {
    if (s.readyState === WebSocket.OPEN) {
      s.send(JSON.stringify(payload));
    }
  });
}

// Must be registered after all routes: Express only routes errors to
// error-handling middleware added later in the stack.
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

// Exposed so tests can simulate connected sockets.
app.locals.clients = clients;

module.exports = app;

// Only bind a real port / WebSocket server when run directly (`node index.js`),
// not when required as a module (e.g. by tests).
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, (err) => {
    if (err) {
      console.error('Failed to start server:', err);
      process.exit(1);
    }
    console.log(`Server running on port ${PORT}`);
  });

  const wss = new WebSocket.Server({ server });

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
    // Only to identified (logged-in) sockets: anyone can open a websocket.
    wss.clients.forEach(client => {
      if (client.userId && client.readyState === WebSocket.OPEN) {
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
        } else if (data.type === 'presence' && ws.userId) {
          // Whether this client is on screen and which conversation it shows; used to
          // skip push notifications for a chat the user is already looking at.
          ws.presence = {
            visible: data.visible === true,
            chatId: data.chatId != null ? String(data.chatId) : null,
            at: Date.now(),
          };
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
}
