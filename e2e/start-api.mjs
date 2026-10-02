// A throwaway Voicaw API for browser checks: its own fresh in-memory database, fresh secrets,
// rate limits off, and a stand-in object store kept in memory (E2E_S3_PORT: uploads, profile
// pictures, emoji and attachments all work). Never touches the real server/.env, database or
// S3. Run through serve.mjs.
import opaque from '@serenity-kit/opaque';
import webpush from 'web-push';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import http from 'http';

await opaque.ready;
const vapid = webpush.generateVAPIDKeys();

// The object store: PUT (pre-signed uploads from the browser), GET/HEAD (public reads), with
// CORS like the real one. Objects live in memory, keyed "<bucket>/<key>".
const s3Port = process.env.E2E_S3_PORT || String(Number(process.env.E2E_API_PORT || 3099) + 1);
const s3Endpoint = `http://localhost:${s3Port}`;
const objects = new Map();
const reads = [];
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT');
  res.setHeader('Access-Control-Allow-Headers', '*');
  const key = decodeURIComponent(new URL(req.url, s3Endpoint).pathname.slice(1));
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  if (req.method === 'PUT') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      objects.set(key, { body: Buffer.concat(chunks), contentType: req.headers['content-type'] || 'application/octet-stream' });
      res.writeHead(200).end();
    });
    return undefined;
  }
  // What was read (bucket/key, range, bytes), so checks can see what a page downloaded.
  if (key === '__reads') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reads));
  if (key === '__reads/clear') {
    reads.length = 0;
    return res.writeHead(204).end();
  }
  const object = objects.get(key);
  if (!object) return res.writeHead(404).end();
  // One byte range, as MinIO serves them (videos are streamed a piece at a time).
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && Number(range[1]) < object.body.length) {
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : Infinity, object.body.length - 1);
    if (req.method === 'GET') reads.push({ key, start, end, bytes: end - start + 1 });
    res.writeHead(206, {
      'Content-Type': object.contentType,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${object.body.length}`,
      'Accept-Ranges': 'bytes',
    });
    return res.end(req.method === 'HEAD' ? undefined : object.body.subarray(start, end + 1));
  }
  if (req.method === 'GET') reads.push({ key, start: 0, end: object.body.length - 1, bytes: object.body.length });
  res.writeHead(200, { 'Content-Type': object.contentType, 'Content-Length': object.body.length, 'Accept-Ranges': 'bytes' });
  return res.end(req.method === 'HEAD' ? undefined : object.body);
}).listen(Number(s3Port));
Object.assign(process.env, {
  PORT: process.env.E2E_API_PORT || '3099',
  DB_PATH: ':memory:',
  DISABLE_RATE_LIMITS: '1',
  JWT_SECRET: 'e2e-only-secret',
  OPAQUE_SERVER_SETUP: opaque.server.createSetup(),
  S3_ENDPOINT: s3Endpoint,
  S3_ROOT_USER: 'e2e',
  S3_ROOT_PASSWORD: 'e2e',
  VAPID_EMAIL: 'mailto:e2e@example.com',
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
});

const serverIndex = fileURLToPath(new URL('../server/index.js', import.meta.url));
const require = createRequire(serverIndex);
// Stub s3.js before the server loads it (it connects at require time) with the store above.
const s3Path = require.resolve('./s3.js');
require.cache[s3Path] = {
  id: s3Path,
  filename: s3Path,
  loaded: true,
  exports: {
    s3: {},
    getUploadUrl: async (key, bucket) => `${s3Endpoint}/${bucket}/${key}`,
    getObject: async (bucket, key) => {
      const object = objects.get(`${bucket}/${key}`);
      if (!object) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      return object.body;
    },
    putObject: async (bucket, key, body, contentType) => {
      objects.set(`${bucket}/${key}`, { body, contentType });
    },
    deleteObject: async (bucket, key) => {
      objects.delete(`${bucket}/${key}`);
      return true;
    },
    listTopLevelKeys: async (bucket) => [...objects.keys()]
      .filter((k) => k.startsWith(`${bucket}/`))
      .map((k) => k.slice(bucket.length + 1))
      .filter((k) => !k.includes('/')),
  },
};
// Load index.js as the main module, so it listens and starts the websocket server.
require('module')._load(serverIndex, null, true);

// Browser checks of Settings → Admin: anyone who signs up with a name starting "admin" is a
// global admin here (in the real app, `npm run admin -- <name>` in server/).
const db = require('./db.js');
for (let tries = 0; ; tries += 1) {
  try {
    await db.run(`CREATE TRIGGER IF NOT EXISTS e2e_admins AFTER INSERT ON users WHEN NEW.username LIKE 'admin%'
      BEGIN UPDATE users SET is_admin = 1 WHERE id = NEW.id; END`);
    break;
  } catch (err) {
    if (tries > 50) throw err; // the schema is still being made
    await new Promise((r) => setTimeout(r, 100));
  }
}
