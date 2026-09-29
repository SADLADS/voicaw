const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(process.env.DB_PATH || './voicaw.db');
const { DEFAULT_EVERYONE_PERMISSIONS } = require('./permissions');

// USERS
db.run(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  avatar TEXT,
  description TEXT,
  last_online INTEGER DEFAULT (strftime('%s','now')),
  account_created INTEGER DEFAULT (strftime('%s','now')),
  -- Public keys (base64 raw P-256 points): identity (ECDSA) signs encryption (ECDH).
  identity_key TEXT NOT NULL,
  encryption_key TEXT NOT NULL,
  encryption_key_signature TEXT NOT NULL,
  -- Both private keys, encrypted client-side with a key derived from OPAQUE's exportKey.
  key_backup TEXT NOT NULL
);
`);

// GUILDS (servers, Discord style). Plain, not end-to-end encrypted: the server reads guild
// messages (only DMs and group DMs are encrypted). An earlier sketch left unused tables in old
// databases (roles, user_roles, categories, channels, channel_permissions, messages); they can
// be dropped. `guilds` is from that sketch too, hence `owner` and the ALTERs that update it.
db.serialize(() => {
db.run(`
CREATE TABLE IF NOT EXISTS guilds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner INTEGER NOT NULL,
  name TEXT NOT NULL,
  -- The icon is guild-icons/<id>; bumped on every new one (it busts caches). 0 = no icon.
  icon_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (owner) REFERENCES users(id)
);
`);
// Fail harmlessly ("duplicate column") once the columns exist.
db.run('ALTER TABLE guilds ADD COLUMN icon_version INTEGER NOT NULL DEFAULT 0', () => {});
db.run('ALTER TABLE guilds ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0', () => {});

db.run(`
CREATE TABLE IF NOT EXISTS guild_members (
  guild_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  joined_at INTEGER DEFAULT (strftime('%s','now')),
  PRIMARY KEY (guild_id, user_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`);
db.run('CREATE INDEX IF NOT EXISTS guild_members_user ON guild_members (user_id)');

db.run(`
CREATE TABLE IF NOT EXISTS guild_bans (
  guild_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  banned_by INTEGER NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  PRIMARY KEY (guild_id, user_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`);

// Invite links: /invite/<code>. No expiry / no use limit when null.
db.run(`
CREATE TABLE IF NOT EXISTS guild_invites (
  code TEXT PRIMARY KEY,
  guild_id INTEGER NOT NULL,
  creator_id INTEGER NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  expires_at INTEGER,
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (guild_id) REFERENCES guilds(id),
  FOREIGN KEY (creator_id) REFERENCES users(id)
);
`);

db.run(`
CREATE TABLE IF NOT EXISTS guild_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (guild_id) REFERENCES guilds(id)
);
`);

// category_id null = above every category, as in Discord.
db.run(`
CREATE TABLE IF NOT EXISTS guild_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id INTEGER NOT NULL,
  category_id INTEGER,
  name TEXT NOT NULL,
  type TEXT CHECK(type IN ('text', 'voice')) NOT NULL DEFAULT 'text',
  topic TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (guild_id) REFERENCES guilds(id),
  FOREIGN KEY (category_id) REFERENCES guild_categories(id)
);
`);

db.run(`
CREATE TABLE IF NOT EXISTS guild_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER DEFAULT (strftime('%s','now')),
  parent_message_id INTEGER,
  edited INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (channel_id) REFERENCES guild_channels(id),
  FOREIGN KEY (sender_id) REFERENCES users(id)
);
`);
db.run('CREATE INDEX IF NOT EXISTS guild_messages_channel ON guild_messages (channel_id, id)');

// Plain emoji (a guild isn't encrypted), one of each per person per message.
db.run(`
CREATE TABLE IF NOT EXISTS guild_reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  timestamp INTEGER DEFAULT (strftime('%s','now')),
  UNIQUE (message_id, user_id, emoji),
  FOREIGN KEY (message_id) REFERENCES guild_messages(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`);
db.run('CREATE INDEX IF NOT EXISTS guild_reactions_message ON guild_reactions (message_id)');

// How far each member has read each channel; unread = newer messages by someone else.
db.run(`
CREATE TABLE IF NOT EXISTS guild_channel_reads (
  user_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  last_read_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, channel_id)
);
`);

// ROLES. Every guild has an @everyone role (is_everyone = 1, position 0, always the bottom);
// higher positions rank higher. `permissions` is a bit field (permissions.js); `color` is
// 0xRRGGBB or null (no colour).
db.run(`
CREATE TABLE IF NOT EXISTS guild_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  color INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  permissions INTEGER NOT NULL DEFAULT 0,
  hoist INTEGER NOT NULL DEFAULT 0,
  is_everyone INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (guild_id) REFERENCES guilds(id)
);
`);
db.run('CREATE INDEX IF NOT EXISTS guild_roles_guild ON guild_roles (guild_id)');

// Which roles each member has (@everyone is implied, never stored here).
db.run(`
CREATE TABLE IF NOT EXISTS guild_member_roles (
  guild_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, role_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(id),
  FOREIGN KEY (role_id) REFERENCES guild_roles(id)
);
`);
db.run('CREATE INDEX IF NOT EXISTS guild_member_roles_guild ON guild_member_roles (guild_id)');

// Per-channel permission overrides for a role or a member: bits in `deny` are taken away, bits in
// `allow` given (a private channel denies VIEW_CHANNEL to @everyone).
db.run(`
CREATE TABLE IF NOT EXISTS guild_channel_overrides (
  channel_id INTEGER NOT NULL,
  target_type TEXT CHECK(target_type IN ('role', 'member')) NOT NULL,
  target_id INTEGER NOT NULL,
  allow INTEGER NOT NULL DEFAULT 0,
  deny INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, target_type, target_id),
  FOREIGN KEY (channel_id) REFERENCES guild_channels(id)
);
`);

// Custom emoji: plain images (not encrypted), stored as emojis/<id> in the
// object store and written `<:name:id>` in messages. A row is created before its upload and
// only counts (available = 1) once the uploader says the upload finished.
db.run(`
CREATE TABLE IF NOT EXISTS guild_emojis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  animated INTEGER NOT NULL DEFAULT 0,
  creator_id INTEGER NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  available INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (guild_id) REFERENCES guilds(id),
  FOREIGN KEY (creator_id) REFERENCES users(id)
);
`);
db.run('CREATE INDEX IF NOT EXISTS guild_emojis_guild ON guild_emojis (guild_id)');

// Each member's own order of their guilds in the server rail (lowest first).
db.run('ALTER TABLE guild_members ADD COLUMN position INTEGER NOT NULL DEFAULT 0', () => {});

// Guilds from before roles get their @everyone role (with the default permissions).
db.run(`
INSERT INTO guild_roles (guild_id, name, position, permissions, is_everyone)
SELECT g.id, '@everyone', 0, ${DEFAULT_EVERYONE_PERMISSIONS}, 1 FROM guilds g
WHERE NOT EXISTS (SELECT 1 FROM guild_roles r WHERE r.guild_id = g.id AND r.is_everyone = 1)
`);
});

// DIRECT MESSAGES
db.run(`
CREATE TABLE IF NOT EXISTS direct_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER DEFAULT (strftime('%s','now')),
  parent_message_id INTEGER,
  edited INTEGER DEFAULT 0,
  FOREIGN KEY (sender_id) REFERENCES users(id),
  FOREIGN KEY (recipient_id) REFERENCES users(id)
);
`);

// DM REACTIONS
// The emoji is encrypted (padded to a fixed size, so its length doesn't give it away); which
// message was reacted to, by whom and when is visible to the server, like reply links are.
db.serialize(() => {
db.run(`
CREATE TABLE IF NOT EXISTS dm_reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY (message_id) REFERENCES direct_messages(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`);
db.run(`CREATE INDEX IF NOT EXISTS dm_reactions_message ON dm_reactions (message_id)`);
});

// UNREAD DMS
db.run(`
CREATE TABLE IF NOT EXISTS dm_unread (
  user_id INTEGER NOT NULL,
  from_user_id INTEGER NOT NULL,
  count INTEGER DEFAULT 0 NOT NULL,
  PRIMARY KEY (user_id, from_user_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (from_user_id) REFERENCES users(id)
);
`);

// LOGIN STATES
db.run(`
CREATE TABLE IF NOT EXISTS login_states (
  username TEXT NOT NULL,
  server_login_state TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  PRIMARY KEY (username),
  FOREIGN KEY (username) REFERENCES users(username)
);
`);

// PUSH SUBSCRIPTIONS
db.run(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    subscription TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, endpoint)
  );
  `);
// Promise versions of the sqlite3 calls.
function get(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))
  );
}

function all(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  );
}

// Resolves to { lastID, changes }.
function run(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, function (err) { return err ? reject(err) : resolve(this); })
  );
}

module.exports = { db, get, all, run };
