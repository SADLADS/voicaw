import { describe, expect, it } from 'vitest';
import { latestUnread, unreadChats } from './latestUnread';

describe('unreadChats', () => {
  it('lists every chat with unread messages, newest first, with its count', () => {
    const unreadDms = [{ from_user_id: 2, count: 1, last_timestamp: 100 }, { from_user_id: 3, count: 0, last_timestamp: 900 }];
    const groups = [{ id: 'g', unread: 4, last_unread_sender_id: 7, last_unread_timestamp: 400 }, { id: 'x', unread: 2, last_unread_sender_id: null }];
    const botDms = [{ id: 5, unread: 120, last_unread_sender_id: 8, last_unread_timestamp: 300 }];
    expect(unreadChats({ unreadDms, groups, botDms })).toEqual([
      { key: '/dm/g/g', userId: 7, path: '/dm/g/g', count: 4, group: groups[0] },
      { key: '/dm/b/5', userId: 8, path: '/dm/b/5', count: 120 },
      { key: '/dm/2', userId: 2, path: '/dm/2', count: 1 },
    ]);
    expect(unreadChats({})).toEqual([]);
  });
});

describe('latestUnread', () => {
  it('is null when nothing is unread', () => {
    expect(latestUnread({})).toBeNull();
    expect(latestUnread({ unreadDms: [{ from_user_id: 2, count: 0, last_timestamp: 9 }], groups: [{ unread: 0 }], botDms: [{ unread: 0 }] })).toBeNull();
  });

  it('picks whoever sent the newest unread message, and the chat it is in', () => {
    const unreadDms = [{ from_user_id: 2, count: 1, last_timestamp: 100 }, { from_user_id: 3, count: 4, last_timestamp: 300 }];
    expect(latestUnread({ unreadDms })).toEqual({ userId: 3, path: '/dm/3' });
    const groups = [{ id: 'g', unread: 2, last_unread_sender_id: 7, last_unread_timestamp: 400 }];
    expect(latestUnread({ unreadDms, groups })).toEqual({ userId: 7, path: '/dm/g/g' });
    expect(latestUnread({ unreadDms, groups: [{ ...groups[0], last_unread_timestamp: 200 }] })).toEqual({ userId: 3, path: '/dm/3' });
    const botDms = [{ id: 5, bot_id: 8, unread: 1, last_unread_sender_id: 8, last_unread_timestamp: 500 }];
    expect(latestUnread({ unreadDms, groups, botDms })).toEqual({ userId: 8, path: '/dm/b/5' });
  });

  it('skips a group without a known sender', () => {
    expect(latestUnread({ groups: [{ unread: 1, last_unread_sender_id: null }] })).toBeNull();
  });
});
