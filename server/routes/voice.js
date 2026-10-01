const express = require('express');
const config = require('../config');
const { authenticateJWT } = require('../auth');
const { PERMISSIONS, has } = require('../permissions');
const { getChannelAccess } = require('../guilds');
const voice = require('../voice');

// Voice channels (see voice.js): getting a token to join one, the client's own mute/deafen,
// leaving, and LiveKit's webhooks (how we learn who actually joined or left).
const router = express.Router();

function requireVoice(req, res, next) {
  if (!config.livekit) return res.status(503).json({ error: "Voice isn't set up yet" });
  next();
}

// { url, token } to connect to LiveKit with. Needs View Channel and Connect; without Speak
// the token only listens. Body: { selfMute, selfDeaf } (how the client joins).
router.post('/guilds/:guildId/channels/:channelId/voice', authenticateJWT, requireVoice, async (req, res) => {
  const channelId = Number(req.params.channelId);
  const access = await voice.voiceAccess(channelId, req.user.id);
  if (!access) {
    // Tell apart "no such channel (for you)" and "can't connect".
    const seen = await getChannelAccess(channelId, req.user.id);
    if (!seen || seen.channel.guild_id !== Number(req.params.guildId) || !has(seen.permissions, PERMISSIONS.VIEW_CHANNEL)) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    if (seen.channel.type !== 'voice') return res.status(400).json({ error: 'Not a voice channel' });
    return res.status(403).json({ error: "You don't have permission to connect to this channel" });
  }
  if (access.channel.guild_id !== Number(req.params.guildId)) return res.status(404).json({ error: 'Channel not found' });
  const { selfMute, selfDeaf } = req.body ?? {};
  res.json(await voice.joinToken({
    channel: access.channel,
    userId: req.user.id,
    username: req.user.username,
    permissions: access.permissions,
    selfMute,
    selfDeaf,
  }));
});

// Your own mute/deafen: { selfMute, selfDeaf }. Returns your voice state (null when you're
// not in a voice channel; it applies when you join).
router.put('/voice/state', authenticateJWT, async (req, res) => {
  const { selfMute, selfDeaf } = req.body ?? {};
  if (typeof selfMute !== 'boolean' || typeof selfDeaf !== 'boolean') {
    return res.status(400).json({ error: 'selfMute and selfDeaf must be true or false' });
  }
  const state = await voice.setSelfState(req.user.id, { selfMute, selfDeaf });
  res.json(state && { guild_id: state.guildId, channel_id: state.channelId, self_mute: state.selfMute, self_deaf: state.selfDeaf });
});

// Leave voice (also disconnects you in LiveKit, e.g. a tab that lost its connection).
router.delete('/voice', authenticateJWT, async (req, res) => {
  await voice.disconnect(req.user.id);
  res.json({ success: true });
});

// LiveKit's webhooks (livekit.yaml `webhook:`), signed with the API key.
router.post('/livekit/webhook', requireVoice, express.text({ type: '*/*' }), async (req, res) => {
  let event;
  try {
    event = await voice.verifyWebhook(req.body, req.get('Authorization'));
  } catch (err) {
    console.warn('Rejected a LiveKit webhook:', err.message);
    return res.status(401).json({ error: 'Invalid webhook' });
  }
  await voice.handleWebhookEvent(event);
  res.json({ success: true });
});

module.exports = router;
