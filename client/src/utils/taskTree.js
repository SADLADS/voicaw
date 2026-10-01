// List channels' tasks (server/routes/guildTasks.js) as a tree: the server sends every task of
// a board flat ({ id, parent_id, position, ... }); these build the tree, decide what the board
// shows, and where a dragged task may go. Kept in step with the server's rules (MAX_DEPTH).

export const MAX_DEPTH = 5;
export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 4000;
export const MAX_COMMENT = 2000;
export const MAX_ASSIGNEES = 10;

const bySiblingOrder = (a, b) => a.position - b.position || a.id - b.id;

// { roots, byId, childrenOf }: nodes are the tasks plus `children` (in order). A task whose
// parent is missing (deleted while an event was on its way) is left out.
export function buildTree(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, { ...t, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_id == null) roots.push(node);
    else byId.get(node.parent_id)?.children.push(node);
  }
  const sort = (list) => {
    list.sort(bySiblingOrder);
    for (const node of list) sort(node.children);
  };
  sort(roots);
  // Only what hangs off a root (a parent cycle can't happen, but an orphan can).
  const reachable = new Map();
  const walk = (node) => {
    reachable.set(node.id, node);
    node.children.forEach(walk);
  };
  roots.forEach(walk);
  return { roots, byId: reachable };
}

// How many of the task's subtasks (all levels) are done: { done, total }.
export function progressOf(node) {
  let done = 0;
  let total = 0;
  const walk = (n) => {
    for (const child of n.children) {
      total += 1;
      if (child.completed_at) done += 1;
      walk(child);
    }
  };
  walk(node);
  return { done, total };
}

// Whether `task` passes the board's filter: 'all', 'open' (not completed) or 'mine'
// (assigned to `userId` and not completed).
export function matchesFilter(task, filter, userId) {
  if (filter === 'open') return !task.completed_at;
  if (filter === 'mine') return !task.completed_at && task.assignees?.includes(userId);
  return true;
}

// The rows the board shows, top to bottom: [{ node, depth (top level 0), hasChildren,
// expanded }]. Collapsed tasks hide their subtasks. With a filter, a task shows if it or any
// of its subtasks matches (so a match keeps its place in the tree); `dimmed` marks those shown
// only for a subtask's sake.
export function visibleRows(tree, { collapsed = new Set(), filter = 'all', userId = null } = {}) {
  const shown = new Map();
  const check = (node) => {
    let any = matchesFilter(node, filter, userId);
    const self = any;
    for (const child of node.children) if (check(child)) any = true;
    shown.set(node.id, { any, self });
    return any;
  };
  tree.roots.forEach(check);

  const rows = [];
  const add = (node, depth) => {
    const state = shown.get(node.id);
    if (!state.any) return;
    const children = node.children.filter((c) => shown.get(c.id).any);
    const expanded = !collapsed.has(node.id);
    rows.push({ node, depth, hasChildren: children.length > 0, expanded, dimmed: !state.self });
    if (expanded) for (const child of children) add(child, depth + 1);
  };
  for (const root of tree.roots) add(root, 0);
  return rows;
}

// How deep the task sits (top level: 1; null, the board: 0).
export function depthOf(byId, taskId) {
  let depth = 0;
  for (let node = byId.get(taskId); node; node = byId.get(node.parent_id)) depth += 1;
  return depth;
}

// How many levels its subtree has (no subtasks: 1).
export function heightOf(node) {
  return 1 + node.children.reduce((max, child) => Math.max(max, heightOf(child)), 0);
}

// Whether task `taskId` may go under `parentId` (null: the top level): not into itself or its
// own subtasks, and no deeper than MAX_DEPTH.
export function canMoveTo(byId, taskId, parentId) {
  const node = byId.get(taskId);
  if (!node) return false;
  for (let at = parentId; at != null; at = byId.get(at)?.parent_id) {
    if (at === taskId) return false;
  }
  return depthOf(byId, parentId) + heightOf(node) <= MAX_DEPTH;
}

// Where dropping onto `target` lands, for `zone` 'before' | 'after' | 'inside':
// { parentId, beforeId } (beforeId null: last), or null if it can't go there or wouldn't move.
// Just below an `expanded` task with subtasks is above its first subtask, so it goes there.
export function dropPlacement(byId, taskId, target, zone, { expanded = false } = {}) {
  if (!target || target.id === taskId) return null;
  let placement;
  const firstChild = target.children.find((c) => c.id !== taskId);
  if (zone === 'inside') {
    placement = { parentId: target.id, beforeId: null };
  } else if (zone === 'after' && expanded && firstChild) {
    placement = { parentId: target.id, beforeId: firstChild.id };
  } else {
    const parentId = target.parent_id ?? null;
    const siblings = parentId == null
      ? [...byId.values()].filter((n) => n.parent_id == null).sort(bySiblingOrder)
      : byId.get(parentId).children;
    const at = siblings.findIndex((n) => n.id === target.id);
    const rest = siblings.slice(zone === 'before' ? at : at + 1).filter((n) => n.id !== taskId);
    placement = { parentId, beforeId: rest[0]?.id ?? null };
  }
  if (!canMoveTo(byId, taskId, placement.parentId)) return null;

  // Already there?
  const node = byId.get(taskId);
  if ((node.parent_id ?? null) === placement.parentId) {
    const siblings = placement.parentId == null
      ? [...byId.values()].filter((n) => n.parent_id == null).sort(bySiblingOrder)
      : byId.get(placement.parentId).children;
    const at = siblings.findIndex((n) => n.id === taskId);
    if ((siblings[at + 1]?.id ?? null) === placement.beforeId) return null;
  }
  return placement;
}

// The tasks after moving `taskId` under `parentId` just before `beforeId` (as the server does:
// that parent's subtasks are numbered again). Returns the same list if it can't.
export function moveLocally(tasks, taskId, parentId, beforeId) {
  const siblings = tasks
    .filter((t) => (t.parent_id ?? null) === (parentId ?? null) && t.id !== taskId)
    .sort(bySiblingOrder)
    .map((t) => t.id);
  const at = beforeId == null ? siblings.length : siblings.indexOf(beforeId);
  if (at < 0) return tasks;
  siblings.splice(at, 0, taskId);
  return applyPlacements(tasks, siblings.map((id, position) => ({ id, parent_id: parentId ?? null, position })));
}

// The tasks with new { id, parent_id, position } (a `guild_tasks_move` event) applied.
export function applyPlacements(tasks, placed) {
  const byId = new Map(placed.map((p) => [p.id, p]));
  return tasks.map((t) => (byId.has(t.id) ? { ...t, parent_id: byId.get(t.id).parent_id, position: byId.get(t.id).position } : t));
}

// A task's id and every subtask's under it.
export function subtreeIds(tasks, taskId) {
  const ids = new Set([taskId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of tasks) {
      if (t.parent_id != null && ids.has(t.parent_id) && !ids.has(t.id)) {
        ids.add(t.id);
        grew = true;
      }
    }
  }
  return ids;
}

// Today as 'YYYY-MM-DD' on this device.
export function todayString(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// A due date's urgency: 'overdue' (before today), 'today', 'soon' (the next 2 days) or null.
// Completed tasks are never overdue.
export function dueStatus(dueDate, { completed = false, today = todayString() } = {}) {
  if (!dueDate || completed) return null;
  if (dueDate < today) return 'overdue';
  if (dueDate === today) return 'today';
  const [y, m, d] = today.split('-').map(Number);
  const soon = todayString(new Date(y, m - 1, d + 2));
  return dueDate <= soon ? 'soon' : null;
}

// 'YYYY-MM-DD' as a local Date (for formatDate), midnight that day.
export function dueDateValue(dueDate) {
  const [y, m, d] = dueDate.split('-').map(Number);
  return new Date(y, m - 1, d);
}
