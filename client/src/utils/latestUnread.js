// Every chat with unread messages, newest first: { key, userId, path, count }, who sent its newest
// unread message (the rail shows their picture under the bird), the chat it's in (clicking the
// picture opens it) and how many are unread (its badge). `unreadDms` are `/dm-get-unread`'s rows
// ({ from_user_id, count, last_timestamp }), `groups` useGroupList's and `botDms` useBotDmList's
// ({ id, unread, last_unread_sender_id, last_unread_timestamp }); leave muted ones (and the open
// one) out. A group whose newest sender isn't known is skipped.
export function unreadChats({ unreadDms = [], groups = [], botDms = [] }) {
  const chats = [];
  const add = (userId, timestamp, path, count) => {
    if (userId == null) return;
    chats.push({ key: path, userId, path, count, time: Number(timestamp) || 0 });
  };
  for (const row of unreadDms) if (row.count > 0) add(row.from_user_id, row.last_timestamp, `/dm/${row.from_user_id}`, row.count);
  for (const group of groups) if (group.unread > 0) add(group.last_unread_sender_id, group.last_unread_timestamp, `/dm/g/${group.id}`, group.unread);
  for (const botDm of botDms) if (botDm.unread > 0) add(botDm.last_unread_sender_id, botDm.last_unread_timestamp, `/dm/b/${botDm.id}`, botDm.unread);
  return chats
    .sort((a, b) => b.time - a.time)
    .map(({ key, userId, path, count }) => ({ key, userId, path, count }));
}

// The newest of those: { userId, path }, or null if nothing's unread.
export function latestUnread(lists) {
  const [newest] = unreadChats(lists);
  return newest ? { userId: newest.userId, path: newest.path } : null;
}
