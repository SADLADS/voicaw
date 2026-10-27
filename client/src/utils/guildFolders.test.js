import { describe, expect, it } from 'vitest';
import { applyDrop, buildRail, dropTarget, folderLabel, railLayout } from './guildFolders';

const g = (id) => ({ id, name: `G${id}` });
const guilds = [g(1), g(2), g(3), g(4), g(5)];
const makeId = () => 99;

describe('buildRail', () => {
  it('puts each folder where its first guild is', () => {
    const items = buildRail(guilds, [{ id: 7, name: 'F', color: null, guildIds: [4, 2] }]);
    expect(items.map((i) => `${i.type}:${i.id}`)).toEqual(['guild:1', 'folder:7', 'guild:3', 'guild:5']);
    expect(items[1].guilds.map((x) => x.id)).toEqual([2, 4]);
  });

  it('shows a folder with one guild left as that guild', () => {
    const items = buildRail(guilds, [{ id: 7, name: 'F', color: null, guildIds: [2, 42] }]);
    expect(items.map((i) => i.type)).toEqual(['guild', 'guild', 'guild', 'guild', 'guild']);
  });

  it('round-trips through the saved layout', () => {
    const folders = [{ id: 7, name: null, color: 0xff0000, guildIds: [2, 3] }];
    expect(railLayout(buildRail(guilds, folders))).toEqual({ guildIds: [1, 2, 3, 4, 5], folders });
  });
});

describe('folderLabel', () => {
  it('is the name, or the guilds’ names', () => {
    expect(folderLabel({ name: 'Games', guilds: [g(1)] })).toBe('Games');
    expect(folderLabel({ name: null, guilds: [g(1), g(2)] })).toBe('G1, G2');
  });
});

describe('dropTarget', () => {
  const rows = [
    { key: 'g:1', type: 'guild', id: 1, top: 0, bottom: 48 },
    { key: 'f:7', type: 'folder', id: 7, open: true, top: 56, bottom: 104 },
    { key: 'g:2', type: 'guild', id: 2, folderId: 7, top: 112, bottom: 160 },
    { key: 'f:8', type: 'folder', id: 8, open: false, top: 168, bottom: 216 },
  ];

  it('combines on a guild’s middle, and goes between near its edges', () => {
    expect(dropTarget(rows, 24)).toEqual({ type: 'combine', id: 1 });
    expect(dropTarget(rows, 5)).toEqual({ type: 'before', key: 'g:1' });
    expect(dropTarget(rows, 45)).toEqual({ type: 'after', key: 'g:1' });
    expect(dropTarget(rows, 52)).toEqual({ type: 'before', key: 'f:7' });
  });

  it('goes into folders', () => {
    expect(dropTarget(rows, 192)).toEqual({ type: 'into', id: 8 });
    expect(dropTarget(rows, 90)).toEqual({ type: 'into', id: 7, start: true });
    expect(dropTarget(rows, 60)).toEqual({ type: 'before', key: 'f:7' });
    expect(dropTarget(rows, 130)).toEqual({ type: 'before', key: 'g:2' });
    expect(dropTarget(rows, 150)).toEqual({ type: 'after', key: 'g:2' });
    expect(dropTarget(rows, 300)).toEqual({ type: 'end' });
  });

  it('only goes between rows when dragging a folder', () => {
    expect(dropTarget(rows, 20, { folder: true })).toEqual({ type: 'before', key: 'g:1' });
    expect(dropTarget(rows, 192, { folder: true })).toEqual({ type: 'after', key: 'f:8' });
  });
});

describe('applyDrop', () => {
  const rail = () => buildRail(guilds, [{ id: 7, name: 'F', color: 1, guildIds: [3, 4] }]);
  const layout = (items) => items && railLayout(items);

  it('makes a folder from a guild dropped on another', () => {
    expect(layout(applyDrop(rail(), 'g:5', { type: 'combine', id: 1 }, makeId))).toEqual({
      guildIds: [1, 5, 2, 3, 4],
      folders: [{ id: 99, name: null, color: null, guildIds: [1, 5] }, { id: 7, name: 'F', color: 1, guildIds: [3, 4] }],
    });
  });

  it('adds a guild to a folder and takes one out', () => {
    expect(layout(applyDrop(rail(), 'g:1', { type: 'into', id: 7 }))).toEqual({
      guildIds: [2, 3, 4, 1, 5],
      folders: [{ id: 7, name: 'F', color: 1, guildIds: [3, 4, 1] }],
    });
    expect(layout(applyDrop(rail(), 'g:1', { type: 'after', key: 'g:3' }))).toEqual({
      guildIds: [2, 3, 1, 4, 5],
      folders: [{ id: 7, name: 'F', color: 1, guildIds: [3, 1, 4] }],
    });
    // Out of a folder of two: the folder goes.
    expect(layout(applyDrop(rail(), 'g:3', { type: 'end' }))).toEqual({ guildIds: [1, 2, 4, 5, 3], folders: [] });
  });

  it('moves a folder whole', () => {
    expect(layout(applyDrop(rail(), 'f:7', { type: 'before', key: 'g:1' }))).toEqual({
      guildIds: [3, 4, 1, 2, 5],
      folders: [{ id: 7, name: 'F', color: 1, guildIds: [3, 4] }],
    });
  });

  it('says when nothing moved', () => {
    expect(applyDrop(rail(), 'g:2', { type: 'after', key: 'g:1' })).toBeNull();
    expect(applyDrop(rail(), 'g:2', { type: 'before', key: 'f:7' })).toBeNull();
    expect(applyDrop(rail(), 'g:2', null)).toBeNull();
  });
});
