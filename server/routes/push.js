const express = require('express');
const db = require('../db');
const { authenticateJWT } = require('../auth');
const { sendPushToUser } = require('../push');

// Web push subscriptions: one per device (endpoint), belonging to whoever is logged in there.
const router = express.Router();

router.post('/save-subscription', authenticateJWT, async (req, res) => {
  const userId = req.user.id;
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: 'Missing subscription' });

  let subObj;
  try {
    subObj = typeof subscription === 'string' ? JSON.parse(subscription) : subscription;
  } catch {
    return res.status(400).json({ error: 'Invalid subscription format' });
  }
  const { endpoint } = subObj;
  if (!endpoint) return res.status(400).json({ error: 'Subscription endpoint missing' });
  // The Android app: its Firebase token, and the key every push to it is encrypted with (fcm.js).
  if (subObj.fcm || endpoint.startsWith('fcm:')) {
    const { token, key } = subObj.fcm ?? {};
    if (typeof token !== 'string' || !token || token.length > 4096 || endpoint !== `fcm:${token}` ||
        typeof key !== 'string' || Buffer.from(key, 'base64').length !== 32) {
      return res.status(400).json({ error: 'Invalid app subscription' });
    }
    subObj = { endpoint, fcm: { token, key } };
  }

  // A device (endpoint) belongs to whoever is logged in on it now; otherwise it would
  // keep receiving a previous account's notifications.
  await db.transaction(async () => {
    await db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id != ?', [endpoint, userId]);
    await db.run(
      `INSERT INTO push_subscriptions (user_id, endpoint, subscription, session_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, endpoint) DO UPDATE SET subscription = excluded.subscription, session_id = excluded.session_id`,
      [userId, endpoint, JSON.stringify(subObj), req.user.sid]
    );
  });
  res.json({ success: true });
});

// Stop sending this device notifications (logout, or notifications turned off).
router.post('/delete-subscription', authenticateJWT, async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  await db.run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [req.user.id, endpoint]);
  res.json({ success: true });
});

// The push service replaced a subscription (service worker `pushsubscriptionchange`).
// Unauthenticated because the service worker has no JWT; knowing the old endpoint (an
// unguessable URL only the device and this server have) is what authorises the swap.
router.post('/update-subscription', async (req, res) => {
  const { oldEndpoint, subscription } = req.body || {};
  const newEndpoint = subscription?.endpoint;
  if (!oldEndpoint || !newEndpoint) return res.status(400).json({ error: 'Missing endpoint' });

  const { changes } = await db.run(
    'UPDATE push_subscriptions SET endpoint = ?, subscription = ? WHERE endpoint = ?',
    [newEndpoint, JSON.stringify(subscription), oldEndpoint]
  );
  if (changes === 0) return res.status(404).json({ error: 'Unknown subscription' });
  res.json({ success: true });
});

// Lets a user check notifications work on their devices.
router.post('/test-push', authenticateJWT, async (req, res) => {
  res.json(await sendPushToUser(req.user.id, {
    type: 'test',
    title: 'Voicaw',
    body: 'Notifications are working.',
    url: '/settings',
    tag: 'test',
  }));
});

module.exports = router;
