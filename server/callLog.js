const db = require('./db');

// Calls in the chat history: when a DM or group call ends, a row in its chat with `system` =
// 'call', the caller as sender, and as content (plaintext, like a "poll ended" row: the server
// knows all of it anyway) `{ v: 1, outcome, duration, joined }`:
// - outcome 'ended': someone picked up; `duration` in seconds (a 1:1 call from the answer, a
//   group call from its start).
// - 'missed': nobody picked up (no answer, the caller hung up first, or in a group nobody
//   joined); 'declined': the callee declined a 1:1 call.
// - `joined`: who was in it (the caller too, for a group call).
// Clients show it as a notice, never as a message. A missed or declined call is unread for
// the people it rang; an ended one isn't for those who were in it. No push (the ringing
// notification already became "Missed call").
const CALL_LOG = 'call';

async function insertCallRow(call, outcome, endedAt) {
  const startedAt = call.groupId ? call.createdAt : call.answeredAt;
  const duration = outcome === 'ended' ? Math.max(0, Math.round((endedAt - startedAt) / 1000)) : 0;
  const content = JSON.stringify({ v: 1, outcome, duration, joined: [...call.joined] });

  if (!call.groupId) {
    const { lastID } = await db.run(
      `INSERT INTO direct_messages (sender_id, recipient_id, content, system, timestamp)
       VALUES (?, ?, ?, ?, strftime('%s','now'))`,
      [call.callerId, call.calleeId, content, CALL_LOG]
    );
    if (outcome !== 'ended') await db.run(
      `INSERT INTO dm_unread (user_id, from_user_id, count, first_unread_id) VALUES (?, ?, 1, ?)
       ON CONFLICT(user_id, from_user_id) DO UPDATE SET count = count + 1`,
      [call.calleeId, call.callerId, lastID]
    );
    return lastID;
  }

  // In the group's latest epoch: everyone in it now reads it, those removed meanwhile don't.
  const latest = await db.get('SELECT MAX(epoch) AS epoch FROM group_dm_epochs WHERE group_id = ?', [call.groupId]);
  if (latest?.epoch == null) return null;
  const { prev } = await db.get('SELECT MAX(id) AS prev FROM group_dm_messages WHERE group_id = ?', [call.groupId]);
  const { lastID } = await db.run(
    `INSERT INTO group_dm_messages (group_id, epoch, sender_id, content, system, timestamp)
     VALUES (?, ?, ?, ?, ?, strftime('%s','now'))`,
    [call.groupId, latest.epoch, call.callerId, content, CALL_LOG]
  );
  // Those who were in the call and had read everything before it still have.
  const joined = [...call.joined];
  if (outcome === 'ended' && joined.length) await db.run(
    `UPDATE group_dm_reads SET last_read_id = ?
     WHERE group_id = ? AND last_read_id >= ? AND user_id IN (${joined.map(() => '?').join(', ')})`,
    [lastID, call.groupId, prev ?? 0, ...joined]
  );
  return lastID;
}

// Writes call `call`'s row and sends it to the chat. `reason` is endCall's.
async function logCall(call, reason) {
  const pickedUp = call.groupId ? [...call.joined].some((id) => id !== call.callerId) : call.answeredAt != null;
  const outcome = pickedUp ? 'ended' : reason === 'declined' ? 'declined' : 'missed';
  try {
    const id = await db.transaction(() => insertCallRow(call, outcome, Date.now()));
    if (id) await require('./pollTimers').deliverRow(call.groupId ? 'group' : 'dm', id);
  } catch (err) {
    console.error('Logging a call failed:', err.message);
  }
}

module.exports = { CALL_LOG, logCall };
