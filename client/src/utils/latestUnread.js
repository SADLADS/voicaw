// Who sent the newest unread message in your DMs and group DMs (the rail's DM button shows their
// picture), or null if nothing's unread. `unreadDms` are `/dm-get-unread`'s rows
// ({ from_user_id, count, last_timestamp }), `groups` useGroupList's ({ unread,
// last_unread_sender_id, last_unread_timestamp }); leave muted ones (and the open group) out.
export function latestUnreadSender({ unreadDms = [], groups = [] }) {
  let best = null;
  const consider = (userId, timestamp) => {
    if (userId == null) return;
    const time = Number(timestamp) || 0;
    if (!best || time > best.time) best = { userId, time };
  };
  for (const row of unreadDms) if (row.count > 0) consider(row.from_user_id, row.last_timestamp);
  for (const group of groups) if (group.unread > 0) consider(group.last_unread_sender_id, group.last_unread_timestamp);
  return best?.userId ?? null;
}
