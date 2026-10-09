// The newest unread message in your DMs, group DMs and bot DMs: { userId, path }, who sent it
// (the rail's DM button shows their picture) and the chat it's in (clicking the button opens it),
// or null if nothing's unread. `unreadDms` are `/dm-get-unread`'s rows
// ({ from_user_id, count, last_timestamp }), `groups` useGroupList's and `botDms` useBotDmList's
// ({ id, unread, last_unread_sender_id, last_unread_timestamp }); leave muted ones (and the open
// one) out.
export function latestUnread({ unreadDms = [], groups = [], botDms = [] }) {
  let best = null;
  const consider = (userId, timestamp, path) => {
    if (userId == null) return;
    const time = Number(timestamp) || 0;
    if (!best || time > best.time) best = { userId, time, path };
  };
  for (const row of unreadDms) if (row.count > 0) consider(row.from_user_id, row.last_timestamp, `/dm/${row.from_user_id}`);
  for (const group of groups) if (group.unread > 0) consider(group.last_unread_sender_id, group.last_unread_timestamp, `/dm/g/${group.id}`);
  for (const botDm of botDms) if (botDm.unread > 0) consider(botDm.last_unread_sender_id, botDm.last_unread_timestamp, `/dm/b/${botDm.id}`);
  return best && { userId: best.userId, path: best.path };
}
