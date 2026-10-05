const express = require('express');
const db = require('../db');
const { authenticateJWT } = require('../auth');
const reports = require('../reports');
const suspensions = require('../suspensions');
const groups = require('../groupDms');
const { getChannelAccess } = require('../guilds');
const { PERMISSIONS, has } = require('../permissions');
const { sendToUserSockets } = require('../sockets');
const { admin } = require('./admin');

// Reporting (reports.js) and what admins do about it (Settings → Admin → Reports).
const router = express.Router();

// Every admin's open app updates its count of open reports.
async function announceToAdmins() {
  const open = await reports.openCount();
  for (const { id } of await db.all('SELECT id FROM users WHERE is_admin = 1')) {
    sendToUserSockets(id, { type: 'reports_changed', open });
  }
}

// The message reported, checked to be one the reporter can see: -> the report's fields.
async function messageFields(reporterId, { place, messageId, groupId, sharedText }) {
  const id = Number(messageId);
  if (!Number.isInteger(id)) throw new reports.ReportError(400, 'Invalid message');
  if (place === 'guild') {
    const message = await db.get('SELECT id, channel_id, sender_id, content, webhook_id FROM guild_messages WHERE id = ?', [id]);
    const access = message && await getChannelAccess(message.channel_id, reporterId);
    if (!access || !has(access.permissions, PERMISSIONS.VIEW_CHANNEL)) throw new reports.ReportError(404, 'Message not found');
    // A webhook's message has no person behind it: the guild's owner answers for it.
    const guild = await db.get('SELECT owner FROM guilds WHERE id = ?', [access.channel.guild_id]);
    return {
      reportedId: message.sender_id ?? guild.owner, place, guildId: access.channel.guild_id, channelId: message.channel_id,
      messageId: id, content: message.content, shared: false,
    };
  }
  // Encrypted: the server only knows who sent it to whom; its text only if the reporter shares it.
  const shared = reports.cleanText(sharedText, reports.MAX_SHARED);
  if (place === 'dm') {
    const message = await db.get(
      'SELECT id, sender_id, recipient_id FROM direct_messages WHERE id = ? AND (sender_id = ? OR recipient_id = ?)',
      [id, reporterId, reporterId]
    );
    if (!message || message.sender_id === message.recipient_id) throw new reports.ReportError(404, 'Message not found');
    return { reportedId: message.sender_id, place, messageId: id, content: shared, shared: Boolean(shared) };
  }
  if (place === 'group') {
    if (typeof groupId !== 'string' || !(await groups.memberState(groupId, reporterId))) throw new reports.ReportError(404, 'Message not found');
    const message = await db.get('SELECT id, sender_id FROM group_dm_messages WHERE id = ? AND group_id = ?', [id, groupId]);
    if (!message) throw new reports.ReportError(404, 'Message not found');
    return { reportedId: message.sender_id, place, groupId, messageId: id, content: shared, shared: Boolean(shared) };
  }
  throw new reports.ReportError(400, 'Invalid place');
}

// { kind: 'message', place: 'guild' | 'dm' | 'group', messageId, groupId?, sharedText? } or
// { kind: 'user', userId }, with { category, note? }.
router.post('/reports', authenticateJWT, async (req, res) => {
  const body = req.body ?? {};
  try {
    if (!reports.CATEGORIES.includes(body.category)) throw new reports.ReportError(400, 'Invalid category');
    const note = reports.cleanText(body.note, reports.MAX_NOTE);
    let fields;
    if (body.kind === 'message') {
      fields = await messageFields(req.user.id, body);
    } else if (body.kind === 'user') {
      const id = Number(body.userId);
      const user = Number.isInteger(id) && await db.get('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL', [id]);
      if (!user) throw new reports.ReportError(404, 'User not found');
      fields = { reportedId: id };
    } else {
      throw new reports.ReportError(400, 'Invalid report');
    }
    if (fields.reportedId === req.user.id) throw new reports.ReportError(400, "You can't report yourself");
    if (await reports.tooMany(req.user.id)) throw new reports.ReportError(429, "You've sent a lot of reports: try again later");
    const id = await reports.addReport({ ...fields, reporterId: req.user.id, kind: body.kind, category: body.category, note });
    await announceToAdmins();
    res.status(201).json({ id });
  } catch (err) {
    if (err instanceof reports.ReportError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// ---- Admins ----

router.get('/admin/reports', admin, async (req, res) => {
  res.json({
    open: await reports.listReports(),
    resolved: await reports.listReports({ resolved: true, limit: 50 }),
    suspended: await suspensions.listSuspended(),
    categories: reports.CATEGORIES,
  });
});

async function findReport(req, res) {
  const report = await db.get('SELECT * FROM reports WHERE id = ?', [Number(req.params.id)]);
  if (!report) res.status(404).json({ error: 'Report not found' });
  return report;
}

router.post('/admin/reports/:id/dismiss', admin, async (req, res) => {
  const report = await findReport(req, res);
  if (!report) return;
  await reports.resolveReport(report.id, req.user.id, 'dismissed');
  await announceToAdmins();
  res.json({ success: true });
});

// Deletes the reported guild message (as a moderator would: the guild's audit log says so), and
// resolves the report. Already gone: just resolved.
router.post('/admin/reports/:id/delete-message', admin, async (req, res) => {
  const report = await findReport(req, res);
  if (!report) return;
  if (report.place !== 'guild') return res.status(400).json({ error: 'Only guild messages can be deleted (the others are encrypted)' });
  const message = await db.get(
    'SELECT id, channel_id, sender_id, content, timestamp, system, webhook_id, webhook_name FROM guild_messages WHERE id = ?',
    [report.message_id]
  );
  if (message) {
    const channel = await db.get('SELECT * FROM guild_channels WHERE id = ?', [message.channel_id]);
    await require('./guildMessages').deleteMessage(message, channel, req.user.id, PERMISSIONS.MANAGE_MESSAGES);
  }
  await reports.resolveReport(report.id, req.user.id, 'deleted_message');
  await announceToAdmins();
  res.json({ success: true });
});

// Suspends `id` ({ reason?, reportId? }: the report it's for is resolved with it).
router.post('/admin/users/:id/suspend', admin, async (req, res) => {
  try {
    await suspensions.suspend(Number(req.params.id), req.user.id, req.body?.reason);
  } catch (err) {
    if (err instanceof suspensions.SuspensionError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
  const reportId = Number(req.body?.reportId);
  if (Number.isInteger(reportId)) await reports.resolveReport(reportId, req.user.id, 'suspended');
  await announceToAdmins();
  res.json({ success: true });
});

router.delete('/admin/users/:id/suspension', admin, async (req, res) => {
  if (!(await suspensions.lift(Number(req.params.id)))) return res.status(404).json({ error: 'Not suspended' });
  res.json({ success: true });
});

module.exports = router;
