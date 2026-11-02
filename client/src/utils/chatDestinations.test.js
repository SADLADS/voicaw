import { describe, expect, it } from 'vitest';
import { orderByRecent } from './chatDestinations';

const list = [
  { key: 'notes' },
  { key: 'u-2' },
  { key: 'u-3' },
  { key: 'g-abc' },
  { key: 'c-10' },
  { key: 'c-11' },
];

describe('orderByRecent', () => {
  it('puts where you last sent first, newest first, then the rest as they were', () => {
    const recents = [
      { kind: 'channel', id: 11, at: 300 },
      { kind: 'dm', id: 1, at: 200 }, // yourself: your notes
      { kind: 'group', id: 'abc', at: 100 },
    ];
    expect(orderByRecent(list, recents, 1).map((d) => d.key)).toEqual(['c-11', 'notes', 'g-abc', 'u-2', 'u-3', 'c-10']);
  });

  it('leaves out chats you can no longer send to', () => {
    const recents = [{ kind: 'channel', id: 99, at: 500 }, { kind: 'dm', id: 3, at: 10 }];
    expect(orderByRecent(list, recents, 1).map((d) => d.key)).toEqual(['u-3', 'notes', 'u-2', 'g-abc', 'c-10', 'c-11']);
  });

  it('keeps the order while the recent chats are loading', () => {
    expect(orderByRecent(list, null, 1)).toEqual(list);
  });
});
