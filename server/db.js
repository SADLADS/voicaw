const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./voicaw.db');

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
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL
);
`);

// USER ROLES
db.run(`
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);
`);

db.run(`
CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL,
  role_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, role_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (role_id) REFERENCES roles(id)
);
`);

// GUILDS
db.run(`
CREATE TABLE IF NOT EXISTS guilds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner INTEGER NOT NULL,
  name TEXT NOT NULL,
  FOREIGN KEY (owner) REFERENCES users(id)
);
`);

// CATEGORIES
db.run(`
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  position INTEGER DEFAULT 0,
  FOREIGN KEY (guild_id) REFERENCES guilds(id)
);
`);

// CHANNELS
db.run(`
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT CHECK(type IN ('text', 'voice')) NOT NULL,
  position INTEGER DEFAULT 0,
  FOREIGN KEY (category_id) REFERENCES categories(id)
);
`);

// CHANNEL PERMISSIONS
db.run(`
CREATE TABLE IF NOT EXISTS channel_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  target_type TEXT CHECK(target_type IN ('user', 'role')) NOT NULL,
  target_id INTEGER NOT NULL,
  allow TEXT,
  deny TEXT,
  FOREIGN KEY (channel_id) REFERENCES channels(id)
);
`);

// MESSAGES
db.run(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER DEFAULT (strftime('%s','now')),
  is_pinned INTEGER DEFAULT 0,
  parent_message_id INTEGER,
  FOREIGN KEY (channel_id) REFERENCES channels(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (parent_message_id) REFERENCES messages(id)
);
`);

// DIRECT MESSAGES
db.run(`
CREATE TABLE IF NOT EXISTS direct_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY (sender_id) REFERENCES users(id),
  FOREIGN KEY (recipient_id) REFERENCES users(id)
);
`);

// CUSTOM EMOJIS
db.run(`
CREATE TABLE IF NOT EXISTS emojis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  unicode TEXT,
  image_url TEXT,
  is_custom INTEGER DEFAULT 0
);
`);

// MESSAGE REACTIONS
db.run(`
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji),
  FOREIGN KEY (message_id) REFERENCES messages(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`);

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
module.exports = db;