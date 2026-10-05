const express = require('express');
const config = require('../config');
const { authenticateJWT } = require('../auth');
const { PERMISSIONS, has } = require('../permissions');
const { getChannelAccess } = require('../guilds');
const { createLimiter } = require('../rateLimit');
const { withActionErrors } = require('../actionError');
const commands = require('../commands');
const interactions = require('../interactions');
const webhooks = require('./webhooks');

// The app's side of bots' commands and components (interactions.js, docs/bots.md): the
// commands someone may use in a channel (the "/" picker and the Apps menus), and using one,
// asking for autocomplete suggestions, clicking a button or choosing in a select, and
// submitting a bot's form. Each waits (up to 3 seconds) for the bot; its messages then arrive
// by socket like any other. Answers: { ok }, { modal } (a form to show) or { choices }.
const router = express.Router();

// Per person: a burst of clicks is fine, a flood isn't.
const limiter = createLimiter({ windowMs: 10000, max: 20 });
function limit(req, res, next) {
  if (!config.rateLimitsEnabled) return next();
  const { allowed, retryAfterMs } = limiter.hit(String(req.user.id));
  if (allowed) return next();
  res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
  return res.status(429).json({ error: 'Slow down a little' });
}

// req.access: a text channel, thread or voice channel (its chat) the caller can see.
async function inChannel(req, res, next) {
  const access = await getChannelAccess(Number(req.params.channelId), req.user.id);
  if (!access || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) return res.status(404).json({ error: 'Channel not found' });
  if (!['text', 'thread', 'voice'].includes(access.channel.type)) return res.status(400).json({ error: 'Not a text channel' });
  req.access = access;
  next();
}

// The commands of the guild's bots the caller may use here (for the picker and the Apps menus).
router.get('/channels/:channelId/commands', authenticateJWT, inChannel, async (req, res) => {
  const { channel, member, permissions } = req.access;
  const rows = await commands.guildCommands(channel.guild_id);
  res.json(rows.filter((row) => commands.mayUse(row, member, permissions, channel)).map(commands.pickerObject));
});

// Uses a command: { command_id, options (Discord's shape), target_id (context menus) }, as JSON
// or multipart (payload_json, and files[n] for attachment options, whose value is n).
router.post('/channels/:channelId/command-interactions', authenticateJWT, limit, webhooks.parseBody, inChannel, withActionErrors(async (req, res) => {
  const { body, files } = await webhooks.readBody(req);
  // Uploaded like a webhook's files; attachment options name them by their n.
  const attachments = [];
  for (const [i, entry] of files.entries()) {
    attachments[Number(entry.field.match(/\d+/)?.[0] ?? i)] = (await webhooks.storeFiles([entry]))[0];
  }
  res.json(await interactions.useCommand({
    access: req.access, commandId: body.command_id, options: body.options, targetId: body.target_id, attachments,
  }));
}));

// Autocomplete suggestions for the focused option: { command_id, options }.
router.post('/channels/:channelId/autocomplete', authenticateJWT, inChannel, withActionErrors(async (req, res) => {
  res.json(await interactions.useCommand({ access: req.access, commandId: req.body?.command_id, options: req.body?.options, autocomplete: true }));
}));

// A button clicked, or a select's choice: { custom_id, values? }. Ephemeral messages too.
router.post('/guild-messages/:messageId/component-interactions', authenticateJWT, limit, withActionErrors(async (req, res) => {
  res.json(await interactions.useComponent({
    userId: req.user.id, messageId: Number(req.params.messageId), customId: req.body?.custom_id, values: req.body?.values,
  }));
}));

// A form submitted: { answers: { [custom_id]: text or [values] } }.
router.post('/modals/:modalId', authenticateJWT, limit, withActionErrors(async (req, res) => {
  res.json(await interactions.submitModal({ userId: req.user.id, modalId: req.params.modalId, answers: req.body?.answers }));
}));

// Dismissing one of your ephemeral messages (the app hides it; the server forgets it).
router.delete('/ephemeral-messages/:messageId', authenticateJWT, (req, res) => {
  interactions.dismissEphemeral(req.user.id, req.params.messageId);
  res.json({ success: true });
});

module.exports = router;
