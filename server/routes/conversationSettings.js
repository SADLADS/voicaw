const express = require('express');
const db = require('../db');
const { authenticateJWT } = require('../auth');
const { sendToUserSockets } = require('../sockets');
const { KINDS, listSettings, changeSetting } = require('../conversationSettings');

// Your own pins and mutes for DMs and group DMs (conversationSettings.js).
const router = express.Router();

// [{ kind, target, pinned_at, muted, mute_until }], pinned ones in the order they were pinned.
router.get('/conversation-settings', authenticateJWT, async (req, res) => {
  res.json(await listSettings(req.user.id));
});

// Pins/unpins (`pinned`) and/or mutes (`mute: { duration: s | null }`) or unmutes (`mute:
// false`) a conversation of yours: a DM with someone (`dm`, their id) or a group you're in
// (`group`, its id). Your other devices get `conversation_settings`.
router.put('/conversation-settings/:kind/:target', authenticateJWT, async (req, res) => {
  const { kind, target } = req.params;
  if (!KINDS.includes(kind)) return res.status(400).json({ error: 'Invalid conversation' });
  if (kind === 'dm') {
    const id = Number(target);
    const other = Number.isInteger(id) && id !== req.user.id
      ? await db.get('SELECT id FROM users WHERE id = ?', [id])
      : null;
    if (!other) return res.status(404).json({ error: 'User not found' });
  } else if (!(await db.get('SELECT 1 FROM group_dm_members WHERE group_id = ? AND user_id = ?', [target, req.user.id]))) {
    return res.status(404).json({ error: 'Group not found' });
  }
  const { pinned, mute } = req.body ?? {};
  if (pinned !== undefined && typeof pinned !== 'boolean') return res.status(400).json({ error: 'Invalid pinned' });
  const setting = await changeSetting(req.user.id, kind, String(target), { pinned, mute });
  if (typeof setting === 'string') return res.status(400).json({ error: setting });
  sendToUserSockets(req.user.id, { type: 'conversation_settings', setting });
  res.json(setting);
});

module.exports = router;
