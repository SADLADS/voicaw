const crypto = require('crypto');
const net = require('net');
const express = require('express');
const db = require('../db');
const { authenticateJWT } = require('../auth');
const { sendPushToUser } = require('../push');
const { createLimiter, limitRequests } = require('../rateLimit');
const { isPublicAddress } = require('../safeFetch');

// Each saved subscription is a request this server makes for every push to that person, to
// whatever address it names (security audit, 2026-11-18): so only so many per account (the
// oldest go), only https addresses, and saving and testing are rate limited.
const MAX_SUBSCRIPTIONS_PER_USER = 20;
const MAX_ENDPOINT_LENGTH = 2048;
const saves = createLimiter({ windowMs: 60 * 60 * 1000, max: 60 });
const tests = createLimiter({ windowMs: 60 * 1000, max: 5 });

// A web push endpoint as browsers make them: an https address on port 443, of a sane length,
// not a private address written out (names are checked when connecting: push.js's agent).
function isWebPushEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT_LENGTH) return false;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return !net.isIP(host) || isPublicAddress(host);
}

// What a device shows to replace its subscription without a login (see /update-subscription):
// made by the device, only its hash kept.
const MIN_SECRET_LENGTH = 16;
const MAX_SECRET_LENGTH = 200;
const validSecret = (secret) => typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH && secret.length <= MAX_SECRET_LENGTH;
const hashSecret = (secret) => crypto.createHash('sha256').update(secret).digest('hex');

// A browser's subscription, keeping only what web push uses (never an app's `fcm`).
function webPushSubscription(subscription) {
  const { endpoint, expirationTime = null, keys } = subscription ?? {};
  if (!isWebPushEndpoint(endpoint) || subscription.fcm) return null;
  if (typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string' || keys.p256dh.length > 200 || keys.auth.length > 200) return null;
  if (expirationTime !== null && typeof expirationTime !== 'number') return null;
  return { endpoint, expirationTime, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

// Web push subscriptions: one per device (endpoint), belonging to whoever is logged in there.
const router = express.Router();

router.post('/save-subscription', authenticateJWT, limitRequests(saves), async (req, res) => {
  const userId = req.user.id;
  const { subscription, updateSecret } = req.body;
  if (!subscription) return res.status(400).json({ error: 'Missing subscription' });

  let subObj;
  try {
    subObj = typeof subscription === 'string' ? JSON.parse(subscription) : subscription;
  } catch {
    return res.status(400).json({ error: 'Invalid subscription format' });
  }
  const { endpoint } = subObj ?? {};
  if (!endpoint) return res.status(400).json({ error: 'Subscription endpoint missing' });
  // The Android app: its Firebase token, and the key every push to it is encrypted with (fcm.js).
  if (subObj.fcm || endpoint.startsWith('fcm:')) {
    const { token, key, reactionPushes } = subObj.fcm ?? {};
    if (typeof token !== 'string' || !token || token.length > 4096 || endpoint !== `fcm:${token}` ||
        typeof key !== 'string' || Buffer.from(key, 'base64').length !== 32) {
      return res.status(400).json({ error: 'Invalid app subscription' });
    }
    // `reactionPushes`: the app drops reactions it shouldn't show (push.js sendToReactionApps).
    subObj = { endpoint, fcm: { token, key, ...(reactionPushes === true && { reactionPushes }) } };
  } else if (!isWebPushEndpoint(endpoint)) {
    return res.status(400).json({ error: 'Invalid subscription endpoint' });
  }
  // Apps older than the secret send none: their service worker can't swap the subscription,
  // and the app saves a fresh one the next time it opens.
  const secretHash = !subObj.fcm && validSecret(updateSecret) ? hashSecret(updateSecret) : null;

  // A device (endpoint) belongs to whoever is logged in on it now; otherwise it would
  // keep receiving a previous account's notifications.
  await db.transaction(async () => {
    await db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id != ?', [endpoint, userId]);
    await db.run(
      `INSERT INTO push_subscriptions (user_id, endpoint, subscription, session_id, update_secret) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, endpoint) DO UPDATE SET subscription = excluded.subscription, session_id = excluded.session_id,
         update_secret = excluded.update_secret`,
      [userId, endpoint, JSON.stringify(subObj), req.user.sid, secretHash]
    );
    await db.run(
      `DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN
         (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT ?)`,
      [userId, userId, MAX_SUBSCRIPTIONS_PER_USER]
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
// Unauthenticated because the service worker has no JWT: the device proves it's the one that
// saved the old endpoint with the secret it made then (the endpoint alone isn't enough: the
// next person to log in on that browser gets the same one). Only a browser's subscription, on
// the same push service as the old one.
router.post('/update-subscription', async (req, res) => {
  const { oldEndpoint, secret } = req.body || {};
  const subscription = webPushSubscription(req.body?.subscription);
  if (typeof oldEndpoint !== 'string' || !oldEndpoint) return res.status(400).json({ error: 'Missing endpoint' });
  if (!subscription) return res.status(400).json({ error: 'Invalid subscription' });
  let sameService = false;
  try {
    sameService = new URL(oldEndpoint).host === new URL(subscription.endpoint).host;
  } catch { /* not an address */ }
  if (!sameService) return res.status(400).json({ error: 'Invalid subscription endpoint' });
  if (!validSecret(secret)) return res.status(404).json({ error: 'Unknown subscription' });

  const swapped = await db.transaction(async () => {
    const row = await db.get(
      'SELECT id, user_id FROM push_subscriptions WHERE endpoint = ? AND update_secret = ?',
      [oldEndpoint, hashSecret(secret)]
    );
    if (!row) return false;
    // The account may already have the new one saved (UNIQUE(user_id, endpoint)).
    await db.run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ? AND id != ?', [row.user_id, subscription.endpoint, row.id]);
    await db.run('UPDATE push_subscriptions SET endpoint = ?, subscription = ? WHERE id = ?', [subscription.endpoint, JSON.stringify(subscription), row.id]);
    return true;
  });
  if (!swapped) return res.status(404).json({ error: 'Unknown subscription' });
  res.json({ success: true });
});

// Lets a user check notifications work on their devices.
router.post('/test-push', authenticateJWT, limitRequests(tests), async (req, res) => {
  res.json(await sendPushToUser(req.user.id, {
    type: 'test',
    title: 'Voicaw',
    body: 'Notifications are working.',
    url: '/settings',
    tag: 'test',
  }));
});

module.exports = router;
