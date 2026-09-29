// A throwaway Voicaw API for browser checks: its own fresh in-memory database, fresh secrets,
// rate limits off, and no object store (uploads fail, unless a check uses fakeObjectStore;
// profile pictures fall back). Never
// touches the real server/.env, database or S3. Run through serve.mjs.
import opaque from '@serenity-kit/opaque';
import webpush from 'web-push';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

await opaque.ready;
const vapid = webpush.generateVAPIDKeys();
Object.assign(process.env, {
  PORT: process.env.E2E_API_PORT || '3099',
  DB_PATH: ':memory:',
  DISABLE_RATE_LIMITS: '1',
  JWT_SECRET: 'e2e-only-secret',
  OPAQUE_SERVER_SETUP: opaque.server.createSetup(),
  S3_ENDPOINT: 'http://localhost:1',
  S3_ROOT_USER: 'e2e',
  S3_ROOT_PASSWORD: 'e2e',
  VAPID_EMAIL: 'mailto:e2e@example.com',
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
});

const serverIndex = fileURLToPath(new URL('../server/index.js', import.meta.url));
const require = createRequire(serverIndex);
// No object store: stub s3.js before the server loads it (it connects at require time).
const s3Path = require.resolve('./s3.js');
require.cache[s3Path] = {
  id: s3Path,
  filename: s3Path,
  loaded: true,
  // Upload URLs point where the file would be served from (S3_ENDPOINT/<bucket>/<key>), so
  // a browser check can stand in for the store (helpers.mjs fakeObjectStore).
  exports: {
    s3: {},
    getUploadUrl: async (key, bucket) => `http://localhost:1/${bucket}/${key}`,
    deleteObject: async () => {},
  },
};
// Load index.js as the main module, so it listens and starts the websocket server.
require('module')._load(serverIndex, null, true);
