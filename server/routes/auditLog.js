const express = require('express');
const { authenticateJWT } = require('../auth');
const { PERMISSIONS } = require('../permissions');
const { readAuditLog } = require('../auditLog');
const { requireMember, requirePermission } = require('./guilds');

// The guild's audit log (auditLog.js), for members with View Audit Log.
const router = express.Router();

const ACTION = /^[a-z_]{1,40}$/;

// ?before=<entry id>&limit=<1-100>&actions=<a,b,...>&userId=<who did it>
router.get('/guilds/:guildId/audit-log', authenticateJWT, requireMember, requirePermission(PERMISSIONS.VIEW_AUDIT_LOG), async (req, res) => {
  const { before, limit, actions, userId } = req.query;
  const options = {};
  if (before !== undefined) {
    options.before = Number(before);
    if (!Number.isInteger(options.before)) return res.status(400).json({ error: 'Invalid before' });
  }
  if (limit !== undefined) {
    const n = parseInt(limit, 10);
    options.limit = Number.isNaN(n) ? 50 : Math.min(Math.max(n, 1), 100);
  }
  if (actions !== undefined) {
    options.actions = String(actions).split(',').filter(Boolean);
    if (options.actions.some((a) => !ACTION.test(a))) return res.status(400).json({ error: 'Invalid actions' });
  }
  if (userId !== undefined) {
    options.actorId = Number(userId);
    if (!Number.isInteger(options.actorId)) return res.status(400).json({ error: 'Invalid userId' });
  }
  res.json(await readAuditLog(req.member, options));
});

module.exports = router;
