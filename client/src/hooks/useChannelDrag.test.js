import { describe, it, expect } from 'vitest';
import { applyCategoryMove, applyChannelMove, categoryDropTarget, channelDropTarget } from './useChannelDrag';

// Rows 20px tall, stacked: uncategorised #a, then category 1 (#b, #c), then empty category 2.
const rows = [
  { kind: 'channel', id: 10, categoryId: null, top: 0, bottom: 20 },
  { kind: 'category', id: 1, top: 20, bottom: 40 },
  { kind: 'channel', id: 11, categoryId: 1, top: 40, bottom: 60 },
  { kind: 'channel', id: 12, categoryId: 1, top: 60, bottom: 80 },
  { kind: 'category', id: 2, top: 80, bottom: 100 },
];

describe('channelDropTarget', () => {
  it('goes before the first row whose middle is below the pointer', () => {
    expect(channelDropTarget(rows, 5)).toEqual({ categoryId: null, beforeId: 10, lineY: 0 });
    expect(channelDropTarget(rows, 55)).toEqual({ categoryId: 1, beforeId: 12, lineY: 60 });
  });

  it("puts it at the end of the section above a category's header", () => {
    // Top half of category 1's header: the end of the uncategorised ones.
    expect(channelDropTarget(rows, 25)).toEqual({ categoryId: null, beforeId: null, lineY: 20 });
    // Bottom half: the start of category 1.
    expect(channelDropTarget(rows, 35)).toEqual({ categoryId: 1, beforeId: 11, lineY: 40 });
    // Above category 2's header: the end of category 1.
    expect(channelDropTarget(rows, 85)).toEqual({ categoryId: 1, beforeId: null, lineY: 80 });
  });

  it('puts it in the last section below everything, even an empty category', () => {
    expect(channelDropTarget(rows, 95)).toEqual({ categoryId: 2, beforeId: null, lineY: 100 });
    expect(channelDropTarget(rows.slice(0, 4), 500)).toEqual({ categoryId: 1, beforeId: null, lineY: 80 });
  });
});

describe('categoryDropTarget', () => {
  const blocks = [
    { id: 1, top: 20, headerMiddle: 30, bottom: 80 },
    { id: 2, top: 80, headerMiddle: 90, bottom: 100 },
  ];
  it("goes before the first category whose header's middle is below the pointer, else last", () => {
    expect(categoryDropTarget(blocks, 0)).toEqual({ beforeId: 1, lineY: 20 });
    expect(categoryDropTarget(blocks, 50)).toEqual({ beforeId: 2, lineY: 80 });
    expect(categoryDropTarget(blocks, 95)).toEqual({ beforeId: null, lineY: 100 });
  });
});

describe('applying moves', () => {
  const guild = {
    categories: [{ id: 1, position: 0 }, { id: 2, position: 1 }],
    channels: [
      { id: 10, category_id: null, position: 0 },
      { id: 11, category_id: 1, position: 1 },
      { id: 12, category_id: 1, position: 2 },
      { id: 13, category_id: 2, position: 3 },
    ],
  };
  const order = (g) => [...g.channels].sort((a, b) => a.position - b.position).map((c) => `${c.id}:${c.category_id ?? '-'}`);

  it('moves a channel before another, to the end of a category, or out of them', () => {
    expect(order(applyChannelMove(guild, 12, { categoryId: 1, beforeId: 11 }))).toEqual(['10:-', '12:1', '11:1', '13:2']);
    expect(order(applyChannelMove(guild, 10, { categoryId: 2, beforeId: null }))).toEqual(['11:1', '12:1', '13:2', '10:2']);
    expect(order(applyChannelMove(guild, 13, { categoryId: null, beforeId: 10 }))).toEqual(['13:-', '10:-', '11:1', '12:1']);
  });

  it('moves categories', () => {
    const ids = (g) => [...g.categories].sort((a, b) => a.position - b.position).map((c) => c.id);
    expect(ids(applyCategoryMove(guild, 2, { beforeId: 1 }))).toEqual([2, 1]);
    expect(ids(applyCategoryMove(guild, 1, { beforeId: null }))).toEqual([2, 1]);
  });
});
