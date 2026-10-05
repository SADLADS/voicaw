const db = require('./db');

// Reports (the `reports` table), for the global admins: someone reports a message or a person.
// What a report keeps depends on where:
// - a guild message: the message as it was when reported (`content`; the server has it anyway),
//   so deleting it doesn't take the evidence away;
// - a DM or group message (end-to-end encrypted): only who, where and when, unless the reporter
//   ticked "Let moderators see this message", when its text comes with the report, decrypted on
//   their device (`content`, `shared` = 1: what they say it was, which the server can't check);
// - a person: just them, the category and the reporter's note.
// Admins see open ones in Settings → Admin → Reports, and dismiss them, delete the guild message,
// or suspend the account (`action`). Resolved reports are deleted a year later (pruneReports).

const CATEGORIES = ['spam', 'harassment', 'hate', 'sexual', 'child_safety', 'violence', 'self_harm', 'illegal', 'other'];
const MAX_NOTE = 1000;
const MAX_SHARED = 4000;
// No one sends more than this many an hour (it's people who report, not scripts).
const PER_HOUR = 20;
const KEEP_RESOLVED_SECONDS = 365 * 24 * 60 * 60;

const now = () => Math.floor(Date.now() / 1000);

class ReportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function tooMany(reporterId) {
  const { n } = await db.get('SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND created_at > ?', [reporterId, now() - 3600]);
  return n >= PER_HOUR;
}

function cleanText(value, max) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new ReportError(400, 'Invalid text');
  return value.trim().slice(0, max) || null;
}

// Stores a checked report (`fields` from routes/reports.js); -> its id.
async function addReport(fields) {
  const { lastID } = await db.run(
    `INSERT INTO reports (reporter_id, reported_id, kind, category, note, place, guild_id, channel_id, group_id,
       message_id, content, shared, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [fields.reporterId, fields.reportedId, fields.kind, fields.category, fields.note ?? null, fields.place ?? null,
      fields.guildId ?? null, fields.channelId ?? null, fields.groupId ?? null, fields.messageId ?? null,
      fields.content ?? null, fields.shared ? 1 : 0, now()]
  );
  return lastID;
}

// Open reports (oldest first) or the latest resolved, with the names to show.
async function listReports({ resolved = false, limit = 100 } = {}) {
  return db.all(
    `SELECT r.*, reporter.username AS reporter_username, reporter.display_name AS reporter_display_name,
       reported.username AS reported_username, reported.display_name AS reported_display_name,
       reported.suspended_at AS reported_suspended_at, g.name AS guild_name, c.name AS channel_name
     FROM reports r
     JOIN users reporter ON reporter.id = r.reporter_id
     JOIN users reported ON reported.id = r.reported_id
     LEFT JOIN guilds g ON g.id = r.guild_id
     LEFT JOIN guild_channels c ON c.id = r.channel_id
     WHERE r.resolved_at IS ${resolved ? 'NOT ' : ''}NULL
     ORDER BY ${resolved ? 'r.resolved_at DESC' : 'r.created_at'} LIMIT ?`,
    [limit]
  );
}

async function resolveReport(id, adminId, action) {
  const { changes } = await db.run(
    'UPDATE reports SET resolved_at = ?, resolved_by = ?, action = ? WHERE id = ? AND resolved_at IS NULL',
    [now(), adminId, action, id]
  );
  return changes > 0;
}

// Resolved reports from over a year ago (run hourly with the session clean-up, auth.js).
async function pruneReports(at = now()) {
  const { changes } = await db.run('DELETE FROM reports WHERE resolved_at IS NOT NULL AND resolved_at < ?', [at - KEEP_RESOLVED_SECONDS]);
  return changes;
}

const openCount = async () => (await db.get('SELECT COUNT(*) AS n FROM reports WHERE resolved_at IS NULL')).n;

module.exports = {
  CATEGORIES, MAX_NOTE, MAX_SHARED, PER_HOUR, ReportError, tooMany, cleanText, addReport, listReports, resolveReport,
  pruneReports, openCount,
};
