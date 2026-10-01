import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faChevronDown, faChevronRight, faGripVertical, faListCheck, faMessage, faPlus,
} from '@fortawesome/free-solid-svg-icons';
import '../../assets/css/tasks.css';
import Avatar from '../Avatar';
import TaskDetail from './TaskDetail';
import { DueChip, TaskCheck } from './TaskBits';
import { useTaskBoard } from '../../hooks/useTaskBoard';
import { usePointerDrag } from '../../hooks/usePointerDrag';
import { PERMISSIONS, has } from '../../utils/permissions';
import { errorMessage } from '../../utils/guildDisplay';
import { displayName, useProfiles } from '../../utils/profiles';
import {
  MAX_DEPTH, MAX_TITLE, buildTree, depthOf, dropPlacement, progressOf, visibleRows,
} from '../../utils/taskTree';

const FILTERS = [['all', 'All'], ['open', 'Open'], ['mine', 'Assigned to me']];
const MAX_AVATARS = 3;

function loadCollapsed(channelId) {
  try {
    return new Set(JSON.parse(localStorage.getItem(`taskCollapsed:${channelId}`) ?? '[]'));
  } catch {
    return new Set();
  }
}

// A list channel's page (Guilded's lists): its tasks as a tree with checkboxes, assignees, due
// dates and subtask progress; a filter (all, open, assigned to me); adding tasks and subtasks;
// dragging tasks to reorder them or to put them under another (onto the middle of a row); and
// a task's details beside the board (on a phone, over it), opened by clicking it or by a link
// with ?task=<id>. What you can do follows the channel's permissions: Edit Tasks for changing
// anything, Send Messages to comment.
export default function ListChannelView({ guild, channel, user, people, reactionNames, mentionRoles, nameColors, isMobile }) {
  useProfiles();
  const board = useTaskBoard({ channelId: channel.id });
  const { tasks, loaded, addTask, editTask, placeTask } = board;
  const permissions = channel.my_permissions ?? 0;
  const canEdit = has(permissions, PERMISSIONS.EDIT_TASKS);
  const canComment = has(permissions, PERMISSIONS.SEND_MESSAGES);
  const canModerate = has(permissions, PERMISSIONS.MANAGE_MESSAGES);

  const [filter, setFilter] = useState('all');
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(channel.id));
  useEffect(() => setCollapsed(loadCollapsed(channel.id)), [channel.id]);
  const [error, setError] = useState(null);
  const [newTitle, setNewTitle] = useState('');
  // The task a subtask is being added under (an input row below it), or null.
  const [addingUnder, setAddingUnder] = useState(null);
  const [subTitle, setSubTitle] = useState('');

  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = Number(searchParams.get('task')) || null;
  const select = useCallback((id) => {
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      if (id) next.set('task', String(id));
      else next.delete('task');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const tree = useMemo(() => buildTree(tasks), [tasks]);
  const rows = useMemo(
    () => visibleRows(tree, { collapsed, filter, userId: user.id }),
    [tree, collapsed, filter, user.id]
  );
  const doneCount = tasks.filter((t) => t.completed_at).length;
  // Names from the profile store, else the member list's.
  const usernames = useMemo(() => new Map(people.map((p) => [p.id, p.username])), [people]);
  const nameFor = useCallback((id) => displayName(id, usernames.get(id) ?? 'Unknown'), [usernames]);
  const selected = selectedId ? tree.byId.get(selectedId) ?? null : null;

  // A linked task that's gone (deleted, or not on this board): close it once loaded.
  useEffect(() => {
    if (loaded && selectedId && !tree.byId.has(selectedId)) select(null);
  }, [loaded, selectedId, tree, select]);

  // Opening a task shows it in the tree: its parents expand.
  useEffect(() => {
    if (!selected) return;
    const parents = [];
    for (let p = tree.byId.get(selected.parent_id); p; p = tree.byId.get(p.parent_id)) parents.push(p.id);
    if (parents.some((id) => collapsed.has(id))) {
      setCollapsed((set) => new Set([...set].filter((id) => !parents.includes(id))));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  function saveCollapsed(next) {
    setCollapsed(next);
    try {
      localStorage.setItem(`taskCollapsed:${channel.id}`, JSON.stringify([...next]));
    } catch {
      // Not remembered, then.
    }
  }

  function toggleCollapsed(id) {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    saveCollapsed(next);
  }

  const attempt = useCallback(async (action) => {
    setError(null);
    try {
      return await action();
    } catch (err) {
      setError(errorMessage(err));
      return null;
    }
  }, []);

  async function addTop(e) {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    if (await attempt(() => addTask({ title }))) setNewTitle('');
  }

  async function addSub(e) {
    e.preventDefault();
    const title = subTitle.trim();
    if (!title) {
      setAddingUnder(null);
      return;
    }
    if (await attempt(() => addTask({ title, parentId: addingUnder }))) {
      setSubTitle('');
      if (collapsed.has(addingUnder)) toggleCollapsed(addingUnder);
    }
  }

  const toggleDone = (task) => attempt(() => editTask(task.id, { completed: !task.completed_at }));

  // ---- Dragging ----
  const listRef = useRef(null);
  const [dragId, setDragId] = useState(null);
  const [drop, setDrop] = useState(null); // { targetId, zone, placement }

  const findDrop = (taskId, y) => {
    const els = [...(listRef.current?.querySelectorAll('[data-task-row]') ?? [])];
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      if (y < rect.top || y > rect.bottom) continue;
      const id = Number(el.dataset.id);
      const row = rows.find((r) => r.node.id === id);
      if (!row) return null;
      const f = (y - rect.top) / rect.height;
      const zone = f < 0.3 ? 'before' : f > 0.7 ? 'after' : 'inside';
      const expanded = row.hasChildren && row.expanded;
      const placement = dropPlacement(tree.byId, taskId, row.node, zone, { expanded });
      return placement ? { targetId: id, zone, placement } : null;
    }
    // Below the last row: the end of the board.
    const last = els.at(-1);
    if (last && y > last.getBoundingClientRect().bottom) {
      const lastRoot = tree.roots.filter((r) => r.id !== taskId).at(-1);
      const placement = lastRoot && dropPlacement(tree.byId, taskId, lastRoot, 'after');
      return placement ? { targetId: null, zone: 'end', placement } : null;
    }
    return null;
  };

  // Scrolls the board when dragging near its top or bottom edge.
  const autoScroll = (y) => {
    const scroller = listRef.current?.closest('.task-board-scroll');
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    if (y < rect.top + 40) scroller.scrollTop -= 12;
    else if (y > rect.bottom - 40) scroller.scrollTop += 12;
  };

  const { pointerDown, contextMenu } = usePointerDrag({
    onStart: (id) => setDragId(id),
    onMove: (id, { y }) => {
      autoScroll(y);
      setDrop(findDrop(id, y));
    },
    onDrop: (id, { y }) => {
      const target = findDrop(id, y);
      setDragId(null);
      setDrop(null);
      if (!target) return;
      if (target.zone === 'inside' && collapsed.has(target.targetId)) toggleCollapsed(target.targetId);
      attempt(() => placeTask(id, target.placement));
    },
    onCancel: () => {
      setDragId(null);
      setDrop(null);
    },
  });

  function renderAssignees(task) {
    const ids = task.assignees ?? [];
    if (!ids.length) return null;
    const names = ids.map(nameFor).join(', ');
    return (
      <span className="task-assignees" title={`Assigned to ${names}`} aria-label={`Assigned to ${names}`}>
        {ids.slice(0, MAX_AVATARS).map((id) => <Avatar key={id} userId={id} className="task-assignee-avatar" />)}
        {ids.length > MAX_AVATARS && <span className="task-assignee-more">+{ids.length - MAX_AVATARS}</span>}
      </span>
    );
  }

  function renderRow({ node, depth, hasChildren, expanded, dimmed }) {
    const progress = progressOf(node);
    const isDropTarget = drop?.targetId === node.id;
    const classes = [
      'task-row',
      node.completed_at ? 'done' : '',
      dimmed ? 'dimmed' : '',
      node.id === selectedId ? 'selected' : '',
      node.id === dragId ? 'dragging' : '',
      isDropTarget ? `drop-${drop.zone}` : '',
    ].filter(Boolean).join(' ');
    return (
      <React.Fragment key={node.id}>
        <li
          className={classes}
          style={{ '--task-depth': depth }}
          data-task-row=""
          data-id={node.id}
          onPointerDown={canEdit ? (e) => {
            if (e.target.closest('button, input, a')) return;
            pointerDown(node.id, e);
          } : undefined}
          onContextMenu={contextMenu}
        >
          <div
            className="task-row-main"
            role="button"
            tabIndex={0}
            aria-label={`Open task ${node.title}`}
            onClick={() => select(node.id === selectedId ? null : node.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                select(node.id);
              }
            }}
          >
            {canEdit && !isMobile && <FontAwesomeIcon icon={faGripVertical} className="task-grip" aria-hidden="true" />}
            {hasChildren ? (
              <button
                type="button"
                className="task-caret"
                aria-label={expanded ? `Hide subtasks of ${node.title}` : `Show subtasks of ${node.title}`}
                aria-expanded={expanded}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleCollapsed(node.id);
                }}
              >
                <FontAwesomeIcon icon={expanded ? faChevronDown : faChevronRight} />
              </button>
            ) : <span className="task-caret-space" />}
            <TaskCheck task={node} disabled={!canEdit} onToggle={() => toggleDone(node)} />
            <span className="task-title">{node.title}</span>
            <span className="task-meta">
              {progress.total > 0 && (
                <span className={`task-progress${progress.done === progress.total ? ' complete' : ''}`} title="Subtasks done">
                  <FontAwesomeIcon icon={faListCheck} /> {progress.done}/{progress.total}
                </span>
              )}
              {node.comment_count > 0 && (
                <span className="task-comment-count" title={`${node.comment_count} comments`}>
                  <FontAwesomeIcon icon={faMessage} /> {node.comment_count}
                </span>
              )}
              <DueChip task={node} />
              {renderAssignees(node)}
            </span>
            {canEdit && depthOf(tree.byId, node.id) < MAX_DEPTH && (
              <button
                type="button"
                className="task-add-sub"
                aria-label={`Add a subtask to ${node.title}`}
                title="Add subtask"
                onClick={(e) => {
                  e.stopPropagation();
                  setSubTitle('');
                  setAddingUnder(node.id);
                }}
              >
                <FontAwesomeIcon icon={faPlus} />
              </button>
            )}
          </div>
        </li>
        {addingUnder === node.id && (
          <li className="task-row task-new-sub" style={{ '--task-depth': depth + 1 }}>
            <form onSubmit={addSub} className="task-inline-form">
              <input
                className="form-control form-control-sm"
                placeholder="Subtask title"
                aria-label={`New subtask of ${node.title}`}
                maxLength={MAX_TITLE}
                value={subTitle}
                autoFocus
                onChange={(e) => setSubTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setAddingUnder(null);
                  }
                }}
                onBlur={() => { if (!subTitle.trim()) setAddingUnder(null); }}
              />
            </form>
          </li>
        )}
      </React.Fragment>
    );
  }

  const emptyText = !tasks.length
    ? (canEdit ? 'No tasks yet. Add the first one above.' : 'No tasks yet.')
    : filter === 'mine' ? 'Nothing open is assigned to you.' : 'Everything here is done.';

  return (
    <div className={`task-board-page${selected ? ' detail-open' : ''}`}>
      <div className="task-board" aria-label={`Tasks in ${channel.name}`}>
        <div className="task-toolbar">
          <div className="task-filters" role="tablist" aria-label="Show">
            {FILTERS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={filter === key}
                className={`task-filter${filter === key ? ' active' : ''}`}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
          {tasks.length > 0 && <span className="task-summary">{doneCount} of {tasks.length} done</span>}
        </div>
        {canEdit && (
          <form className="task-add" onSubmit={addTop}>
            <FontAwesomeIcon icon={faPlus} className="task-add-icon" />
            <input
              className="form-control"
              placeholder="Add a task"
              aria-label="New task title"
              maxLength={MAX_TITLE}
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
            />
          </form>
        )}
        {error && <p className="error-msg task-error" role="alert">{error}</p>}
        <div className="task-board-scroll">
          {!loaded ? (
            board.error ? <p className="guild-placeholder">{errorMessage(board.error)}</p> : <p className="guild-placeholder">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="guild-placeholder task-empty">{emptyText}</p>
          ) : (
            <ul className={`task-list${dragId ? ' dragging-active' : ''}${drop?.zone === 'end' ? ' drop-end' : ''}`} ref={listRef}>
              {rows.map(renderRow)}
            </ul>
          )}
          {canEdit && loaded && rows.length > 0 && !isMobile && (
            <p className="task-hint">Drag tasks to reorder them; drop one onto another to make it a subtask.</p>
          )}
        </div>
      </div>
      {selected && (
        <TaskDetail
          key={selected.id}
          guild={guild}
          channel={channel}
          task={selected}
          tree={tree}
          board={board}
          user={user}
          people={people}
          canEdit={canEdit}
          canComment={canComment}
          canModerate={canModerate}
          reactionNames={reactionNames}
          mentionRoles={mentionRoles}
          nameColors={nameColors}
          isMobile={isMobile}
          nameFor={nameFor}
          onSelect={select}
          onClose={() => select(null)}
        />
      )}
    </div>
  );
}
