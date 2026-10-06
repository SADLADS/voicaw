const express = require('express');
const db = require('../db');
const { authenticateJWT } = require('../auth');
const { getMember } = require('../guilds');
const { setAvatarFrom, removeAvatar } = require('../avatars');
const { AvatarImageError, MAX_AVATAR_UPLOAD_BYTES } = require('../avatarImage');
const { fromDiscordPermissions } = require('../discord');
const bots = require('../bots');
const oauth = require('../oauth');

// The developer portal (the app's /developers page), and its /oauth2/authorize page: adding
// bots to guilds (scope `bot`) or logging in to an application's website (Login with Voicaw,
// oauth.js), and Settings → Authorised apps. Logged-in people only; bots themselves use
// routes/botApi.js, websites the token routes there. See bots.js and docs/bots.md.
const router = express.Router();

// Loads req.application: one of the caller's applications.
async function ownApplication(req, res, next) {
  const id = Number(req.params.appId);
  const app = Number.isInteger(id) && await db.get('SELECT * FROM bot_applications WHERE id = ? AND owner_id = ?', [id, req.user.id]);
  if (!app) return res.status(404).json({ error: 'Application not found' });
  req.application = app;
  next();
}

router.get('/applications', authenticateJWT, async (req, res) => {
  const apps = await db.all('SELECT * FROM bot_applications WHERE owner_id = ? ORDER BY created_at, id', [req.user.id]);
  res.json(await Promise.all(apps.map(bots.applicationFor)));
});

// A new application and its bot. The token comes back this once.
router.post('/applications', authenticateJWT, async (req, res) => {
  const name = bots.cleanAppName(req.body?.name);
  if (!name) return res.status(400).json({ error: `Names are 2–${bots.MAX_NAME} characters` });
  const created = await bots.createApplication(req.user.id, name);
  if (created.error) return res.status(400).json({ error: created.error });
  const app = await db.get('SELECT * FROM bot_applications WHERE id = ?', [created.id]);
  res.status(201).json({ ...(await bots.applicationFor(app)), token: created.token });
});

router.get('/applications/:appId', authenticateJWT, ownApplication, async (req, res) => {
  res.json(await bots.applicationFor(req.application));
});

// `name`, `description`, `public`; `avatar` as a data URI (or null for the default picture).
router.patch('/applications/:appId', authenticateJWT, ownApplication, async (req, res) => {
  const body = req.body ?? {};
  const error = await bots.updateApplication(req.application, body);
  if (error) return res.status(400).json({ error });
  if (body.avatar !== undefined) {
    if (body.avatar === null) {
      await removeAvatar(req.application.id);
    } else {
      const match = typeof body.avatar === 'string' && body.avatar.match(/^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i);
      if (!match) return res.status(400).json({ error: 'Invalid image' });
      const original = Buffer.from(match[1], 'base64');
      if (original.length > MAX_AVATAR_UPLOAD_BYTES) return res.status(413).json({ error: 'That picture is too big' });
      try {
        await setAvatarFrom(req.application.id, original);
      } catch (err) {
        if (err instanceof AvatarImageError) return res.status(400).json({ error: err.message });
        throw err;
      }
    }
    await bots.announceProfile(req.application.id);
  }
  const app = await db.get('SELECT * FROM bot_applications WHERE id = ?', [req.application.id]);
  res.json(await bots.applicationFor(app));
});

// A new token; the old one (and every gateway session using it) stops working.
router.post('/applications/:appId/token', authenticateJWT, ownApplication, async (req, res) => {
  res.json({ token: await bots.resetToken(req.application.id) });
});

// Login with Voicaw: a new client secret (the old one stops working), shown this once.
router.post('/applications/:appId/client-secret', authenticateJWT, ownApplication, async (req, res) => {
  res.json({ client_secret: await oauth.resetClientSecret(req.application.id) });
});

router.delete('/applications/:appId', authenticateJWT, ownApplication, async (req, res) => {
  await bots.deleteApplication(req.application);
  res.json({ success: true });
});

// Takes the bot out of one of its guilds (from the portal).
router.delete('/applications/:appId/guilds/:guildId', authenticateJWT, ownApplication, async (req, res) => {
  const guildId = Number(req.params.guildId);
  if (!(await getMember(guildId, req.application.id))) return res.status(404).json({ error: 'Not in that guild' });
  await require('../guilds').removeMember(guildId, req.application.id);
  res.json({ success: true });
});

// ---- Adding a bot to a guild ----

// The application `client_id` (another name for its id, as in Discord's links) if the caller
// may add it.
async function addableApplication(req, res) {
  const id = Number(req.query.client_id ?? req.body?.client_id);
  const app = Number.isInteger(id) && await db.get('SELECT * FROM bot_applications WHERE id = ?', [id]);
  if (!app || !bots.mayAdd(app, req.user.id)) {
    res.status(404).json({ error: 'Unknown application' });
    return null;
  }
  return app;
}

// Whether a /oauth2/authorize link adds a bot (scope `bot`, or none: older invite links) or
// logs in to a website (any other scope).
const isBotInvite = (scope) => {
  const scopes = oauth.parseScopes(scope);
  return !scopes.length || scopes.includes('bot');
};

// ---- Login with Voicaw (oauth.js) ----

// The application a login link names, its checked scopes and redirect URI, from `params` (the
// link's query). Throws OAuthError: an unknown application or redirect URI is never redirected
// to; a bad response_type or scope is (as RFC 6749 says), so the page can send people back.
async function loginRequest(params) {
  const id = Number(params.client_id);
  const app = Number.isSafeInteger(id) && id > 0 && await db.get('SELECT * FROM bot_applications WHERE id = ?', [id]);
  if (!app) throw new oauth.OAuthError(404, 'invalid_client', 'Unknown application');
  const redirectUri = oauth.redirectUriFor(app, params.redirect_uri);
  return { app, redirectUri };
}

// Answers an OAuthError from the authorise page: `{ error, error_description }`, plus where to
// send the person back to when it's the site's to hear about (`redirect`).
function loginFailed(res, err, redirect = null) {
  if (!(err instanceof oauth.OAuthError)) throw err;
  res.status(err.status).json({ error: err.message, oauth_error: err.error, ...(redirect ? { redirect } : {}) });
}

// What the login page shows: the application, who made it, what it asks for, where you'd go
// back to, and whether you've let it in before (with prompt=none the page doesn't ask again).
async function loginInfo(req, res) {
  let request;
  try {
    request = await loginRequest(req.query);
  } catch (err) {
    return loginFailed(res, err);
  }
  const { app, redirectUri } = request;
  const back = (error, description) => oauth.withParams(redirectUri, { error, error_description: description, state: req.query.state });
  if (req.query.response_type !== 'code') {
    return loginFailed(res, new oauth.OAuthError(400, 'unsupported_response_type', 'Only response_type=code is supported'), back('unsupported_response_type'));
  }
  let scopes;
  try {
    scopes = oauth.checkScopes(oauth.parseScopes(req.query.scope));
  } catch (err) {
    return loginFailed(res, err, back(err.error, err.message));
  }
  const user = await db.get('SELECT username, avatar FROM users WHERE id = ?', [app.id]);
  const owner = await db.get('SELECT id, username, display_name FROM users WHERE id = ?', [app.owner_id]);
  res.json({
    login: true,
    id: app.id,
    name: app.name,
    description: app.description,
    bot: { id: app.id, ...bots.splitUsername(user.username), avatar: user.avatar },
    owner,
    created_at: app.created_at,
    scopes,
    redirect_uri: redirectUri,
    authorized: await oauth.hasAuthorised(app.id, req.user.id, scopes),
  });
}

// Agrees to (or, with `deny`, refuses) a login link: answers `{ location }`, the site's
// redirect URI with `code` (or `error=access_denied`) and the link's `state`.
async function login(req, res) {
  const body = req.body ?? {};
  let request;
  let scopes;
  try {
    request = await loginRequest(body);
    if (body.response_type !== 'code') throw new oauth.OAuthError(400, 'unsupported_response_type', 'Only response_type=code is supported');
    scopes = oauth.checkScopes(oauth.parseScopes(body.scope));
  } catch (err) {
    return loginFailed(res, err);
  }
  const { app, redirectUri } = request;
  if (body.deny) {
    return res.json({ location: oauth.withParams(redirectUri, { error: 'access_denied', error_description: 'The person declined', state: body.state }) });
  }
  const code = await oauth.createCode(app, req.user.id, redirectUri, scopes);
  res.json({ location: oauth.withParams(redirectUri, { code, state: body.state }) });
}

// Settings → Authorised apps: the sites you've logged in to with Voicaw.
router.get('/oauth2/authorised-apps', authenticateJWT, async (req, res) => {
  res.json(await oauth.authorisedApps(req.user.id));
});

// Takes an application's access away (its tokens stop working).
router.delete('/oauth2/authorised-apps/:appId', authenticateJWT, async (req, res) => {
  const id = Number(req.params.appId);
  if (!Number.isSafeInteger(id)) return res.status(404).json({ error: 'Unknown application' });
  await oauth.deauthorise(id, req.user.id);
  res.json({ success: true });
});

// ---- The authorise page ----

// What the authorise page shows: the bot, who made it, and the guilds the caller can add it to;
// or, for a login link, what loginInfo says.
router.get('/oauth2/authorize', authenticateJWT, async (req, res) => {
  if (!isBotInvite(req.query.scope)) return loginInfo(req, res);
  const app = await addableApplication(req, res);
  if (!app) return;
  const user = await db.get('SELECT username, avatar FROM users WHERE id = ?', [app.id]);
  const owner = await db.get('SELECT id, username, display_name FROM users WHERE id = ?', [app.owner_id]);
  res.json({
    id: app.id,
    name: app.name,
    description: app.description,
    bot: { id: app.id, ...bots.splitUsername(user.username), avatar: user.avatar },
    owner,
    created_at: app.created_at,
    guilds: await bots.guildsToAddTo(req.user.id, app.id),
  });
});

// Adds the bot to `guild_id`. `permissions` is Discord's bitfield (a decimal string), as in
// the link; the caller may have unticked some.
router.post('/oauth2/authorize', authenticateJWT, async (req, res) => {
  if (!isBotInvite(req.body?.scope)) return login(req, res);
  const app = await addableApplication(req, res);
  if (!app) return;
  const adder = await getMember(Number(req.body?.guild_id), req.user.id);
  if (!adder) return res.status(404).json({ error: 'Guild not found' });
  let permissions;
  try {
    permissions = fromDiscordPermissions(req.body?.permissions ?? '0');
  } catch {
    return res.status(400).json({ error: 'Invalid permissions' });
  }
  const failed = await bots.addBotToGuild(app, adder, permissions);
  if (failed) return res.status(failed.status).json({ error: failed.error });
  res.status(201).json({ success: true, guild_id: adder.guild.id });
});

module.exports = router;
