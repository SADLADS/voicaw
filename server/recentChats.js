const db = require('./db');

// Where you last sent a message, newest first: the Android app's share screen (client
// components/ShareDialog.jsx) lists those chats first. Worked out from the message tables,
// nothing kept for it, and only your own sends (the server already holds who sent what where,
// encrypted chats included: only their content is hidden from it). Each is
// { kind: 'dm' | 'group' | 'channel', id, at } (unix s); a DM to yourself is your notes.
// Groups you've left aren't listed; the app shows only the chats it still knows (people,
// your groups, channels you may send in).
const LIMIT = 50;

async function recentChatsFor(userId) {
  const [dms, groups, channels] = await Promise.all([
    db.all(
      `SELECT recipient_id AS id, MAX(id) AS last FROM direct_messages
       WHERE sender_id = ? AND system IS NULL GROUP BY recipient_id ORDER BY last DESC LIMIT ?`,
      [userId, LIMIT]
    ),
    db.all(
      `SELECT m.group_id AS id, MAX(m.id) AS last FROM group_dm_messages m
       JOIN group_dm_members gm ON gm.group_id = m.group_id AND gm.user_id = m.sender_id
       WHERE m.sender_id = ? AND m.system IS NULL GROUP BY m.group_id ORDER BY last DESC LIMIT ?`,
      [userId, LIMIT]
    ),
    db.all(
      `SELECT channel_id AS id, MAX(id) AS last FROM guild_messages
       WHERE sender_id = ? AND system IS NULL AND webhook_id IS NULL GROUP BY channel_id ORDER BY last DESC LIMIT ?`,
      [userId, LIMIT]
    ),
  ]);
  // The newest message's time in each (MAX(id) is the newest: ids only grow).
  const timesOf = async (table, rows) => {
    if (!rows.length) return new Map();
    const times = await db.all(
      `SELECT id, timestamp FROM ${table} WHERE id IN (${rows.map(() => '?').join(',')})`,
      rows.map((row) => row.last)
    );
    return new Map(times.map((row) => [row.id, row.timestamp]));
  };
  const [dmTimes, groupTimes, channelTimes] = await Promise.all([
    timesOf('direct_messages', dms), timesOf('group_dm_messages', groups), timesOf('guild_messages', channels),
  ]);
  return [
    ...dms.map((row) => ({ kind: 'dm', id: row.id, at: dmTimes.get(row.last) ?? 0, last: row.last })),
    ...groups.map((row) => ({ kind: 'group', id: row.id, at: groupTimes.get(row.last) ?? 0, last: row.last })),
    ...channels.map((row) => ({ kind: 'channel', id: row.id, at: channelTimes.get(row.last) ?? 0, last: row.last })),
  ]
    // Seconds tie often; within a kind the newer id wins.
    .sort((a, b) => b.at - a.at || (a.kind === b.kind ? b.last - a.last : 0))
    .map(({ kind, id, at }) => ({ kind, id, at }));
}

module.exports = { recentChatsFor };
