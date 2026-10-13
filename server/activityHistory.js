const db = require('./db');
const { getPreferences } = require('./preferences');

// Activity history: the games someone played over the last KEEP_DAYS days, shown on their
// profile (Activity tab, GET /users/:id/profile). Built from their Rich Presence activities
// (activities.js) as they change (sockets.js refreshActivities): one row per play session of a
// "Playing" activity with a name (never bots', never music or anything else), its start and end
// (unix s). Only the game's name and the times are kept, nothing else the game said.
// A game that stops and starts again within REJOIN_SECONDS carries on its last session. Open
// sessions' ends move forward every minute (tick), so a server restart loses at most that.
// Rows older than KEEP_DAYS go (prune, hourly). The `showActivity` preference off means
// nothing is recorded and what was is deleted (forget).

const KEEP_DAYS = 30;
const KEEP_SECONDS = KEEP_DAYS * 24 * 60 * 60;
const REJOIN_SECONDS = 5 * 60;
const TICK_MS = 60 * 1000;
const PRUNE_EVERY_TICKS = 60;

const now = () => Math.floor(Date.now() / 1000);
const open = new Map(); // user id (string) -> Map(game name -> session row id)
const queues = new Map(); // user id -> the promise of their last change (changes run in order)

// The game names in an activity list worth recording.
const gamesIn = (list) => new Set((list ?? []).filter((a) => a.type === 0 && a.name).map((a) => a.name));

async function apply(userId, list) {
  const sessions = open.get(userId) ?? new Map();
  const playing = gamesIn(list);
  const at = now();
  for (const [name, id] of sessions) {
    if (playing.has(name)) continue;
    await db.run('UPDATE activity_sessions SET ended_at = ? WHERE id = ?', [at, id]);
    sessions.delete(name);
  }
  const starting = [...playing].filter((name) => !sessions.has(name));
  if (starting.length) {
    const user = await db.get('SELECT bot, deleted_at FROM users WHERE id = ?', [userId]);
    if (user && !user.bot && !user.deleted_at && (await getPreferences(userId)).showActivity) {
      for (const name of starting) {
        const last = await db.get(
          'SELECT id FROM activity_sessions WHERE user_id = ? AND name = ? AND ended_at >= ? ORDER BY ended_at DESC LIMIT 1',
          [userId, name, at - REJOIN_SECONDS]
        );
        if (last) {
          await db.run('UPDATE activity_sessions SET ended_at = ? WHERE id = ?', [at, last.id]);
          sessions.set(name, last.id);
        } else {
          const { lastID } = await db.run(
            'INSERT INTO activity_sessions (user_id, name, started_at, ended_at) VALUES (?, ?, ?, ?)',
            [userId, name, at, at]
          );
          sessions.set(name, lastID);
        }
      }
    }
  }
  if (sessions.size) open.set(userId, sessions);
  else open.delete(userId);
}

// `userId`'s activities are now `list` (any, including empty): sessions start and end.
function record(userId, list) {
  userId = String(userId);
  const next = (queues.get(userId) ?? Promise.resolve())
    .then(() => apply(userId, list))
    .catch((err) => console.error('Activity history failed:', err.message));
  queues.set(userId, next);
  next.then(() => { if (queues.get(userId) === next) queues.delete(userId); });
  return next;
}

// Deletes `userId`'s history and stops their open sessions (showActivity turned off, account
// deleted).
async function forget(userId) {
  userId = String(userId);
  await (queues.get(userId) ?? Promise.resolve());
  open.delete(userId);
  await db.run('DELETE FROM activity_sessions WHERE user_id = ?', [userId]);
}

// Per game: { name, seconds (in all), lastPlayed (unix s), sessions, playing (now) }, the most
// recently played first, over the last KEEP_DAYS days.
async function historyOf(userId) {
  const rows = await db.all(
    `SELECT name, SUM(ended_at - started_at) AS seconds, MAX(ended_at) AS last_played, COUNT(*) AS sessions
       FROM activity_sessions WHERE user_id = ? AND ended_at >= ?
      GROUP BY name ORDER BY last_played DESC`,
    [userId, now() - KEEP_SECONDS]
  );
  const playing = open.get(String(userId)) ?? new Map();
  return rows.map((r) => ({ name: r.name, seconds: r.seconds, lastPlayed: r.last_played, sessions: r.sessions, playing: playing.has(r.name) }));
}

async function tick() {
  const ids = [...open.values()].flatMap((sessions) => [...sessions.values()]);
  if (ids.length) await db.run(`UPDATE activity_sessions SET ended_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [now(), ...ids]);
}

async function prune(at = now()) {
  const { changes } = await db.run('DELETE FROM activity_sessions WHERE ended_at < ?', [at - KEEP_SECONDS]);
  return changes;
}

function startActivityHistory() {
  let ticks = 0;
  prune().catch((err) => console.error('Activity history cleanup failed:', err.message));
  return setInterval(() => {
    tick().catch((err) => console.error('Activity history failed:', err.message));
    if (++ticks % PRUNE_EVERY_TICKS === 0) prune().catch((err) => console.error('Activity history cleanup failed:', err.message));
  }, TICK_MS);
}

module.exports = { KEEP_DAYS, record, forget, historyOf, tick, prune, startActivityHistory };
