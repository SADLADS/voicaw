const db = require('./db');
const { sendToUserSockets } = require('./sockets');
const { sendPushToUser } = require('./push');

// What's waiting for the global admins: open reports (reports.js), accounts waiting for approval
// (signups.js) and requests to join the Android app's closed test not yet added to Play's list
// (routes/testerRequests.js). Admins' apps show the total on the Settings gear, and each count
// on its Settings page, until they're dealt with (`admin_alerts`, `GET /admin/alerts`); a new
// one is also pushed to their devices (`notify`).

const KINDS = {
  report: { count: 'reports', url: '/settings/reports#reports', title: 'New report' },
  signup: { count: 'signups', url: '/settings/admin#admin-signups', title: 'New sign-up request' },
  tester: { count: 'testers', url: '/settings/admin#admin-signups', title: 'New Android tester request' },
};

async function counts() {
  const n = async (sql) => (await db.get(sql)).n;
  return {
    reports: await n('SELECT COUNT(*) AS n FROM reports WHERE resolved_at IS NULL'),
    signups: await n('SELECT COUNT(*) AS n FROM users WHERE pending = 1 AND deleted_at IS NULL'),
    testers: await n('SELECT COUNT(*) AS n FROM tester_requests WHERE added_at IS NULL AND removed_at IS NULL'),
  };
}

async function adminIds() {
  return (await db.all('SELECT id FROM users WHERE is_admin = 1 AND deleted_at IS NULL')).map((r) => r.id);
}

// Every admin's open apps get the counts (after anything that changes them). `alsoTo`: someone
// who just stopped being an admin, so their gear clears.
async function announce({ alsoTo } = {}) {
  const current = await counts();
  for (const id of await adminIds()) sendToUserSockets(id, { type: 'admin_alerts', ...current });
  if (alsoTo != null) sendToUserSockets(alsoTo, { type: 'admin_alerts', reports: 0, signups: 0, testers: 0 });
}

// A new report, sign-up request or tester request: a notification on every admin's devices
// (but `exceptId`'s, the admin who reported), one per kind, each replacing the last. Nothing
// about the report or the tester (an email) goes in it; a sign-up's username does. `title` and
// `body` are for apps that don't word it themselves (the client's notificationFromPush does).
// Never rejects: callers don't wait for it.
async function notify(kind, { name, exceptId } = {}) {
  try {
    const { count: key, url, title } = KINDS[kind];
    const count = (await counts())[key];
    const payload = {
      type: 'admin', kind, count, title, url, tag: `admin-${kind}`,
      body: name ? `${name} asked for an account` : `${count} waiting`,
      ...(name ? { name } : {}),
      timestamp: Math.floor(Date.now() / 1000),
    };
    await Promise.all((await adminIds()).filter((id) => id !== exceptId).map((id) => sendPushToUser(id, payload)));
  } catch (err) {
    console.error('Admin notification failed:', err.message);
  }
}

module.exports = { counts, announce, notify };
