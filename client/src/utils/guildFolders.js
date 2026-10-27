import { serverSuffix } from './server';

// Guild folders in the rail (as Discord's): the rail is a list of items, each a guild or a
// folder of guilds, saved as the order of every guild plus the folders (PUT /guilds-order).
// A folder is { id, name, color, guilds }: `id` made here (newFolderId), `name` null for none
// (its guilds' names stand in), `color` 0xRRGGBB or null (the theme's).

// A folder's id: random, as Discord's (unique among one person's folders is all it needs).
export const newFolderId = () => 1 + Math.floor(Math.random() * 2 ** 31);

// The rail's items from the guilds (in rail order) and the folders ({ id, name, color, guildIds }).
// A folder sits where its first guild is, with its guilds in rail order; one left with a single
// guild (the others left) shows as that guild, and goes when the rail is next saved.
export function buildRail(guilds, folders = []) {
  const folderOf = new Map();
  for (const folder of folders) for (const id of folder.guildIds) folderOf.set(id, folder);
  const items = [];
  const placed = new Set();
  for (const guild of guilds) {
    const folder = folderOf.get(guild.id);
    if (!folder) {
      items.push({ type: 'guild', id: guild.id, guild });
    } else if (!placed.has(folder.id)) {
      placed.add(folder.id);
      const members = guilds.filter((g) => folderOf.get(g.id) === folder);
      items.push(members.length > 1
        ? { type: 'folder', id: folder.id, name: folder.name ?? null, color: folder.color ?? null, guilds: members }
        : { type: 'guild', id: guild.id, guild });
    }
  }
  return items;
}

// What's saved for the items: { guildIds, folders: [{ id, name, color, guildIds }] }.
export function railLayout(items) {
  const guildIds = [];
  const folders = [];
  for (const item of items) {
    if (item.type === 'guild') {
      guildIds.push(item.id);
    } else {
      const ids = item.guilds.map((g) => g.id);
      guildIds.push(...ids);
      folders.push({ id: item.id, name: item.name, color: item.color, guildIds: ids });
    }
  }
  return { guildIds, folders };
}

// A folder's label: its name, or its guilds' names.
export const folderLabel = (folder) => folder.name || folder.guilds.map((g) => g.name).join(', ');

// Where a dragged item would land, from the rail's rows as drawn and the pointer's height `y`.
// `rows` (top to bottom): { key, type: 'guild' | 'folder', id, folderId (a guild inside an open
// folder: that folder's id), open (a folder), top, bottom }, without the dragged item's own.
// Dragging a guild: onto the middle of a guild outside folders, { type: 'combine', id } (they
// become a folder); onto a closed folder's middle or an open one's lower half, { type: 'into',
// id } (at its end; an open folder's lower half: { ..., start: true }); otherwise between rows,
// { type: 'before' | 'after', key } (inside a folder when that row is). Dragging a folder
// (`folder` true), rows are the top-level items only (an open folder's row spanning its guilds),
// and it only goes between them. Below every row: { type: 'end' }.
export function dropTarget(rows, y, { folder = false } = {}) {
  for (const row of rows) {
    if (y >= row.bottom) continue;
    if (y < row.top) return { type: 'before', key: row.key };
    const at = (y - row.top) / (row.bottom - row.top);
    if (folder || row.folderId != null) return { type: at < 0.5 ? 'before' : 'after', key: row.key };
    if (row.type === 'folder' && row.open) return at < 0.5 ? { type: 'before', key: row.key } : { type: 'into', id: row.id, start: true };
    if (at < 0.25) return { type: 'before', key: row.key };
    if (at > 0.75) return { type: 'after', key: row.key };
    return row.type === 'folder' ? { type: 'into', id: row.id } : { type: 'combine', id: row.id };
  }
  return { type: 'end' };
}

// The key a rail row is known by: 'g:<id>' a guild, 'f:<id>' a folder.
export const rowKey = (type, id) => `${type === 'folder' ? 'f' : 'g'}:${id}`;

// The items after dropping the item `key` at `target` (dropTarget's), or null if nothing moved.
// A folder left with one guild becomes that guild. `makeId` names a new folder.
export function applyDrop(items, key, target, makeId = newFolderId) {
  if (!target) return null;
  const isFolder = key.startsWith('f:');
  const id = Number(key.slice(2));
  let moved = null;
  // Taken out of wherever it was.
  let next = [];
  for (const item of items) {
    if (rowKey(item.type, item.id) === key) {
      moved = item;
    } else if (!isFolder && item.type === 'folder' && item.guilds.some((g) => g.id === id)) {
      const guild = item.guilds.find((g) => g.id === id);
      moved = { type: 'guild', id, guild };
      next.push({ ...item, guilds: item.guilds.filter((g) => g.id !== id) });
    } else {
      next.push(item);
    }
  }
  if (!moved) return null;

  if (target.type === 'end') {
    next.push(moved);
  } else if (target.type === 'combine' && !isFolder) {
    next = next.map((item) => (item.type === 'guild' && item.id === target.id
      ? { type: 'folder', id: makeId(), name: null, color: null, guilds: [item.guild, moved.guild] }
      : item));
  } else if (target.type === 'into' && !isFolder) {
    next = next.map((item) => (item.type === 'folder' && item.id === target.id
      ? { ...item, guilds: target.start ? [moved.guild, ...item.guilds] : [...item.guilds, moved.guild] }
      : item));
  } else if (target.type === 'before' || target.type === 'after') {
    const offset = target.type === 'after' ? 1 : 0;
    const topIndex = next.findIndex((item) => rowKey(item.type, item.id) === target.key);
    if (topIndex !== -1) {
      next.splice(topIndex + offset, 0, moved);
    } else {
      // A guild inside a folder: in the folder beside it (a folder dragged there goes beside the
      // folder instead).
      const guildId = Number(target.key.slice(2));
      const folderIndex = next.findIndex((item) => item.type === 'folder' && item.guilds.some((g) => g.id === guildId));
      if (folderIndex === -1) return null;
      if (isFolder) {
        next.splice(folderIndex + offset, 0, moved);
      } else {
        const folder = next[folderIndex];
        const guilds = [...folder.guilds];
        guilds.splice(guilds.findIndex((g) => g.id === guildId) + offset, 0, moved.guild);
        next[folderIndex] = { ...folder, guilds };
      }
    }
  } else {
    return null;
  }

  next = next.flatMap((item) => {
    if (item.type !== 'folder' || item.guilds.length > 1) return [item];
    return item.guilds.map((guild) => ({ type: 'guild', id: guild.id, guild }));
  });
  const same = JSON.stringify(railLayout(next)) === JSON.stringify(railLayout(items));
  return same ? null : next;
}

// Which folders are open on this device (as Discord, not synced): a Set of ids.
const OPEN_KEY = () => `openGuildFolders${serverSuffix()}`;

export function loadOpenFolders() {
  try {
    const ids = JSON.parse(localStorage.getItem(OPEN_KEY()) ?? '[]');
    return new Set(Array.isArray(ids) ? ids.filter(Number.isSafeInteger) : []);
  } catch {
    return new Set();
  }
}

export function saveOpenFolders(ids) {
  try {
    if (ids.size) localStorage.setItem(OPEN_KEY(), JSON.stringify([...ids]));
    else localStorage.removeItem(OPEN_KEY());
  } catch {
    // Private mode or storage off: it just isn't remembered.
  }
}
