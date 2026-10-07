const crypto = require('crypto');
const db = require('./db');
const { PERMISSIONS, ALL_PERMISSIONS, has } = require('./permissions');
const { getMember, getGuildLayout, getMemberListEntry, sendToGuild, announceGuildUpdate, markGuildRead } = require('./guilds');
const { sendToUserSockets, getStatus } = require('./sockets');
const { logAudit } = require('./auditLog');

// Bots (docs/bots.md): applications made in the developer portal (routes/applications.js),
// each with one bot user that programs drive through Discord's API (routes/botApi.js, gateway.js).
// - A bot is a users row with `bot` = 1, no password and no keys: it can't log in, isn't in the
//   encrypted DM list and can't be in DMs, group DMs or calls (all end-to-end encrypted). It's in
//   guilds, and in its own unencrypted DMs with people (botDms.js). Its username is
//   "<name>#<4 digits>" ('#' can't be signed up with), its display
//   name the application's name, its bio the description.
// - Its token is Discord's shape (the user id in base64, a time, a secret), shown once; only
//   its SHA-256 is stored. Resetting it ends every gateway session using the old one.
// - Added to a guild by someone with Manage Guild (POST /oauth2/authorize), it gets its own role
//   (`guild_roles.bot_id`) with the permissions it asked for that they have. That role can be
//   edited but not deleted or given to anyone else; it goes when the bot leaves.

const MAX_APPLICATIONS = 25; // per person, as in Discord
const MAX_NAME = 32;
const MAX_DESCRIPTION = 190; // a bio's length (profiles.js)

const now = () => Math.floor(Date.now() / 1000);

// ---- Names ----

// The username part of a name: lower case letters, digits, _ and . (Discord's), else "bot".
function usernameSlug(name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9_.]+/g, '').slice(0, 24);
  return slug || 'bot';
}

// A free "<slug>#<4 digits>", keeping `discriminator` if given and still free.
async function freeUsername(name, discriminator = null) {
  const slug = usernameSlug(name);
  const taken = async (username) => Boolean(await db.get('SELECT 1 FROM users WHERE username = ?', [username]));
  if (discriminator && !(await taken(`${slug}#${discriminator}`))) return `${slug}#${discriminator}`;
  for (let i = 0; i < 50; i++) {
    const candidate = `${slug}#${String(crypto.randomInt(1, 10000)).padStart(4, '0')}`;
    if (!(await taken(candidate))) return candidate;
  }
  throw new Error('No free bot username');
}

// "mybot#0420" -> { username: 'mybot', discriminator: '0420' }.
function splitUsername(username) {
  const at = String(username).lastIndexOf('#');
  return at < 0 ? { username, discriminator: '0' } : { username: username.slice(0, at), discriminator: username.slice(at + 1) };
}

// ---- Tokens ----

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// Discord's shape: base64 of the bot's id, base64 of the time, and 32 random characters.
function newToken(botId) {
  const time = Buffer.alloc(4);
  time.writeUInt32BE(now());
  return [Buffer.from(String(botId)).toString('base64url'), time.toString('base64url'), crypto.randomBytes(24).toString('base64url')].join('.');
}

// A new token for application `id` (the old one stops working). Returns it: it's never stored.
async function resetToken(id) {
  const token = newToken(id);
  await db.run('UPDATE bot_applications SET token_hash = ?, token_reset_at = ? WHERE id = ?', [hashToken(token), now(), id]);
  // Gateway sessions with the old token end (gateway.js listens).
  require('./gateway').closeBotSessions(id, 4004, 'Authentication failed.');
  return token;
}

// The bot user ({ id, username, display_name, avatar, application }) a token belongs to, or null.
// Takes "Bot <token>" or the token alone.
async function botForToken(raw) {
  const token = String(raw ?? '').replace(/^Bot\s+/i, '').trim();
  const [idPart] = token.split('.');
  if (!idPart) return null;
  const id = Number(Buffer.from(idPart, 'base64url').toString());
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const app = await db.get('SELECT * FROM bot_applications WHERE id = ?', [id]);
  if (!app?.token_hash) return null;
  const a = Buffer.from(app.token_hash, 'hex');
  const b = Buffer.from(hashToken(token), 'hex');
  if (!crypto.timingSafeEqual(a, b)) return null;
  const user = await db.get('SELECT id, username, display_name, avatar, bio FROM users WHERE id = ? AND bot = 1 AND deleted_at IS NULL', [id]);
  return user ? { ...user, bot: true, application: app } : null;
}

// ---- Applications ----

function cleanAppName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  return name.length >= 2 && name.length <= MAX_NAME ? name : null;
}

function cleanDescription(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return undefined;
  const text = value.trim().replace(/\n{3,}/g, '\n\n');
  if (text.length > MAX_DESCRIPTION) return undefined;
  return text || null;
}

// Makes an application and its bot for `ownerId`. Resolves to { id, token }.
async function createApplication(ownerId, name) {
  const { count } = await db.get('SELECT COUNT(*) AS count FROM bot_applications WHERE owner_id = ?', [ownerId]);
  if (count >= MAX_APPLICATIONS) return { error: `You can have up to ${MAX_APPLICATIONS} applications` };
  const username = await freeUsername(name);
  const id = await db.transaction(async () => {
    const { lastID } = await db.run(
      `INSERT INTO users (username, display_name, password, identity_key, encryption_key, encryption_key_signature, key_backup, bot, last_online)
       VALUES (?, ?, '', '', '', '', '', 1, NULL)`,
      [username, name]
    );
    await db.run('INSERT INTO bot_applications (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)', [lastID, ownerId, name, now()]);
    return lastID;
  });
  return { id, token: await resetToken(id) };
}

// The guilds the bot is in.
async function botGuildIds(botId) {
  return (await db.all('SELECT guild_id FROM guild_members WHERE user_id = ?', [botId])).map((r) => r.guild_id);
}

// The application as its owner sees it in the portal.
async function applicationFor(app) {
  const user = await db.get('SELECT username, avatar FROM users WHERE id = ?', [app.id]);
  const guilds = await db.all(
    'SELECT g.id, g.name, g.icon_version FROM guilds g JOIN guild_members gm ON gm.guild_id = g.id WHERE gm.user_id = ? ORDER BY g.name COLLATE NOCASE',
    [app.id]
  );
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    public: Boolean(app.public),
    created_at: app.created_at,
    token_reset_at: app.token_reset_at,
    // Login with Voicaw (oauth.js): whether it has a client secret yet (never shown again), and
    // where it may send people back to.
    client_secret_reset_at: app.client_secret_reset_at ?? null,
    redirect_uris: require('./oauth').redirectUrisOf(app),
    bot: { id: app.id, ...splitUsername(user.username), avatar: user.avatar },
    guilds,
  };
}

// Changes name, description, `public` and `redirect_uris`; the bot's profile follows. Returns
// an error or null.
async function updateApplication(app, body) {
  const updates = {};
  if (body.redirect_uris !== undefined) {
    const { list, error } = require('./oauth').cleanRedirectUris(body.redirect_uris);
    if (error) return error;
    updates.redirect_uris = JSON.stringify(list);
  }
  if (body.name !== undefined) {
    updates.name = cleanAppName(body.name);
    if (!updates.name) return `Names are 2–${MAX_NAME} characters`;
  }
  if (body.description !== undefined) {
    updates.description = cleanDescription(body.description);
    if (updates.description === undefined) return `Descriptions are up to ${MAX_DESCRIPTION} characters`;
  }
  if (body.public !== undefined) updates.public = body.public ? 1 : 0;
  const keys = Object.keys(updates);
  if (!keys.length) return null;
  const user = await db.get('SELECT username FROM users WHERE id = ?', [app.id]);
  const username = updates.name ? await freeUsername(updates.name, splitUsername(user.username).discriminator) : user.username;
  await db.transaction(async () => {
    await db.run(`UPDATE bot_applications SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => updates[k]), app.id]);
    await db.run(
      'UPDATE users SET username = ?, display_name = COALESCE(?, display_name), bio = CASE WHEN ? THEN ? ELSE bio END WHERE id = ?',
      [username, updates.name ?? null, updates.description !== undefined ? 1 : 0, updates.description ?? null, app.id]
    );
  });
  await announceProfile(app.id);
  return null;
}

// Everyone sees the bot's new name or picture (as with people's: user_profile).
async function announceProfile(botId) {
  const { PROFILE_COLUMNS } = require('./profiles');
  const profile = await db.get(`SELECT id, username, bot, deleted_at, ${PROFILE_COLUMNS} FROM users WHERE id = ?`, [botId]);
  require('./sockets').sendToAllSockets({ type: 'user_profile', user: profile });
}

// Takes the bot out of every guild, ends its sessions, and deletes the application. The bot
// user stays as a deleted account, so its messages keep an author.
async function deleteApplication(app) {
  require('./gateway').closeBotSessions(app.id, 4004, 'Authentication failed.');
  for (const guildId of await botGuildIds(app.id)) await require('./guilds').removeMember(guildId, app.id);
  await require('./avatars').removeAvatar(app.id);
  const dms = await db.all('SELECT id, user_id FROM bot_dms WHERE bot_id = ?', [app.id]);
  await db.transaction(async () => {
    await db.run('DELETE FROM bot_applications WHERE id = ?', [app.id]);
    // Sites logged in with it lose access (oauth.js).
    await require('./oauth').forgetApplication(app.id);
    // Its DMs go too (botDms.js).
    await require('./botDms').forgetBot(app.id);
    await db.run(
      "UPDATE users SET username = ?, display_name = ?, bio = NULL, deleted_at = ? WHERE id = ?",
      [`Deleted-Bot-${app.id}`, app.name, now(), app.id]
    );
  });
  for (const dm of dms) sendToUserSockets(dm.user_id, { type: 'bot_dm_delete', dmId: dm.id });
  require('./uploads').releaseUploads();
  await announceProfile(app.id);
}

// ---- Guilds ----

// Who may add the application: anyone if it's public, else only its owner.
const mayAdd = (app, userId) => Boolean(app.public) || app.owner_id === userId;

// The guilds `userId` could add bot `botId` to: those where they have Manage Guild and it isn't.
async function guildsToAddTo(userId, botId) {
  const rows = await db.all(
    `SELECT g.id, g.name, g.icon_version FROM guilds g JOIN guild_members gm ON gm.guild_id = g.id
     WHERE gm.user_id = ? AND NOT EXISTS (SELECT 1 FROM guild_members b WHERE b.guild_id = g.id AND b.user_id = ?)
     ORDER BY gm.position, g.id`,
    [userId, botId]
  );
  const result = [];
  for (const guild of rows) {
    const member = await getMember(guild.id, userId);
    if (has(member.permissions, PERMISSIONS.MANAGE_GUILD)) result.push({ ...guild, my_permissions: member.permissions });
  }
  return result;
}

// Adds the bot to the guild for `adder` (a member context with Manage Guild), with its own role
// holding `permissions` (our bits; only those the adder has). Returns an error or null.
async function addBotToGuild(app, adder, permissions) {
  const guildId = adder.guild.id;
  if (!has(adder.permissions, PERMISSIONS.MANAGE_GUILD)) return { status: 403, error: "You don't have permission to add bots to this guild" };
  if (await getMember(guildId, app.id)) return { status: 400, error: 'That bot is already in this guild' };
  if (await db.get('SELECT 1 FROM guild_bans WHERE guild_id = ? AND user_id = ?', [guildId, app.id])) {
    return { status: 403, error: 'That bot is banned from this guild' };
  }
  const granted = (Number(permissions) || 0) & ALL_PERMISSIONS & adder.permissions;
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO guild_members (guild_id, user_id, position)
       VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM guild_members WHERE user_id = ?))`,
      [guildId, app.id, app.id]
    );
    await markGuildRead(guildId, app.id);
    // Its role goes just above @everyone, like a new role.
    await db.run('UPDATE guild_roles SET position = position + 1 WHERE guild_id = ? AND is_everyone = 0', [guildId]);
    const { lastID: roleId } = await db.run(
      'INSERT INTO guild_roles (guild_id, name, position, permissions, bot_id) VALUES (?, ?, 1, ?, ?)',
      [guildId, app.name.slice(0, 100), granted, app.id]
    );
    await db.run('INSERT INTO guild_member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)', [guildId, app.id, roleId]);
    await logAudit({
      guildId,
      action: 'bot_add',
      actorId: adder.userId,
      targetType: 'user',
      targetId: app.id,
      details: { name: app.name, permissions: granted },
    });
  });
  const joined = await getMemberListEntry(guildId, app.id);
  sendToUserSockets(app.id, { type: 'guild_add', guild: await getGuildLayout(guildId, app.id) });
  await sendToGuild(guildId, { type: 'guild_member_add', guildId, member: { ...joined, status: getStatus(app.id) } });
  await announceGuildUpdate(guildId);
  const joinLog = require('./joinLog');
  await joinLog.logMembership(guildId, app.id, joinLog.JOIN);
  return null;
}

// After a bot left (or was kicked or banned from) a guild: its role goes too. Inside
// removeMember's transaction.
async function removeBotRole(guildId, botId) {
  const role = await db.get('SELECT id FROM guild_roles WHERE guild_id = ? AND bot_id = ?', [guildId, botId]);
  if (!role) return false;
  await db.run('DELETE FROM guild_member_roles WHERE role_id = ?', [role.id]);
  await db.run(`DELETE FROM guild_channel_overrides WHERE target_type = 'role' AND target_id = ?`, [role.id]);
  await db.run('DELETE FROM guild_roles WHERE id = ?', [role.id]);
  return true;
}

module.exports = {
  MAX_APPLICATIONS,
  MAX_NAME,
  MAX_DESCRIPTION,
  splitUsername,
  botForToken,
  resetToken,
  cleanAppName,
  createApplication,
  applicationFor,
  updateApplication,
  deleteApplication,
  announceProfile,
  mayAdd,
  guildsToAddTo,
  addBotToGuild,
  removeBotRole,
  botGuildIds,
};
