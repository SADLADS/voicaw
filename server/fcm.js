const crypto = require('crypto');
const zlib = require('zlib');
const config = require('./config');

// The Android app's notifications: Firebase Cloud Messaging (HTTP v1 API), the only way to wake
// an Android app that isn't running. Unlike web push, FCM doesn't encrypt to the device, so
// every payload is encrypted here with a key the phone made and registered with its token
// (push_subscriptions, `{ fcm: { token, key } }`): Google only relays ciphertext and learns
// when a phone gets something and how big it is, as with web push in Chrome.
//
// The message's data is { v: '1', p: base64(12-byte IV || AES-256-GCM(deflate(JSON)) || tag) },
// opened by mobile/android/.../PushCrypto.java.

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// FCM refuses data over 4096 bytes; leave room for the field names.
const MAX_DATA_LENGTH = 3900;

const base64url = (data) => Buffer.from(data).toString('base64url');

let accessToken = null; // { value, expires }

// An OAuth access token for the service account (a signed JWT exchanged at Google), reused
// until a minute before it expires.
async function getAccessToken(account) {
  if (accessToken && accessToken.expires > Date.now() + 60_000) return accessToken.value;
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iss: account.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), account.privateKey).toString('base64url');
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  if (!response.ok) throw new Error(`FCM login failed (${response.status})`);
  const { access_token: value, expires_in: expiresIn } = await response.json();
  accessToken = { value, expires: Date.now() + expiresIn * 1000 };
  return value;
}

// Encrypts `payload` for one phone (`key`: the base64 AES-256 key it registered).
function sealPayload(payload, key) {
  const keyBytes = Buffer.from(key, 'base64');
  if (keyBytes.length !== 32) throw new Error('Bad FCM device key');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, iv);
  const sealed = Buffer.concat([iv, cipher.update(zlib.deflateRawSync(JSON.stringify(payload))), cipher.final(), cipher.getAuthTag()]);
  return sealed.toString('base64');
}

// The data FCM carries for `payload`: a message's ciphertext is left out when it doesn't fit
// (the phone then shows "New message", as with a long message over web push).
function fcmData(payload, key) {
  let sealed = sealPayload(payload, key);
  if (sealed.length > MAX_DATA_LENGTH && payload.ciphertext) {
    const { ciphertext, ...rest } = payload;
    sealed = sealPayload(rest, key);
  }
  if (sealed.length > MAX_DATA_LENGTH) throw new Error('Push too big for FCM');
  return { v: '1', p: sealed };
}

// Sends `payload` to one phone. `options`: web push's { TTL (seconds), urgency }, and
// `priority: 'normal'` for one that needn't wake a phone in Doze. Resolves
// to true, or 'gone' when the token no longer exists (the subscription should be dropped).
async function sendFcm(fcm, payload, options = {}) {
  const account = config.fcm;
  if (!account) return false;
  const message = {
    token: fcm.token,
    data: fcmData(payload, fcm.key),
    android: {
      // Wakes a phone in Doze at once: a message, a call ringing, or one to stop ringing.
      priority: options.priority ?? 'high',
      ttl: `${options.TTL ?? 24 * 60 * 60}s`,
    },
  };
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${account.projectId}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await getAccessToken(account)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (response.ok) return true;
  const body = await response.json().catch(() => ({}));
  const code = body.error?.details?.find((d) => d.errorCode)?.errorCode;
  if (response.status === 404 || code === 'UNREGISTERED') return 'gone';
  throw Object.assign(new Error(`FCM ${response.status} ${code || body.error?.status || ''}`.trim()), { statusCode: response.status });
}

module.exports = { sendFcm, sealPayload, fcmData };
