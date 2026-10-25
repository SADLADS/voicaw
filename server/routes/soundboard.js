const express = require('express');
const { authenticateJWT } = require('../auth');
const { withActionErrors } = require('../actionError');
const soundboard = require('../soundboard');

// Guild soundboards (soundboard.js): listing (any member), adding, editing and deleting sounds
// (Manage Emoji), choosing your join sound, and playing one in the voice channel you're in.
const router = express.Router();

const guildId = (req) => Number(req.params.guildId);
const soundId = (req) => Number(req.params.soundId);

// { sounds: [{ id, guild_id, name, emoji, volume, creator_id, created_at }], join_sound_id }
router.get('/guilds/:guildId/soundboard', authenticateJWT, withActionErrors(async (req, res) => {
  res.json(await soundboard.listSounds(guildId(req), req.user.id));
}));

// Starts adding a sound: { name, emoji?, volume?, type, size } -> { sound, uploadUrl }. Then
// PUT the file to uploadUrl and POST .../ready.
router.post('/guilds/:guildId/soundboard', authenticateJWT, withActionErrors(async (req, res) => {
  res.status(201).json(await soundboard.createSound(guildId(req), req.user.id, req.body ?? {}));
}));

router.post('/guilds/:guildId/soundboard/:soundId/ready', authenticateJWT, withActionErrors(async (req, res) => {
  res.json(await soundboard.finishSound(guildId(req), req.user.id, soundId(req)));
}));

// { name?, emoji?, volume? }
router.patch('/guilds/:guildId/soundboard/:soundId', authenticateJWT, withActionErrors(async (req, res) => {
  const { name, emoji, volume } = req.body ?? {};
  res.json(await soundboard.updateSound(guildId(req), req.user.id, soundId(req), { name, emoji, volume }));
}));

router.delete('/guilds/:guildId/soundboard/:soundId', authenticateJWT, withActionErrors(async (req, res) => {
  await soundboard.deleteSound(guildId(req), req.user.id, soundId(req));
  res.json({ success: true });
}));

// { soundId: id | null }
router.put('/guilds/:guildId/soundboard/join-sound', authenticateJWT, withActionErrors(async (req, res) => {
  const raw = req.body?.soundId;
  if (raw !== null && !Number.isInteger(raw)) return res.status(400).json({ error: 'soundId must be a sound id or null' });
  res.json({ join_sound_id: await soundboard.setJoinSound(guildId(req), req.user.id, raw) });
}));

// Plays the sound to everyone in the voice channel (you must be in it).
router.post('/guilds/:guildId/channels/:channelId/soundboard/:soundId', authenticateJWT, withActionErrors(async (req, res) => {
  res.json(await soundboard.playSound(req.user.id, Number(req.params.channelId), soundId(req)));
}));

module.exports = router;
