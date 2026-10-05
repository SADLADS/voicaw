import { describe, expect, it } from 'vitest';
import { latestUnreadSender } from './latestUnread';

describe('latestUnreadSender', () => {
  it('is null when nothing is unread', () => {
    expect(latestUnreadSender({})).toBeNull();
    expect(latestUnreadSender({ unreadDms: [{ from_user_id: 2, count: 0, last_timestamp: 9 }], groups: [{ unread: 0 }] })).toBeNull();
  });

  it('picks whoever sent the newest unread message, in a DM or a group', () => {
    const unreadDms = [{ from_user_id: 2, count: 1, last_timestamp: 100 }, { from_user_id: 3, count: 4, last_timestamp: 300 }];
    expect(latestUnreadSender({ unreadDms })).toBe(3);
    const groups = [{ id: 'g', unread: 2, last_unread_sender_id: 7, last_unread_timestamp: 400 }];
    expect(latestUnreadSender({ unreadDms, groups })).toBe(7);
    expect(latestUnreadSender({ unreadDms, groups: [{ ...groups[0], last_unread_timestamp: 200 }] })).toBe(3);
  });

  it('skips a group without a known sender', () => {
    expect(latestUnreadSender({ groups: [{ unread: 1, last_unread_sender_id: null }] })).toBeNull();
  });
});
