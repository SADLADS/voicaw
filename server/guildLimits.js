const { createLimiter, limitRequests } = require('./rateLimit');

// Per-account limits on what people do in guilds through the app (security audit, low findings
// L4), so one member can't flood a guild's channels, audit log, layout or pushes. Generous for
// people, who never come near them; the 429 is the app's usual "too many, try later". Bots go
// through the bot API, which has its own per-route buckets (routes/botApi.js).
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// Caps per guild (as Discord's): what's over them already stays, nothing more is added.
const MAX_CHANNELS_PER_GUILD = 500; // categories count, threads don't
const MAX_ROLES_PER_GUILD = 250;
const MAX_LIVE_INVITES_PER_GUILD = 1000;
const MAX_LIVE_INVITES_PER_MEMBER = 100;

const LIMITS = {
  guilds: createLimiter({ windowMs: HOUR, max: 10 }),
  invites: createLimiter({ windowMs: HOUR, max: 30 }),
  // Channels, categories, copies of channels and roles: each rebuilds every member's layout.
  structure: createLimiter({ windowMs: 10 * MINUTE, max: 60 }),
  messages: createLimiter({ windowMs: MINUTE, max: 60 }),
  reactions: createLimiter({ windowMs: MINUTE, max: 120 }),
  threads: createLimiter({ windowMs: 10 * MINUTE, max: 20 }),
  searches: createLimiter({ windowMs: MINUTE, max: 30 }),
  tasks: createLimiter({ windowMs: 10 * MINUTE, max: 120 }),
  taskComments: createLimiter({ windowMs: MINUTE, max: 30 }),
  documents: createLimiter({ windowMs: 10 * MINUTE, max: 30 }),
  // Live editing sends one request at a time, the rest batched meanwhile (a 429 only delays them).
  collabSteps: createLimiter({ windowMs: MINUTE, max: 600 }),
  // Starting and ending events (each start pushes to everyone going).
  eventStarts: createLimiter({ windowMs: 10 * MINUTE, max: 10 }),
  // Bots' autocomplete, asked while typing pauses (250 ms): a row and a gateway event each.
  autocomplete: createLimiter({ windowMs: 10 * 1000, max: 30 }),
};

// Express middleware counting one `kind` per account.
const limit = (kind) => limitRequests(LIMITS[kind]);

module.exports = {
  LIMITS, limit, MAX_CHANNELS_PER_GUILD, MAX_ROLES_PER_GUILD, MAX_LIVE_INVITES_PER_GUILD, MAX_LIVE_INVITES_PER_MEMBER,
};
