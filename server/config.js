// Settings from the environment (server/.env). Loaded first: the server refuses to start
// without the secrets it needs.
require('dotenv').config({ quiet: true });

const REQUIRED_ENV_VARS = [
  'JWT_SECRET',
  'OPAQUE_SERVER_SETUP',
  'VAPID_EMAIL',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'S3_ENDPOINT',
  'S3_ROOT_USER',
  'S3_ROOT_PASSWORD',
];

const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error('FATAL ERROR: Missing required environment variables:');
  console.error(`- ${missing.join('\n- ')}`);
  console.error('Please create a .env file or set these variables in your environment before starting the server.');
  process.exit(1);
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

const maxPlaintextLength = parseInt(process.env.MAX_MESSAGE_LENGTH, 10) || 5000;

// Voice channels (a LiveKit server, see README.md). Optional: without these, voice channels
// exist but can't be joined. LIVEKIT_URL is what browsers connect to (wss://); the API talks
// to LiveKit at LIVEKIT_API_URL (default: the same address over http(s)).
const { LIVEKIT_URL, LIVEKIT_API_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
const livekit = LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET
  ? {
    url: LIVEKIT_URL,
    apiUrl: LIVEKIT_API_URL || LIVEKIT_URL.replace(/^ws/, 'http'),
    apiKey: LIVEKIT_API_KEY,
    apiSecret: LIVEKIT_API_SECRET,
  }
  : null;

// The Android app's notifications (Firebase Cloud Messaging, see fcm.js). Optional: without it
// the app shows no notifications while closed. FCM_SERVICE_ACCOUNT is the path to a Firebase
// service account's JSON key (Project settings → Service accounts → Generate new private key).
function loadFcmAccount(file) {
  if (!file) return null;
  try {
    const account = JSON.parse(require('fs').readFileSync(file, 'utf8'));
    if (!account.project_id || !account.client_email || !account.private_key) throw new Error('not a service account key');
    return { projectId: account.project_id, clientEmail: account.client_email, privateKey: account.private_key };
  } catch (err) {
    console.error(`FCM_SERVICE_ACCOUNT can't be used (${err.message}); the Android app gets no notifications.`);
    return null;
  }
}

module.exports = {
  port: process.env.PORT || 3000,
  jwtSecret: process.env.JWT_SECRET,
  opaqueServerSetup: process.env.OPAQUE_SERVER_SETUP,
  s3Endpoint: process.env.S3_ENDPOINT,
  vapid: {
    email: process.env.VAPID_EMAIL,
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
  },
  fcm: loadFcmAccount(process.env.FCM_SERVICE_ACCOUNT),
  // voicaw://app: the desktop app's own pages (electron/protocol.js); https://localhost: the
  // Android app's (Capacitor serves its bundled page there, mobile/capacitor.config.json).
  allowedOrigins: ['https://app.voicaw.com', 'https://test.voicaw.com', 'https://voicaw.com', 'http://test.voicaw.com', 'http://voicaw.com', 'voicaw://app', 'https://localhost'],
  maxPlaintextLength,
  livekit,
  // Login/registration attempt limits (see routes/auth.js). Tests turn them off, since they
  // register and log in dozens of users from one address.
  rateLimitsEnabled: process.env.DISABLE_RATE_LIMITS !== '1',
  // What a message of maxPlaintextLength is once encrypted (the server only sees that).
  maxMessageLength: getMaxEncryptedLength(maxPlaintextLength),
  getMaxEncryptedLength,
};
