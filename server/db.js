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

// CHANNELS
db.run(`
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT CHECK(type IN ('text', 'voice')) NOT NULL,
  position INTEGER DEFAULT 0
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
  name TEXT NOT NULL,
  image_url TEXT NOT NULL
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

module.exports = db;