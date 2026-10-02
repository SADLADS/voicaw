const db = require('./db');
const { parseDuration } = require('./channelMutes');

// Each person's own settings for their DMs and group DMs (the DM list's menu): pinned to the top
// of the list, and muted (no pushes or Message sound; for a while, or until unmuted), like
// Discord's. `kind` is 'dm' (target: the other person's id) or 'group' (target: the group's id).
// The server already knows who talks to whom, so this tells it nothing new about the chats.

const KINDS = ['dm', 'group'];
const MAX_PINNED = 50;

const now = () => Math.floor(Date.now() / 1000);

// A setting as sent to the client: { kind, target, pinned_at, muted, mute_until }.
function shape(row) {
  return {
    kind: row.kind,
    target: row.target,
    pinned_at: row.pinned_at ?? null,
    muted: Boolean(row.muted) && (row.mute_until == null || row.mute_until > now()),
    mute_until: row.mute_until ?? null,
  };
}

// `userId`'s settings that do anything (pinned, or muted and not run out).
async function listSettings(userId) {
  const rows = await db.all('SELECT * FROM conversation_settings WHERE user_id = ? ORDER BY pinned_at, target', [userId]);
  return rows.map(shape).filter((s) => s.pinned_at != null || s.muted);
}

async function getSetting(userId, kind, target) {
  const row = await db.get('SELECT * FROM conversation_settings WHERE user_id = ? AND kind = ? AND target = ?', [userId, kind, String(target)]);
  return shape(row ?? { kind, target: String(target) });
}

// Changes `userId`'s setting: `pinned` (true/false) and/or `mute` ({ duration: s | null } to
// mute, false to unmute). Returns the new setting, or a string saying what's wrong.
async function changeSetting(userId, kind, target, { pinned, mute }) {
  let duration;
  if (mute !== undefined && mute !== false) {
    duration = parseDuration(mute?.duration);
    if (typeof mute !== 'object' || mute === null || duration === undefined) return 'Invalid mute duration';
  }
  return db.transaction(async () => {
    const current = await db.get('SELECT * FROM conversation_settings WHERE user_id = ? AND kind = ? AND target = ?', [userId, kind, target])
      ?? { pinned_at: null, muted: 0, mute_until: null };
    let pinnedAt = current.pinned_at;
    if (pinned === true && pinnedAt == null) {
      const { n } = await db.get('SELECT COUNT(*) AS n FROM conversation_settings WHERE user_id = ? AND pinned_at IS NOT NULL', [userId]);
      if (n >= MAX_PINNED) return `You can pin up to ${MAX_PINNED} conversations`;
      // Milliseconds, so pins made in the same second keep their order.
      pinnedAt = Date.now();
    } else if (pinned === false) {
      pinnedAt = null;
    }
    let { muted, mute_until: muteUntil } = current;
    if (mute === false) {
      muted = 0;
      muteUntil = null;
    } else if (mute !== undefined) {
      muted = 1;
      muteUntil = duration == null ? null : now() + duration;
    }
    if (pinnedAt == null && !muted) {
      await db.run('DELETE FROM conversation_settings WHERE user_id = ? AND kind = ? AND target = ?', [userId, kind, target]);
    } else {
      await db.run(
        `INSERT INTO conversation_settings (user_id, kind, target, pinned_at, muted, mute_until) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, kind, target) DO UPDATE SET pinned_at = excluded.pinned_at, muted = excluded.muted, mute_until = excluded.mute_until`,
        [userId, kind, target, pinnedAt, muted, muteUntil]
      );
    }
    return shape({ kind, target, pinned_at: pinnedAt, muted, mute_until: muteUntil });
  });
}

// Whether `userId` has the conversation muted right now (then it doesn't push to them).
async function isConversationMuted(userId, kind, target) {
  return (await getSetting(userId, kind, target)).muted;
}

module.exports = { KINDS, MAX_PINNED, listSettings, getSetting, changeSetting, isConversationMuted };
