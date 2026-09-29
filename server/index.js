const config = require('./config'); // first: loads .env and checks it
const express = require('express');
const cors = require('cors');
const { clients, attachWebSocketServer } = require('./sockets');

// The HTTP API (all under /api). Required by tests as-is; the port and the websocket server
// only exist when this file is run as the server (`node index.js`).
const app = express();
app.use(express.json());

app.use(cors({
  origin(origin, callback) {
    if (!origin || config.allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error(`Origin ${origin} Not allowed by CORS`));
  },
  credentials: true,
}));

app.get('/api/config', (req, res) => {
  res.json({
    s3Endpoint: config.s3Endpoint,
    maxPlaintextLength: config.maxPlaintextLength,
    vapidPublicKey: config.vapid.publicKey,
  });
});

app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/dms'));
app.use('/api', require('./routes/reactions'));
app.use('/api', require('./routes/push'));
app.use('/api', require('./routes/uploads'));

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
}
