const webpush = require('web-push');
const db = require('./db');
const { vapid, s3Endpoint } = require('./config');

webpush.setVapidDetails(vapid.email, vapid.publicKey, vapid.privateKey);

// Web push payloads must stay under ~4KB, so the (end-to-end encrypted) message is only
// included when it's small enough; the service worker decrypts it on the device for the
// notification preview and falls back to a generic body otherwise.
const MAX_PUSH_CIPHERTEXT_LENGTH = 2800;

// `recipientName` is only for showing mentions (`<@id>`) in the preview.
function buildDmPushPayload(message, imageUrl, recipientName) {
  const payload = {
    type: 'dm',
    title: message.sender_display_name || message.sender_username,
    // What service workers from before previews existed show (the current one decrypts
    // `ciphertext` instead); keeps notifications readable until every device updates.
    body: 'New message',
    url: `/dm/${message.sender_id}`,
    tag: `dm-${message.sender_id}`,
    image: imageUrl,
    senderId: message.sender_id,
    recipientId: message.recipient_id,
    recipientName,
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
async function sendPushToUser(userId, payload, options = {}) {
  let rows;
  try {
    rows = await db.all('SELECT id, subscription FROM push_subscriptions WHERE user_id = ?', [userId]);
  } catch {
    return { devices: 0, delivered: 0 };
  }
  const body = JSON.stringify(payload);
  const results = await Promise.all(rows.map(async (row) => {
    try {
      await webpush.sendNotification(JSON.parse(row.subscription), body, { TTL: 24 * 60 * 60, ...options });
      return true;
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        db.run('DELETE FROM push_subscriptions WHERE id = ?', [row.id]).catch(() => {});
      } else {
        console.error('Push notification failed:', error.statusCode || error.message, error.body || '');
      }
      return false;
    }
  }));
  return { devices: rows.length, delivered: results.filter(Boolean).length };
}

// The sender's profile picture for the notification, if they have one.
async function getUserImageUrl(userId) {
  const url = `${s3Endpoint}/profile-pics/${userId}`;
  try {
    const res = await fetch(url, { method: 'HEAD' });
    if (res.ok) return url;
  } catch (err) {
    console.error('Error checking S3 image:', err);
  }
  return '/default.png';
}

module.exports = { buildDmPushPayload, sendPushToUser, getUserImageUrl };
