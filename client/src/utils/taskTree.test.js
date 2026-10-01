import { describe, it, expect } from 'vitest';
import {
  buildTree, visibleRows, progressOf, canMoveTo, dropPlacement, moveLocally, applyPlacements, subtreeIds,
  dueStatus, depthOf, heightOf,
} from './taskTree';

const t = (id, parent_id = null, position = 0, extra = {}) => ({ id, parent_id, position, title: `T${id}`, assignees: [], ...extra });

// 1
// ├ 2
// │ └ 4 (done)
// └ 3
// 5
const sample = () => [t(1, null, 0), t(5, null, 1), t(3, 1, 1), t(2, 1, 0), t(4, 2, 0, { completed_at: 100 })];

describe('taskTree', () => {
  it('builds the tree in sibling order', () => {
    const tree = buildTree(sample());
    expect(tree.roots.map((n) => n.id)).toEqual([1, 5]);
    expect(tree.byId.get(1).children.map((n) => n.id)).toEqual([2, 3]);
    expect(tree.byId.get(2).children.map((n) => n.id)).toEqual([4]);
  });

  it('leaves out tasks whose parent is gone', () => {
    const tree = buildTree([t(1), t(2, 99)]);
    expect([...tree.byId.keys()]).toEqual([1]);
  });

  it('lists rows with depth, skipping collapsed subtasks', () => {
    const tree = buildTree(sample());
    expect(visibleRows(tree).map((r) => [r.node.id, r.depth])).toEqual([[1, 0], [2, 1], [4, 2], [3, 1], [5, 0]]);
    expect(visibleRows(tree, { collapsed: new Set([2]) }).map((r) => r.node.id)).toEqual([1, 2, 3, 5]);
  });

  it('filters, keeping the parents of matches (dimmed)', () => {
    const tasks = sample().map((task) => (task.id === 3 ? { ...task, assignees: [7] } : task));
    const tree = buildTree(tasks);
    const open = visibleRows(tree, { filter: 'open' });
    expect(open.map((r) => r.node.id)).toEqual([1, 2, 3, 5]);
    const mine = visibleRows(tree, { filter: 'mine', userId: 7 });
    expect(mine.map((r) => [r.node.id, r.dimmed])).toEqual([[1, true], [3, false]]);
  });

  it('counts subtasks done at every level', () => {
    expect(progressOf(buildTree(sample()).byId.get(1))).toEqual({ done: 1, total: 3 });
  });

  it('knows depths and heights', () => {
    const { byId } = buildTree(sample());
    expect(depthOf(byId, 4)).toBe(3);
    expect(depthOf(byId, null)).toBe(0);
    expect(heightOf(byId.get(1))).toBe(3);
  });

  it('never moves a task into itself or its subtasks, nor too deep', () => {
    const { byId } = buildTree(sample());
    expect(canMoveTo(byId, 1, 4)).toBe(false);
    expect(canMoveTo(byId, 2, 2)).toBe(false);
    expect(canMoveTo(byId, 5, 4)).toBe(true);
    // Five levels: 1 > 2 > 4 > 6 > 7; a two-level task can't go under 7.
    const deep = buildTree([...sample(), t(6, 4), t(7, 6), t(8), t(9, 8)]);
    expect(canMoveTo(deep.byId, 8, 7)).toBe(false);
    expect(canMoveTo(deep.byId, 9, 6)).toBe(true);
  });

  it('works out where a drop lands', () => {
    const { byId } = buildTree(sample());
    expect(dropPlacement(byId, 5, byId.get(3), 'before')).toEqual({ parentId: 1, beforeId: 3 });
    expect(dropPlacement(byId, 5, byId.get(3), 'after')).toEqual({ parentId: 1, beforeId: null });
    expect(dropPlacement(byId, 5, byId.get(3), 'inside')).toEqual({ parentId: 3, beforeId: null });
    // Just below an open task with subtasks: its first subtask.
    expect(dropPlacement(byId, 5, byId.get(1), 'after', { expanded: true })).toEqual({ parentId: 1, beforeId: 2 });
    expect(dropPlacement(byId, 3, byId.get(1), 'after')).toEqual({ parentId: null, beforeId: 5 });
    // Onto itself, into its own subtask, or where it already is: nothing.
    expect(dropPlacement(byId, 1, byId.get(1), 'inside')).toBeNull();
    expect(dropPlacement(byId, 1, byId.get(4), 'inside')).toBeNull();
    expect(dropPlacement(byId, 2, byId.get(3), 'before')).toBeNull();
    expect(dropPlacement(byId, 5, byId.get(1), 'after')).toBeNull();
  });

  it('moves locally as the server does', () => {
    const moved = moveLocally(sample(), 5, 1, 3);
    const tree = buildTree(moved);
    expect(tree.roots.map((n) => n.id)).toEqual([1]);
    expect(tree.byId.get(1).children.map((n) => n.id)).toEqual([2, 5, 3]);
    expect(moveLocally(sample(), 5, 1, 99)).toEqual(sample());
  });

  it('applies placements from the server', () => {
    const placed = applyPlacements(sample(), [{ id: 3, parent_id: null, position: 0 }]);
    expect(placed.find((task) => task.id === 3)).toMatchObject({ parent_id: null, position: 0 });
  });

  it('collects a subtree', () => {
    expect([...subtreeIds(sample(), 1)].sort()).toEqual([1, 2, 3, 4]);
  });

  it('says how urgent a due date is', () => {
    const today = '2026-10-01';
    expect(dueStatus('2026-09-30', { today })).toBe('overdue');
    expect(dueStatus('2026-09-30', { today, completed: true })).toBeNull();
    expect(dueStatus('2026-10-01', { today })).toBe('today');
    expect(dueStatus('2026-10-03', { today })).toBe('soon');
    expect(dueStatus('2026-10-04', { today })).toBeNull();
    expect(dueStatus(null, { today })).toBeNull();
    // Across a month end.
    expect(dueStatus('2026-11-01', { today: '2026-10-31' })).toBe('soon');
  });
});
