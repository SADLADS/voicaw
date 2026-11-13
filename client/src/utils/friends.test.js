import { describe, expect, it } from 'vitest';
import { bumpConversation } from './friends';

const ids = (list) => list.map((u) => u.id);

describe('bumpConversation', () => {
  const list = [
    { id: 1, last_timestamp: 300 },
    { id: 2, last_timestamp: 200 },
    { id: 3, last_timestamp: null },
  ];

  it('moves the conversation to the top with its new time', () => {
    const next = bumpConversation(list, 2, 400);
    expect(ids(next)).toEqual([2, 1, 3]);
    expect(next[0].last_timestamp).toBe(400);
  });

  it('starts a conversation with someone who had none', () => {
    expect(ids(bumpConversation(list, 3, 400))).toEqual([3, 1, 2]);
  });

  it('keeps the order for an older message', () => {
    expect(ids(bumpConversation(list, 3, 250))).toEqual([1, 3, 2]);
    expect(bumpConversation(list, 2, 100)).toBe(list);
  });

  it('leaves the list alone for someone not in it', () => {
    expect(bumpConversation(list, 9, 400)).toBe(list);
  });
});
