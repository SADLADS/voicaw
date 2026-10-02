const config = require('./config'); // first: loads .env and checks it
const express = require('express');
const cors = require('cors');
const { clients, attachWebSocketServer } = require('./sockets');
const { getSetting } = require('./appSettings');
const { RENEWED_TOKEN_HEADER } = require('./auth');

// The HTTP API (all under /api). Required by tests as-is; the port and the websocket server
// only exist when this file is run as the server (`node index.js`).
const app = express();
// nginx (on this machine) proxies every request, so the client's address is the last one it
// adds to X-Forwarded-For; req.ip then is the visitor, not 127.0.0.1 (rate limits use it).
app.set('trust proxy', 'loopback');
// Webhook routes parse their own bodies (bigger JSON for pictures, forms, files); see
// routes/webhooks.js. Saving a document (routes/guildDocuments.js, up to 100,000 characters)
// takes more than express's default 100 kB (nginx takes 1 MB).
const json = express.json();
const documentJson = express.json({ limit: '1mb' });
const DOCUMENT_PATH = /^\/api\/(channels\/\d+\/documents|documents\/\d+)$/;
app.use((req, res, next) => {
  if (/\/webhooks(\/|$)/.test(req.path)) return next();
  return (DOCUMENT_PATH.test(req.path) ? documentJson : json)(req, res, next);
});

app.use(cors({
  origin(origin, callback) {
    if (!origin || config.allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error(`Origin ${origin} Not allowed by CORS`));
  },
  credentials: true,
  // A renewed login token (auth.js), which the page must be able to read.
  exposedHeaders: [RENEWED_TOKEN_HEADER],
}));

app.get('/api/config', async (req, res) => {
  res.json({
    s3Endpoint: config.s3Endpoint,
    maxPlaintextLength: config.maxPlaintextLength,
    vapidPublicKey: config.vapid.publicKey,
    voiceEnabled: Boolean(config.livekit),
    // The emoji picker's GIFs tab (a Klipy key, from .env or Settings → Admin).
    gifsEnabled: Boolean(await getSetting('klipyApiKey')),
  });
});

app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/dms'));
app.use('/api', require('./routes/reactions'));
app.use('/api', require('./routes/guilds'));
app.use('/api', require('./routes/guildMessages'));
app.use('/api', require('./routes/guildSearch'));
app.use('/api', require('./routes/guildRoles'));
app.use('/api', require('./routes/guildEmojis'));
app.use('/api', require('./routes/guildTasks'));
app.use('/api', require('./routes/guildDocuments'));
app.use('/api', require('./routes/auditLog'));
app.use('/api', require('./routes/voice'));
app.use('/api', require('./routes/calls'));
app.use('/api', require('./routes/groupDms'));
app.use('/api', require('./routes/typing'));
app.use('/api', require('./routes/polls'));
app.use('/api', require('./routes/push'));
app.use('/api', require('./routes/uploads'));
app.use('/api', require('./routes/avatars'));
app.use('/api', require('./routes/gifs'));
app.use('/api', require('./routes/admin'));
// Discord's API also has versioned paths (/api/v10/webhooks/...); webhook clients use them.
// (Longest first: Express hands a request to the first path that matches.)
app.use(['/api/v10', '/api/v9', '/api/v8', '/api/v7', '/api/v6', '/api'], require('./routes/webhooks'));

// Must be registered after all routes: Express only routes errors to error-handling
// middleware added later in the stack. (Express 5 also sends rejected async handlers here.)
app.use((err, req, res, next) => {
  console.error('--- Unhandled Error ---');
  console.error(`Route: ${req.method} ${req.originalUrl}`);
  console.error(err.stack);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'An internal server error occurred.' });
});

// Exposed so tests can simulate connected sockets.
app.locals.clients = clients;

module.exports = app;

if (require.main === module) {
  const server = app.listen(config.port, (err) => {
    if (err) {
      console.error('Failed to start server:', err);
      process.exit(1);
    }
    console.log(`Server running on port ${config.port} (max message length ${config.maxPlaintextLength})`);
  });
  attachWebSocketServer(server);
  // Who's in voice right now, in case the API restarted while people were talking.
  require('./voice').restoreFromLiveKit();
  // Profile pictures from before they were processed (a one-off; nothing to do afterwards).
  require('./avatars').migrateLegacyAvatars();
  // Posts "poll ended" rows as polls close.
  require('./pollTimers').startPollTimers();
}
