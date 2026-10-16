import { describe, it, expect } from 'vitest';
import { mergeNewestPage } from './catchUp';

const row = (id, extra = {}) => ({ id, sender_id: 2, plaintext: `text ${id}`, ...extra });
const ids = (list) => list.map((m) => m.id);

describe('mergeNewestPage', () => {
  it('adds what was missed, keeping the rows already shown as they are', () => {
    const prev = [row(1), row(2), row(3)];
    const { messages, gap, added } = mergeNewestPage(prev, [row(2), row(3), row(4), row(5)], 50);
    expect(ids(messages)).toEqual([1, 2, 3, 4, 5]);
    expect(messages[1]).toBe(prev[1]);
    expect(ids(added)).toEqual([4, 5]);
    expect(gap).toBe(false);
  });

  it('returns the same list when nothing changed', () => {
    const prev = [row(1), row(2)];
    const result = mergeNewestPage(prev, [row(1), row(2)], 50);
    expect(result.messages).toBe(prev);
    expect(result.added).toEqual([]);
  });

  it('applies missed edits and deletes within the page, keeping its own fields', () => {
    const prev = [row(1), row(2, { clientKey: 'temp-1', status: 'sent' }), row(3), row(4)];
    const { messages } = mergeNewestPage(prev, [row(2, { plaintext: 'edited', edited: 1 }), row(4)], 50);
    expect(ids(messages)).toEqual([1, 2, 4]);
    expect(messages[1]).toMatchObject({ plaintext: 'edited', edited: 1, clientKey: 'temp-1' });
    expect(messages[2]).toBe(prev[3]);
  });

  it('keeps messages being sent last, and one the page already has becomes the stored row', () => {
    const prev = [
      row(1),
      { id: 'temp-1', sender_id: 1, plaintext: 'hi', status: 'pending' },
      { id: 'temp-2', sender_id: 1, plaintext: 'later', status: 'pending' },
    ];
    const { messages } = mergeNewestPage(prev, [row(1), row(2, { sender_id: 1, plaintext: 'hi' })], 50);
    expect(ids(messages)).toEqual([1, 2, 'temp-2']);
    expect(messages[1].clientKey).toBe('temp-1');
  });

  it('starts again from the page when more than a page was missed', () => {
    const prev = [row(1), row(2), { id: 'temp-1', sender_id: 1, plaintext: 'x', status: 'pending' }];
    const { messages, gap } = mergeNewestPage(prev, [row(10), row(11), row(12)], 3);
    expect(gap).toBe(true);
    expect(ids(messages)).toEqual([10, 11, 12, 'temp-1']);
  });

  it('leaves an empty page alone', () => {
    const prev = [row(1)];
    expect(mergeNewestPage(prev, [], 50).messages).toBe(prev);
  });
});
