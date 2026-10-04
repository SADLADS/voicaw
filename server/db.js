const { DatabaseSync } = require('node:sqlite');
const { AsyncLocalStorage } = require('node:async_hooks');
const { DEFAULT_EVERYONE_PERMISSIONS, PERMISSIONS } = require('./permissions');
const { searchHas, searchText } = require('./searchText');
const { uploadKeysIn } = require('./uploadKeys');

// Node's built-in SQLite (synchronous, no native build). WAL: reads never wait for a write, and
// commits only append to the log. busy_timeout covers other processes (scripts/admin.js).
// Foreign keys aren't enforced (they never were: deletes aren't ordered for it).
const sqlite = new DatabaseSync(process.env.DB_PATH || './voicaw.db', { enableForeignKeyConstraints: false });
sqlite.exec('PRAGMA journal_mode = WAL');
sqlite.exec('PRAGMA synchronous = NORMAL');
sqlite.exec('PRAGMA busy_timeout = 5000');

// A column added to an existing table: fails harmlessly ("duplicate column") once it exists.
function addColumn(sql) {
  try {
    sqlite.exec(sql);
  } catch (err) {
    if (!/duplicate column/.test(err.message)) throw err;
  }
}

// USERS
sqlite.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  avatar TEXT,
  description TEXT,
  last_online INTEGER DEFAULT (strftime('%s','now')), -- last seen online (unix s), or NULL
  account_created INTEGER DEFAULT (strftime('%s','now')),
  -- Public keys (base64 raw P-256 points): identity (ECDSA) signs encryption (ECDH).
  identity_key TEXT NOT NULL,
  encryption_key TEXT NOT NULL,
  encryption_key_signature TEXT NOT NULL,
  -- Both private keys, encrypted client-side with a key derived from OPAQUE's exportKey.
  key_backup TEXT NOT NULL
);
`);

// GUILDS (Discord style). Plain, not end-to-end encrypted: the server reads guild
// messages (only DMs and group DMs are encrypted). An earlier sketch left unused tables in old
// databases (roles, user_roles, categories, channels, channel_permissions, messages); they can
// be dropped. `guilds` is from that sketch too, hence `owner` and the ALTERs that update it.
sqlite.exec(`
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
// Recovery code (optional): SHA-256 of the code's auth value, and a second copy of the key
// backup encrypted with a key derived from the code (see the client's encryptionService).
addColumn('ALTER TABLE users ADD COLUMN recovery_verifier TEXT');
addColumn('ALTER TABLE users ADD COLUMN recovery_backup TEXT');
addColumn('ALTER TABLE users ADD COLUMN recovery_created INTEGER');
addColumn('ALTER TABLE guilds ADD COLUMN icon_version INTEGER NOT NULL DEFAULT 0');
addColumn('ALTER TABLE guilds ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0');

sqlite.exec(`
CREATE TABLE IF NOT EXISTS guild_members (
  guild_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  joined_at INTEGER DEFAULT (strftime('%s','now')),
  PRIMARY KEY (guild_id, user_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`);
sqlite.exec('CREATE INDEX IF NOT EXISTS guild_members_user ON guild_members (user_id)');

sqlite.exec(`
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
sqlite.exec(`
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

sqlite.exec(`
CREATE TABLE IF NOT EXISTS guild_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (guild_id) REFERENCES guilds(id)
);
`);

// category_id null = above every category, as in Discord. A thread ('thread') is a channel too,
// inside a text channel (`parent_id`; see Threads below), never in the channel list itself.
const CHANNEL_TYPES = "'text', 'voice', 'list', 'doc', 'thread'";
sqlite.exec(`
CREATE TABLE IF NOT EXISTS guild_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id INTEGER NOT NULL,
  category_id INTEGER,
  name TEXT NOT NULL,
  type TEXT CHECK(type IN (${CHANNEL_TYPES})) NOT NULL DEFAULT 'text',
  topic TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (guild_id) REFERENCES guilds(id),
  FOREIGN KEY (category_id) REFERENCES guild_categories(id)
);
`);

sqlite.exec(`
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
sqlite.exec('CREATE INDEX IF NOT EXISTS guild_messages_channel ON guild_messages (channel_id, id)');

// Plain emoji (a guild isn't encrypted), one of each per person per message.
sqlite.exec(`
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
sqlite.exec('CREATE INDEX IF NOT EXISTS guild_reactions_message ON guild_reactions (message_id)');

// How far each member has read each channel; unread = newer messages by someone else.
sqlite.exec(`
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
sqlite.exec(`
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
sqlite.exec('CREATE INDEX IF NOT EXISTS guild_roles_guild ON guild_roles (guild_id)');

// Which roles each member has (@everyone is implied, never stored here).
sqlite.exec(`
CREATE TABLE IF NOT EXISTS guild_member_roles (
  guild_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, role_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(id),
  FOREIGN KEY (role_id) REFERENCES guild_roles(id)
);
`);
sqlite.exec('CREATE INDEX IF NOT EXISTS guild_member_roles_guild ON guild_member_roles (guild_id)');

// Per-channel permission overrides for a role or a member: bits in `deny` are taken away, bits in
// `allow` given (a private channel denies VIEW_CHANNEL to @everyone).
sqlite.exec(`
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
sqlite.exec(`
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
sqlite.exec('CREATE INDEX IF NOT EXISTS guild_emojis_guild ON guild_emojis (guild_id)');

// Each member's own order of their guilds in the guild rail (lowest first).
addColumn('ALTER TABLE guild_members ADD COLUMN position INTEGER NOT NULL DEFAULT 0');

// MENTIONS. Each member chooses which of a guild's messages push to them: 'all', 'mentions'
// (the default) or 'none'. A role can be `mentionable` by anyone (else only with Mention
// Everyone). A message keeps whether it pinged @everyone/@here and which roles
// (`mention_roles`, a JSON array), and guild_mentions who it mentioned (only members who could
// see the channel then, never the sender), for pushes and unread mention counts.
addColumn("ALTER TABLE guild_members ADD COLUMN notify_level TEXT NOT NULL DEFAULT 'mentions'");
addColumn('ALTER TABLE guild_roles ADD COLUMN mentionable INTEGER NOT NULL DEFAULT 0');
addColumn('ALTER TABLE guild_messages ADD COLUMN mention_everyone INTEGER NOT NULL DEFAULT 0');
addColumn('ALTER TABLE guild_messages ADD COLUMN mention_roles TEXT');
sqlite.exec(`
CREATE TABLE IF NOT EXISTS guild_mentions (
  message_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
`);
sqlite.exec('CREATE INDEX IF NOT EXISTS guild_mentions_user ON guild_mentions (user_id, channel_id, message_id)');

// Channels a member muted (channelMutes.js): no unread marker and no pushes for them, except
// mentions of that member. `until` is unix s, or NULL until they unmute it.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS guild_channel_mutes (
  user_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  until INTEGER,
  PRIMARY KEY (user_id, channel_id)
);
`);

// A member's own notification level for one channel (channelMutes.js), overriding their level
// for the guild ('all', 'mentions' or 'none'); no row: the guild's.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS guild_channel_notify (
  user_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  level TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_id)
);
`);

// Each person's own pins and mutes for their DMs and group DMs (conversationSettings.js):
// kind 'dm' (target: the other person's id) or 'group' (target: the group's id). pinned_at is
// unix ms (the list's order), mute_until unix s or NULL (until unmuted).
sqlite.exec(`
CREATE TABLE IF NOT EXISTS conversation_settings (
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  pinned_at INTEGER,
  muted INTEGER NOT NULL DEFAULT 0,
  mute_until INTEGER,
  PRIMARY KEY (user_id, kind, target)
);
`);

// Guilds from before roles get their @everyone role (with the default permissions).
sqlite.exec(`
INSERT INTO guild_roles (guild_id, name, position, permissions, is_everyone)
SELECT g.id, '@everyone', 0, ${DEFAULT_EVERYONE_PERMISSIONS}, 1 FROM guilds g
WHERE NOT EXISTS (SELECT 1 FROM guild_roles r WHERE r.guild_id = g.id AND r.is_everyone = 1)
`);

// DIRECT MESSAGES
sqlite.exec(`
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
sqlite.exec(`
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
sqlite.exec(`CREATE INDEX IF NOT EXISTS dm_reactions_message ON dm_reactions (message_id)`);

// GROUP DMS (end-to-end encrypted; see routes/groupDms.js). Ids are UUIDs made by the creator
// (they're signed into the membership log). `owner_id` is null once the owner has left.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS group_dms (
  id TEXT PRIMARY KEY,
  name TEXT,
  owner_id INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);
`);
// The group's name, end-to-end encrypted (groupDms.js): `name_ciphertext` under epoch
// `name_epoch` (always the latest), `name_version` counting renames. `name` is the plaintext
// name of a group from before that (`name_version` 0); a member's app encrypts it and it's
// cleared.
addColumn('ALTER TABLE group_dms ADD COLUMN name_ciphertext TEXT');
addColumn('ALTER TABLE group_dms ADD COLUMN name_epoch INTEGER');
addColumn('ALTER TABLE group_dms ADD COLUMN name_version INTEGER NOT NULL DEFAULT 0');

// Who's in each group now (leaving or being removed deletes the row).
sqlite.exec(`
CREATE TABLE IF NOT EXISTS group_dm_members (
  group_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (group_id) REFERENCES group_dms(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`);
sqlite.exec('CREATE INDEX IF NOT EXISTS group_dm_members_user ON group_dm_members (user_id)');

// The membership log: every change, as the JSON its author signed with their identity key, in
// a hash chain (each record names the previous one), so the server can't add, drop or reorder
// changes without clients noticing.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS group_dm_log (
  group_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  record TEXT NOT NULL,
  signature TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_id INTEGER NOT NULL,
  target_id INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, seq),
  FOREIGN KEY (group_id) REFERENCES group_dms(id)
);
`);

// Key periods: a new one after every membership change (made by a member, lazily), for the
// members as of log entry `log_seq`. Each member gets the period's key encrypted for them.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS group_dm_epochs (
  group_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  log_seq INTEGER NOT NULL,
  creator_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, epoch),
  FOREIGN KEY (group_id) REFERENCES group_dms(id)
);
`);
sqlite.exec(`
CREATE TABLE IF NOT EXISTS group_dm_epoch_keys (
  group_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  envelope TEXT NOT NULL,
  PRIMARY KEY (group_id, epoch, user_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`);

sqlite.exec(`
CREATE TABLE IF NOT EXISTS group_dm_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER DEFAULT (strftime('%s','now')),
  parent_message_id INTEGER,
  edited INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (group_id) REFERENCES group_dms(id),
  FOREIGN KEY (sender_id) REFERENCES users(id)
);
`);
sqlite.exec('CREATE INDEX IF NOT EXISTS group_dm_messages_group ON group_dm_messages (group_id, id)');

// Encrypted like DM reactions (same fixed size), with the message's epoch key.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS group_dm_reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY (message_id) REFERENCES group_dm_messages(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`);
sqlite.exec('CREATE INDEX IF NOT EXISTS group_dm_reactions_message ON group_dm_reactions (message_id)');

// How far each member has read; unread = newer messages by others they can read.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS group_dm_reads (
  user_id INTEGER NOT NULL,
  group_id TEXT NOT NULL,
  last_read_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, group_id)
);
`);

// UNREAD DMS
sqlite.exec(`
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
sqlite.exec(`
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
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    subscription TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, endpoint)
  );
  `);
// ADMIN SETTINGS: app-wide settings a global admin edits (server/appSettings.js). A row
// overrides the .env value of the same setting; no row falls back to .env.
addColumn('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
// Profiles (profiles.js): all optional, shown to everyone logged in.
addColumn('ALTER TABLE users ADD COLUMN display_name TEXT');
addColumn('ALTER TABLE users ADD COLUMN custom_status TEXT');
addColumn('ALTER TABLE users ADD COLUMN bio TEXT');
addColumn('ALTER TABLE users ADD COLUMN avatar TEXT');
// Your own settings that follow your account (preferences.js; JSON, only those changed).
addColumn('ALTER TABLE users ADD COLUMN preferences TEXT');
// Your spellcheck dictionary, encrypted on your devices (dictionary.js), and its version.
addColumn('ALTER TABLE users ADD COLUMN dictionary TEXT');
addColumn('ALTER TABLE users ADD COLUMN dictionary_version INTEGER NOT NULL DEFAULT 0');
// The name an account's OPAQUE record was registered under, when it isn't its (lower-case)
// username: see usernames.js.
addColumn('ALTER TABLE users ADD COLUMN opaque_id TEXT');
// When the account was deleted (unix s; accounts.js), else NULL. The row stays as a tombstone.
addColumn('ALTER TABLE users ADD COLUMN deleted_at INTEGER');
// LOGIN SESSIONS (sessions.js): one row per logged-in device; a token is only good while its
// row is there. Tokens from before this table carry no session id: they're refused once issued
// before sessions_reset_at (set whenever a session is logged out from Settings).
sqlite.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  user_agent TEXT,
  ip TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
`);
addColumn('ALTER TABLE users ADD COLUMN sessions_reset_at INTEGER');
// The login a push subscription was saved under, so logging that out stops its notifications.
addColumn('ALTER TABLE push_subscriptions ADD COLUMN session_id TEXT');
sqlite.exec(`
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by INTEGER,
  updated_at INTEGER NOT NULL
);
`);

// GIF FAVOURITES (the emoji picker's GIFs tab): per user, the GIF as the picker shows it (JSON).
sqlite.exec(`
CREATE TABLE IF NOT EXISTS gif_favorites (
  user_id INTEGER NOT NULL,
  gif_id TEXT NOT NULL,
  gif TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, gif_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`);

// PINNED MESSAGES: when a message was pinned (unix s) and by whom; null = not pinned. Only
// which message is pinned is visible to the server (like reply links), never its content.
for (const table of ['direct_messages', 'guild_messages', 'group_dm_messages']) {
  addColumn(`ALTER TABLE ${table} ADD COLUMN pinned_at INTEGER`);
  addColumn(`ALTER TABLE ${table} ADD COLUMN pinned_by INTEGER`);
}

// POLLS (pollTimers.js): when each poll closes (its author registers it; in DMs and groups
// that's all the server knows about a poll), and whether its "poll ended" row has been
// posted. That row is a message with `system` = 'poll_end', the poll's author as sender, the
// poll as parent and no content: clients work out the result from the poll itself. 'call' is
// a call's row in a DM or group (callLog.js).
for (const table of ['direct_messages', 'guild_messages', 'group_dm_messages']) {
  addColumn(`ALTER TABLE ${table} ADD COLUMN system TEXT`);
}
sqlite.exec(`
CREATE TABLE IF NOT EXISTS poll_timers (
  kind TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  announced INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, message_id)
);
`);
sqlite.exec('CREATE INDEX IF NOT EXISTS poll_timers_due ON poll_timers (announced, ends_at)');

// WEBHOOKS (routes/webhooks.js, Discord's API): a URL with a secret token that posts into one
// text channel, with its own name and picture. Messages it posts are guild_messages with
// sender_id 0 (no user) and the webhook's name and picture as they were when sent (so old
// messages keep them), plus Discord's embeds and attachments (JSON).
sqlite.exec(`
CREATE TABLE IF NOT EXISTS guild_webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  avatar TEXT,
  token TEXT NOT NULL,
  creator_id INTEGER,
  created_at INTEGER NOT NULL
);
`);
sqlite.exec('CREATE INDEX IF NOT EXISTS guild_webhooks_channel ON guild_webhooks (channel_id)');
addColumn('ALTER TABLE guild_messages ADD COLUMN webhook_id INTEGER');
addColumn('ALTER TABLE guild_messages ADD COLUMN webhook_name TEXT');
addColumn('ALTER TABLE guild_messages ADD COLUMN webhook_avatar TEXT');
addColumn('ALTER TABLE guild_messages ADD COLUMN embeds TEXT');
addColumn('ALTER TABLE guild_messages ADD COLUMN attachments TEXT');
addColumn('ALTER TABLE guild_messages ADD COLUMN flags INTEGER NOT NULL DEFAULT 0');
addColumn('ALTER TABLE guild_messages ADD COLUMN edited_at INTEGER');

// GUILD AUDIT LOG (auditLog.js): who did what in a guild, and when. `actor_id` is the user
// (null when a webhook acted with its token: `actor_webhook_id`); `target_type`/`target_id`
// what it was done to (a user, role, channel, category, invite code, emoji or webhook);
// `channel_id` the channel it happened in or to, and `private` whether that channel was
// private then (for entries that outlive it). `details` is JSON with the names as they were
// and what changed. Never a message's content. Kept RETENTION_DAYS.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS guild_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor_id INTEGER,
  actor_webhook_id INTEGER,
  target_type TEXT,
  target_id TEXT,
  channel_id INTEGER,
  private INTEGER NOT NULL DEFAULT 0,
  details TEXT,
  created_at INTEGER NOT NULL
);
`);
sqlite.exec('CREATE INDEX IF NOT EXISTS guild_audit_log_guild ON guild_audit_log (guild_id, id)');

// LIST CHANNELS (routes/guildTasks.js, guildTasks.js): a board's tasks, in a tree (`parent_id`
// null: top level; `position` orders siblings), who each is assigned to, and comments on each.
// `due_date` is a day ('YYYY-MM-DD', no time zone); `completed_at` unix s or null.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS guild_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  parent_id INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  description TEXT,
  due_date TEXT,
  completed_at INTEGER,
  completed_by INTEGER,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS guild_tasks_channel ON guild_tasks (channel_id, parent_id, position);
CREATE TABLE IF NOT EXISTS guild_task_assignees (
  task_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  assigned_by INTEGER,
  assigned_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX IF NOT EXISTS guild_task_assignees_user ON guild_task_assignees (user_id);
CREATE TABLE IF NOT EXISTS guild_task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX IF NOT EXISTS guild_task_comments_task ON guild_task_comments (task_id, id);
`);

// DOCUMENT CHANNELS (routes/guildDocuments.js, guildDocuments.js): each document's title,
// optional cover image (an upload's URL, like a message attachment's), markdown content, who
// wrote and last changed it, and `version` (bumped on every save, so a save over someone
// else's newer one is refused). Reactions on a document; replies are guild_messages with
// `document_id` set (null: an ordinary channel message).
sqlite.exec(`
CREATE TABLE IF NOT EXISTS guild_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  cover TEXT,
  content TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_by INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS guild_documents_channel ON guild_documents (channel_id, id);
CREATE TABLE IF NOT EXISTS guild_document_reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  UNIQUE (document_id, user_id, emoji)
);
`);
addColumn('ALTER TABLE guild_messages ADD COLUMN document_id INTEGER');
sqlite.exec('CREATE INDEX IF NOT EXISTS guild_messages_document ON guild_messages (document_id, id) WHERE document_id IS NOT NULL');

// UPLOADS (uploads.js): every file in the `uploads` bucket since the registry, and what links
// to it (`kind` 'dm' | 'group' | 'guild' | 'doc' with the owner's id, or 'kept' with 0). A file
// is deleted once it was linked and isn't any more, or was never linked within a day.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS uploads (
  key TEXT PRIMARY KEY,
  user_id INTEGER,
  created_at INTEGER NOT NULL,
  linked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS upload_refs (
  kind TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (kind, owner_id, key)
);
CREATE INDEX IF NOT EXISTS upload_refs_key ON upload_refs (key);
`);

// GUILD SEARCH (routes/guildSearch.js): each message's words (searchText.js) in a full-text
// index, rowid = the message's id, and what it has (`has:` bits) in `search_has`. Whoever
// writes a message's content, embeds or attachments calls indexGuildMessage (below); deleting
// the message takes its words with it (the trigger).
addColumn('ALTER TABLE guild_messages ADD COLUMN search_has INTEGER NOT NULL DEFAULT 0');
sqlite.exec("CREATE VIRTUAL TABLE IF NOT EXISTS guild_messages_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2')");
sqlite.exec(`
CREATE TRIGGER IF NOT EXISTS guild_messages_fts_delete AFTER DELETE ON guild_messages BEGIN
  DELETE FROM guild_messages_fts WHERE rowid = old.id;
END;
`);

function indexRow(row) {
  sqlite.prepare('UPDATE guild_messages SET search_has = ? WHERE id = ?').run(searchHas(row), row.id);
  sqlite.prepare('DELETE FROM guild_messages_fts WHERE rowid = ?').run(row.id);
  const text = searchText(row);
  if (text) sqlite.prepare('INSERT INTO guild_messages_fts (rowid, text) VALUES (?, ?)').run(row.id, text);
}

// "Alice" becomes "alice", with "Alice" as the display name unless there already is one, and
// opaque_id keeping "Alice" so the password still works. An account whose lower-case name is
// already taken keeps its capitals (it logs in with them exactly). Migration 5; exported for
// its test.
function lowercaseUsernames() {
  const users = sqlite.prepare('SELECT id, username, display_name FROM users ORDER BY id').all();
  const taken = new Set(users.filter((u) => u.username === u.username.toLowerCase()).map((u) => u.username));
  const rename = sqlite.prepare(
    'UPDATE users SET username = ?, opaque_id = ?, display_name = COALESCE(display_name, ?) WHERE id = ?'
  );
  for (const user of users) {
    const lower = user.username.toLowerCase();
    if (lower === user.username || taken.has(lower)) continue;
    taken.add(lower);
    // Display names are at most 32 characters (profiles.js); usernames never had a limit.
    rename.run(lower, user.username, user.username.length <= 32 ? user.username : null, user.id);
  }
}

// Migrations 6, 8 and 10: unless guild_channels' type CHECK already has `type` (SQL-quoted),
// copies the table into a new one whose CHECK has every type there is now (SQLite can't change a
// CHECK), with every column it has (those added later, like `nsfw`, included).
function allowEveryChannelType(type) {
  const { sql } = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'guild_channels'").get();
  if (sql.includes(type)) return;
  // Keep the id counter, so deleted channels' ids (the audit log has them) aren't reused.
  const seq = sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'guild_channels'").get()?.seq ?? 0;
  const columns = sqlite.prepare('PRAGMA table_info(guild_channels)').all().map((c) => c.name).join(', ');
  const newSql = sql
    .replace(/CREATE TABLE (IF NOT EXISTS )?"?guild_channels"?/, 'CREATE TABLE guild_channels_new')
    .replace(/CHECK\s*\(\s*type IN \([^)]*\)\s*\)/, `CHECK(type IN (${CHANNEL_TYPES}))`);
  sqlite.exec(`
    ${newSql};
    INSERT INTO guild_channels_new (${columns}) SELECT ${columns} FROM guild_channels;
    DROP TABLE guild_channels;
    ALTER TABLE guild_channels_new RENAME TO guild_channels;
  `);
  sqlite.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'guild_channels'").run(seq);
}

// Migration 9: registers and links every upload guild messages and documents show.
function linkExistingGuildUploads() {
  const at = Math.floor(Date.now() / 1000);
  const register = sqlite.prepare('INSERT OR IGNORE INTO uploads (key, user_id, created_at, linked) VALUES (?, NULL, ?, 1)');
  const link = sqlite.prepare('INSERT OR IGNORE INTO upload_refs (kind, owner_id, key) VALUES (?, ?, ?)');
  const add = (kind, id, text) => {
    for (const key of uploadKeysIn(text)) {
      register.run(key, at);
      link.run(kind, id, key);
    }
  };
  for (const row of sqlite.prepare('SELECT id, content, embeds, attachments FROM guild_messages').all()) {
    add('guild', row.id, [row.content, row.embeds, row.attachments].filter(Boolean).join('\n'));
  }
  for (const row of sqlite.prepare('SELECT id, content, cover FROM guild_documents').all()) {
    add('doc', row.id, [row.content, row.cover].filter(Boolean).join('\n'));
  }
}

// Changes to existing data that must happen once, numbered in SQLite's user_version (add the
// next one at the end; each runs in its own transaction with its version bump):
const MIGRATIONS = [
  // 1. Voice channels: @everyone gets Connect and Speak, as in new guilds.
  () => sqlite.exec(`UPDATE guild_roles SET permissions = permissions | ${PERMISSIONS.CONNECT | PERMISSIONS.SPEAK} WHERE is_everyone = 1`),
  // 2. users.last_online was never updated (it held the sign-up time): unknown until next seen.
  () => sqlite.exec('UPDATE users SET last_online = NULL'),
  // 3. Pin Messages is new (it used to be part of Manage Messages, as in Discord): roles and
  // channel overrides that allow (or deny) Manage Messages allow (or deny) pinning too.
  () => {
    const manage = PERMISSIONS.MANAGE_MESSAGES;
    const pin = PERMISSIONS.PIN_MESSAGES;
    sqlite.exec(`UPDATE guild_roles SET permissions = permissions | ${pin} WHERE permissions & ${manage} = ${manage}`);
    sqlite.exec(`UPDATE guild_channel_overrides SET allow = allow | ${pin} WHERE allow & ${manage} = ${manage}`);
    sqlite.exec(`UPDATE guild_channel_overrides SET deny = deny | ${pin} WHERE deny & ${manage} = ${manage}`);
  },
  // 4. Guild search is new: index every message sent before it.
  () => {
    for (const row of sqlite.prepare('SELECT id, content, embeds, attachments FROM guild_messages').all()) indexRow(row);
  },
  // 5. Usernames are lower case (usernames.js).
  () => lowercaseUsernames(),
  // 6. List channels: guild_channels' type CHECK gains 'list' (SQLite can't change a CHECK, so
  // the table is copied into a new one), and @everyone gets Edit Tasks, as in new guilds.
  () => {
    allowEveryChannelType("'list'");
    sqlite.exec(`UPDATE guild_roles SET permissions = permissions | ${PERMISSIONS.EDIT_TASKS} WHERE is_everyone = 1`);
  },
  // 7. Screen sharing: @everyone gets Video (Stream), as in new guilds.
  () => sqlite.exec(`UPDATE guild_roles SET permissions = permissions | ${PERMISSIONS.STREAM} WHERE is_everyone = 1`),
  // 8. Document channels: the type CHECK gains 'doc' (as in 6), and @everyone gets Create
  // Documents, as in new guilds.
  () => {
    allowEveryChannelType("'doc'");
    sqlite.exec(`UPDATE guild_roles SET permissions = permissions | ${PERMISSIONS.CREATE_DOCUMENTS} WHERE is_everyone = 1`);
  },
  // 9. Uploads are tracked: the files guild messages and documents show join the registry,
  // linked to them, so they go when those do. Encrypted chats' files can't be read here: they
  // stay untracked (never deleted).
  () => linkExistingGuildUploads(),
  // 10. Threads: the type CHECK gains 'thread' (as in 6), and @everyone gets Create Threads and
  // Send Messages in Threads, as in new guilds.
  () => {
    allowEveryChannelType("'thread'");
    const bits = PERMISSIONS.CREATE_THREADS | PERMISSIONS.SEND_MESSAGES_IN_THREADS;
    sqlite.exec(`UPDATE guild_roles SET permissions = permissions | ${bits} WHERE is_everyone = 1`);
  },
  // 11. Watch Together: @everyone gets Queue Videos and Control Playback, as in new guilds
  // (Manage Queue isn't a default).
  () => {
    const bits = PERMISSIONS.QUEUE_VIDEOS | PERMISSIONS.CONTROL_PLAYBACK;
    sqlite.exec(`UPDATE guild_roles SET permissions = permissions | ${bits} WHERE is_everyone = 1`);
  },
];
for (let version = sqlite.prepare('PRAGMA user_version').get().user_version; version < MIGRATIONS.length; version++) {
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    MIGRATIONS[version]();
    sqlite.exec(`PRAGMA user_version = ${version + 1}`);
    sqlite.exec('COMMIT');
  } catch (err) {
    sqlite.exec('ROLLBACK');
    throw err;
  }
}

// NSFW channels (docs/guilds.md): their media is covered until clicked. Added after the
// migrations, since 6 and 8 copy guild_channels column by column (allowEveryChannelType).
addColumn('ALTER TABLE guild_channels ADD COLUMN nsfw INTEGER NOT NULL DEFAULT 0');

// THREADS (threads.js, docs/guilds.md): a thread is a guild_channels row of type 'thread' in
// text channel `parent_id` (category_id stays null), started by `owner_id`, from message
// `starter_message_id` in that channel (for a thread started on its own, the "started a thread"
// row posted for it). `last_activity` (unix s) moves on with every message; a thread is archived
// when `archived` is set or nothing happened for a week. Its members (guild_thread_members) are
// whoever started it, posted in it, was mentioned in it or joined it: it shows in their channel
// list and counts as unread for them.
addColumn('ALTER TABLE guild_channels ADD COLUMN parent_id INTEGER');
addColumn('ALTER TABLE guild_channels ADD COLUMN owner_id INTEGER');
addColumn('ALTER TABLE guild_channels ADD COLUMN starter_message_id INTEGER');
addColumn('ALTER TABLE guild_channels ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
addColumn('ALTER TABLE guild_channels ADD COLUMN created_at INTEGER');
addColumn('ALTER TABLE guild_channels ADD COLUMN last_activity INTEGER');
sqlite.exec(`
CREATE INDEX IF NOT EXISTS guild_channels_parent ON guild_channels (parent_id) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS guild_channels_starter ON guild_channels (starter_message_id) WHERE starter_message_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS guild_thread_members (
  thread_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);
CREATE INDEX IF NOT EXISTS guild_thread_members_user ON guild_thread_members (user_id);
`);

// BOTS (bots.js, docs/bots.md): an application made in the developer portal has one bot, a
// users row with `bot` = 1 (no password or keys: it can't log in or use encrypted chats) whose
// id is the application's id, as in Discord. Its token is shown once; only its SHA-256 is kept.
// A bot added to a guild is a member with its own role (`guild_roles.bot_id`), holding the
// permissions it was added with; that role can't be deleted or given to anyone else.
addColumn('ALTER TABLE users ADD COLUMN bot INTEGER NOT NULL DEFAULT 0');
addColumn('ALTER TABLE guild_roles ADD COLUMN bot_id INTEGER');
sqlite.exec(`
CREATE TABLE IF NOT EXISTS bot_applications (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  public INTEGER NOT NULL DEFAULT 1,
  token_hash TEXT,
  token_reset_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_applications_owner ON bot_applications (owner_id);
`);

// APPLICATION COMMANDS AND INTERACTIONS (commands.js, interactions.js, docs/bots.md): a bot's
// slash and context-menu commands, everywhere it is (`guild_id` 0) or in one guild, as
// Discord's command object (`options` JSON, `default_member_permissions` our bits or NULL).
// An interaction is someone using one, or a bot's button, select or form: `token_hash` is the
// SHA-256 of its token (follow-ups for 15 minutes), `response_message_id` the reply it made
// (null while none, or ephemeral: those live only in memory). A message's `components` are
// Discord's (JSON); `interaction` (JSON) says which command it answers and who used it.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS bot_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  guild_id INTEGER NOT NULL DEFAULT 0,
  type INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  options TEXT,
  localizations TEXT,
  default_member_permissions INTEGER,
  nsfw INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (application_id, guild_id, type, name)
);
CREATE INDEX IF NOT EXISTS bot_commands_guild ON bot_commands (guild_id);
CREATE TABLE IF NOT EXISTS bot_interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  type INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  guild_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  message_id INTEGER,
  command_name TEXT,
  command_type INTEGER,
  target_id INTEGER,
  response_type INTEGER,
  response_message_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_interactions_created ON bot_interactions (created_at);
CREATE INDEX IF NOT EXISTS bot_interactions_token ON bot_interactions (token_hash);
`);
addColumn('ALTER TABLE guild_messages ADD COLUMN components TEXT');
addColumn('ALTER TABLE guild_messages ADD COLUMN interaction TEXT');

// ---- Queries ----
// get / all / run return promises (callers await them) though the driver is synchronous, and
// wait while another request's transaction is open (see transaction).

const statements = new Map();
function prepare(sql) {
  let statement = statements.get(sql);
  if (!statement) {
    if (statements.size >= 1000) statements.clear();
    statement = sqlite.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}

// As the old sqlite3 driver bound them: undefined as NULL, booleans as 1/0.
function bind(params) {
  const list = Array.isArray(params) ? params : [params];
  return list.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));
}

// Plain objects (the driver's rows have no prototype).
const plain = (row) => (row ? { ...row } : row);

// The open transaction: { token, done }. Only its own code (same async context) runs queries.
let open = null;
const context = new AsyncLocalStorage();
async function turn() {
  while (open && context.getStore() !== open.token) await open.done;
}

async function get(sql, params = []) {
  await turn();
  return plain(prepare(sql).get(...bind(params)));
}

async function all(sql, params = []) {
  await turn();
  return prepare(sql).all(...bind(params)).map(plain);
}

// Resolves to { lastID, changes }.
async function run(sql, params = []) {
  await turn();
  const { lastInsertRowid, changes } = prepare(sql).run(...bind(params));
  return { lastID: Number(lastInsertRowid), changes: Number(changes) };
}

// Runs `fn` (async, using get/all/run as usual) as one transaction: all its writes are kept, or
// none if it throws (the error is rethrown). Other requests' queries wait until it's done, so keep
// it to database work (no network, uploads or pushes inside). A nested call is a savepoint: if it
// throws, only its own writes are undone, and the outer transaction can carry on.
let savepoints = 0;
async function transaction(fn) {
  if (open && context.getStore() === open.token) {
    const name = `sp${++savepoints}`;
    sqlite.exec(`SAVEPOINT ${name}`);
    try {
      const result = await fn();
      sqlite.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      sqlite.exec(`ROLLBACK TO ${name}`);
      sqlite.exec(`RELEASE ${name}`);
      throw err;
    }
  }
  await turn();
  let finish;
  open = { token: Symbol('transaction'), done: new Promise((resolve) => { finish = resolve; }) };
  try {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = await context.run(open.token, fn);
      sqlite.exec('COMMIT');
      return result;
    } catch (err) {
      if (sqlite.isTransaction) sqlite.exec('ROLLBACK');
      throw err;
    }
  } finally {
    open = null;
    finish();
  }
}

// (Re)indexes guild message `id` for search after its content, embeds or attachments changed,
// and links it to the uploads it shows (uploads.js). Call it inside the transaction that wrote
// them.
async function indexGuildMessage(id) {
  const row = await get('SELECT id, content, embeds, attachments FROM guild_messages WHERE id = ?', [id]);
  if (!row) return;
  indexRow(row);
  const uploads = require('./uploads');
  await uploads.linkUploads('guild', row.id, uploads.guildMessageKeys(row));
}

module.exports = { db: sqlite, get, all, run, transaction, indexGuildMessage, lowercaseUsernames };
