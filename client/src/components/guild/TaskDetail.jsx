import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { faChevronLeft, faPen, faPlus, faTrash, faXmark } from '@fortawesome/free-solid-svg-icons';
import Avatar from '../Avatar';
import ConfirmDialog from './ConfirmDialog';
import { MessageContent } from '../MessageList';
import { DueChip, DueStatus, TaskCheck } from './TaskBits';
import { ConfigContext } from '../../contexts';
import { onGuildEvent } from '../../utils/ws-client';
import { addTaskComment, deleteTaskComment, editTaskComment, fetchTaskComments } from '../../services/guildService';
import { errorMessage } from '../../utils/guildDisplay';
import { displayName, nameOf, useProfiles } from '../../utils/profiles';
import { formatDate, formatDateTime, useDateFormat } from '../../utils/dateFormat';
import { t } from '../../i18n';
import {
  MAX_ASSIGNEES, MAX_COMMENT, MAX_DEPTH, MAX_DESCRIPTION, MAX_TITLE, depthOf, progressOf,
} from '../../utils/taskTree';

// Plain text drawn like a message (markdown, mentions, emoji).
function RichText({ text, user, reactionNames, mentionRoles, myRoleIds }) {
  const { s3Endpoint } = useContext(ConfigContext);
  const msg = useMemo(() => ({ plaintext: text, reactions: [] }), [text]);
  return (
    <MessageContent
      msg={msg}
      user={user}
      s3Endpoint={s3Endpoint}
      reactionNames={reactionNames}
      mentionRoles={mentionRoles}
      myRoleIds={myRoleIds}
    />
  );
}

// The comments on a task: oldest first, kept current by the websocket. Authors edit and
// delete theirs; Manage Messages deletes anyone's.
function TaskComments({ task, user, canComment, canModerate, nameColors, richProps }) {
  useDateFormat();
  const [comments, setComments] = useState(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(null); // { id, text }
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetchTaskComments(task.id)
      .then((list) => { if (!cancelled) setComments(list); })
      .catch((err) => { if (!cancelled) setError(errorMessage(err)); });
    const off = onGuildEvent((event) => {
      if (event.taskId !== task.id) return;
      if (event.type === 'guild_task_comment_new') {
        setComments((list) => (list && !list.some((c) => c.id === event.comment.id) ? [...list, event.comment] : list));
      } else if (event.type === 'guild_task_comment_edit') {
        setComments((list) => list?.map((c) => (c.id === event.comment.id ? event.comment : c)));
      } else if (event.type === 'guild_task_comment_delete') {
        setComments((list) => list?.filter((c) => c.id !== event.commentId));
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [task.id]);

  async function send(e) {
    e?.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    setBusy(true);
    setError(null);
    try {
      const comment = await addTaskComment(task.id, content);
      setComments((list) => (list?.some((c) => c.id === comment.id) ? list : [...(list ?? []), comment]));
      setDraft('');
      requestAnimationFrame(() => endRef.current?.scrollIntoView?.({ block: 'nearest' }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    const content = editing.text.trim();
    if (!content) return;
    try {
      const comment = await editTaskComment(editing.id, content);
      setComments((list) => list.map((c) => (c.id === comment.id ? comment : c)));
      setEditing(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remove(comment) {
    try {
      await deleteTaskComment(comment.id);
      setComments((list) => list.filter((c) => c.id !== comment.id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section className="task-section task-comments" aria-label={t('guilds.tasks.comments.title')}>
      <h6 className="task-section-title">{comments?.length ? t('guilds.tasks.comments.titleWithCount', { number: comments.length }) : t('guilds.tasks.comments.title')}</h6>
      {comments === null ? (
        !error && <p className="vc-hint">{t('common.loading')}</p>
      ) : comments.length === 0 ? (
        <p className="vc-hint">{t('guilds.tasks.comments.none')}</p>
      ) : (
        <ul className="task-comment-list">
          {comments.map((c) => {
            const mine = c.sender_id === user.id;
            const color = nameColors?.[c.sender_id];
            return (
              <li key={c.id} className="task-comment">
                <Avatar userId={c.sender_id} className="task-comment-avatar" />
                <div className="task-comment-body">
                  <div className="task-comment-head">
                    <span className="task-comment-name" style={color ? { color } : undefined}>
                      {displayName(c.sender_id, c.sender_display_name || c.sender_username || t('guilds.tasks.deletedUser'))}
                    </span>
                    <span className="task-comment-time">{formatDateTime(c.timestamp * 1000)}</span>
                    {c.edited_at && <span className="task-comment-time">{t('guilds.tasks.comments.edited')}</span>}
                    <span className="task-comment-actions">
                      {mine && editing?.id !== c.id && (
                        <button type="button" aria-label={t('guilds.tasks.comments.edit')} title={t('common.edit')} onClick={() => setEditing({ id: c.id, text: c.content })}>
                          <Icon icon={faPen} />
                        </button>
                      )}
                      {(mine || canModerate) && (
                        <button type="button" aria-label={t('guilds.tasks.comments.delete')} title={t('common.delete')} onClick={() => remove(c)}>
                          <Icon icon={faTrash} />
                        </button>
                      )}
                    </span>
                  </div>
                  {editing?.id === c.id ? (
                    <div className="task-comment-edit">
                      <textarea
                        className="form-control form-control-sm"
                        aria-label={t('guilds.tasks.comments.edit')}
                        maxLength={MAX_COMMENT}
                        value={editing.text}
                        autoFocus
                        onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            saveEdit();
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            e.stopPropagation();
                            setEditing(null);
                          }
                        }}
                      />
                      <div className="task-buttons">
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
                        <button type="button" className="btn btn-primary btn-sm vc-button" onClick={saveEdit}>{t('common.save')}</button>
                      </div>
                    </div>
                  ) : (
                    <RichText text={c.content} {...richProps} />
                  )}
                </div>
              </li>
            );
          })}
          <li ref={endRef} aria-hidden="true" />
        </ul>
      )}
      {canComment ? (
        <form className="task-comment-form" onSubmit={send}>
          <textarea
            className="form-control"
            placeholder={t('guilds.tasks.comments.write')}
            aria-label={t('guilds.tasks.comments.write')}
            rows={2}
            maxLength={MAX_COMMENT}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button type="submit" className="btn btn-primary btn-sm vc-button" disabled={busy || !draft.trim()}>{t('guilds.tasks.comments.send')}</button>
        </form>
      ) : (
        <p className="vc-hint">{t('guilds.tasks.comments.noPermission')}</p>
      )}
      {error && <p className="error-msg" role="alert">{error}</p>}
    </section>
  );
}

// Picking who a task is assigned to: anyone who can see the board, searchable.
function AssigneePicker({ people, assigned, onChange, onClose }) {
  useProfiles();
  const [query, setQuery] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);
  const q = query.trim().toLowerCase();
  const matches = people
    .filter((p) => !q || nameOf(p).toLowerCase().includes(q) || p.username.toLowerCase().includes(q))
    .slice(0, 50);
  const full = assigned.length >= MAX_ASSIGNEES;
  return (
    <div className="task-assignee-picker" ref={ref} role="dialog" aria-label={t('guilds.tasks.assign.title')}>
      <input
        className="form-control form-control-sm"
        placeholder={t('guilds.tasks.assign.search')}
        aria-label={t('guilds.tasks.assign.search')}
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul>
        {matches.map((p) => {
          const on = assigned.includes(p.id);
          return (
            <li key={p.id}>
              <label className={`task-assignee-option${on ? ' on' : ''}`}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!on && full}
                  onChange={() => onChange(on ? assigned.filter((id) => id !== p.id) : [...assigned, p.id])}
                />
                <Avatar userId={p.id} className="task-assignee-avatar" />
                <span>{nameOf(p)}</span>
                <span className="vc-hint">@{p.username}</span>
              </label>
            </li>
          );
        })}
        {!matches.length && <li className="vc-hint">{t('guilds.tasks.assign.nobodyFound')}</li>}
      </ul>
      {full && <p className="vc-hint">{t('guilds.tasks.assign.atMost', { count: MAX_ASSIGNEES })}</p>}
    </div>
  );
}

// A task's details, beside the board (a full-screen panel on a phone): completion, title,
// assignees, due date, description, subtasks and comments. Changes save as they're made.
export default function TaskDetail({
  guild, channel, task, tree, board, user, people, canEdit, canComment, canModerate,
  reactionNames, mentionRoles, nameColors, isMobile, nameFor, onSelect, onClose,
}) {
  useProfiles();
  useDateFormat();
  const { editTask, addTask, removeTask } = board;
  const [title, setTitle] = useState(task.title);
  const [editingDescription, setEditingDescription] = useState(false);
  const [description, setDescription] = useState(task.description ?? '');
  const [picking, setPicking] = useState(false);
  const [subTitle, setSubTitle] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState(null);

  // Someone else's change arrives: show it (unless it's being edited here).
  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => {
    if (!editingDescription) setDescription(task.description ?? '');
  }, [task.description, editingDescription]);

  // Escape closes the panel (when nothing inside it handled it first).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('.vc-dialog-backdrop')) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function save(changes) {
    setError(null);
    try {
      await editTask(task.id, changes);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
  }

  function saveTitle() {
    const next = title.replace(/\s+/g, ' ').trim();
    if (!next) {
      setTitle(task.title);
      return;
    }
    if (next !== task.title) save({ title: next });
  }

  async function saveDescription() {
    if (await save({ description: description.trim() ? description : null })) setEditingDescription(false);
  }

  async function addSub(e) {
    e.preventDefault();
    const text = subTitle.trim();
    if (!text) return;
    setError(null);
    try {
      await addTask({ title: text, parentId: task.id });
      setSubTitle('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const richProps = { user, reactionNames, mentionRoles, myRoleIds: guild.my_role_ids };
  const parent = task.parent_id ? tree.byId.get(task.parent_id) : null;
  const progress = progressOf(task);
  const assignees = task.assignees ?? [];
  const canNest = depthOf(tree.byId, task.id) < MAX_DEPTH;
  // Who can be assigned: those who can see the board.
  const peopleIds = new Set(people.map((p) => p.id));

  return (
    <aside className="task-detail" aria-label={t('guilds.tasks.detail.label', { title: task.title })}>
      <header className="task-detail-header">
        <button type="button" className="task-detail-back" aria-label={t('guilds.tasks.detail.close')} title={t('common.close')} onClick={onClose}>
          <Icon icon={isMobile ? faChevronLeft : faXmark} />
        </button>
        {parent ? (
          <button type="button" className="task-breadcrumb" onClick={() => onSelect(parent.id)} title={t('guilds.tasks.detail.openParent')}>
            {t('guilds.tasks.detail.parent', { title: parent.title })}
          </button>
        ) : (
          <span className="task-breadcrumb static">#{channel.name}</span>
        )}
        {canEdit && (
          <button type="button" className="task-detail-delete" aria-label={t('guilds.tasks.detail.delete')} title={t('guilds.tasks.detail.delete')} onClick={() => setConfirmDelete(true)}>
            <Icon icon={faTrash} />
          </button>
        )}
      </header>

      <div className="task-detail-scroll">
        <div className="task-detail-title-row">
          <TaskCheck task={task} disabled={!canEdit} onToggle={() => save({ completed: !task.completed_at })} />
          {canEdit ? (
            <textarea
              className="task-detail-title"
              aria-label={t('guilds.tasks.detail.title')}
              rows={1}
              maxLength={MAX_TITLE}
              value={title}
              onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.currentTarget.blur();
                } else if (e.key === 'Escape') {
                  setTitle(task.title);
                }
              }}
            />
          ) : (
            <h5 className="task-detail-title static">{task.title}</h5>
          )}
        </div>
        {task.completed_at && (
          <p className="vc-hint task-completed-note">
            {task.completed_by
              ? t('guilds.tasks.detail.completedBy', { name: nameFor(task.completed_by), date: formatDate(task.completed_at * 1000) })
              : t('guilds.tasks.detail.completed', { date: formatDate(task.completed_at * 1000) })}
          </p>
        )}

        <dl className="task-fields">
          <dt>{t('guilds.tasks.detail.assignees')}</dt>
          <dd className="task-assignee-field">
            {assignees.map((id) => (
              <span key={id} className={`task-assignee-chip${peopleIds.has(id) ? '' : ' gone'}`}>
                <Avatar userId={id} className="task-assignee-avatar" />
                {nameFor(id)}
                {canEdit && (
                  <button
                    type="button"
                    aria-label={t('guilds.tasks.detail.unassign', { name: nameFor(id) })}
                    onClick={() => save({ assigneeIds: assignees.filter((a) => a !== id) })}
                  >
                    <Icon icon={faXmark} />
                  </button>
                )}
              </span>
            ))}
            {!assignees.length && !canEdit && <span className="vc-hint">{t('guilds.tasks.detail.nobody')}</span>}
            {canEdit && (
              <span className="task-assign-buttons">
                {!assignees.includes(user.id) && peopleIds.has(user.id) && assignees.length < MAX_ASSIGNEES && (
                  <button type="button" className="task-link-button" onClick={() => save({ assigneeIds: [...assignees, user.id] })}>
                    {t('guilds.tasks.detail.assignMe')}
                  </button>
                )}
                <button type="button" className="task-link-button" aria-expanded={picking} onClick={() => setPicking((p) => !p)}>
                  <Icon icon={faPlus} /> {t('guilds.tasks.detail.assign')}
                </button>
                {picking && (
                  <AssigneePicker
                    people={people}
                    assigned={assignees.filter((id) => peopleIds.has(id))}
                    onChange={(ids) => save({ assigneeIds: ids })}
                    onClose={() => setPicking(false)}
                  />
                )}
              </span>
            )}
          </dd>

          <dt>{t('guilds.tasks.detail.dueDate')}</dt>
          <dd className="task-due-field">
            {canEdit ? (
              <>
                <input
                  type="date"
                  className="form-control form-control-sm"
                  aria-label={t('guilds.tasks.detail.dueDate')}
                  value={task.due_date ?? ''}
                  onChange={(e) => save({ dueDate: e.target.value || null })}
                />
                {task.due_date && (
                  <button type="button" className="task-link-button" onClick={() => save({ dueDate: null })}>{t('guilds.tasks.detail.clear')}</button>
                )}
              </>
            ) : null}
            {canEdit ? <DueStatus task={task} /> : task.due_date ? <DueChip task={task} /> : <span className="vc-hint">{t('guilds.tasks.detail.none')}</span>}
          </dd>
        </dl>

        <section className="task-section" aria-label={t('guilds.tasks.detail.description')}>
          <h6 className="task-section-title">
            {t('guilds.tasks.detail.description')}
            {canEdit && !editingDescription && (
              <button type="button" className="task-link-button" onClick={() => setEditingDescription(true)}>
                {task.description ? t('common.edit') : t('common.add')}
              </button>
            )}
          </h6>
          {editingDescription ? (
            <div className="task-description-edit">
              <textarea
                className="form-control"
                aria-label={t('guilds.tasks.detail.description')}
                rows={5}
                maxLength={MAX_DESCRIPTION}
                value={description}
                autoFocus
                placeholder={t('guilds.tasks.detail.descriptionPlaceholder')}
                onChange={(e) => setDescription(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setDescription(task.description ?? '');
                    setEditingDescription(false);
                  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    saveDescription();
                  }
                }}
              />
              <div className="task-buttons">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    setDescription(task.description ?? '');
                    setEditingDescription(false);
                  }}
                >
                  {t('common.cancel')}
                </button>
                <button type="button" className="btn btn-primary btn-sm vc-button" onClick={saveDescription}>{t('common.save')}</button>
              </div>
            </div>
          ) : task.description ? (
            <div className="task-description"><RichText text={task.description} {...richProps} /></div>
          ) : (
            <p className="vc-hint">{t('guilds.tasks.detail.noDescription')}</p>
          )}
        </section>

        <section className="task-section" aria-label={t('guilds.tasks.detail.subtasks')}>
          <h6 className="task-section-title">
            {progress.total ? t('guilds.tasks.detail.subtasksProgress', { done: progress.done, total: progress.total }) : t('guilds.tasks.detail.subtasks')}
          </h6>
          {task.children.length > 0 && (
            <ul className="task-subtask-list">
              {task.children.map((child) => (
                <li key={child.id} className={child.completed_at ? 'done' : ''}>
                  <TaskCheck task={child} disabled={!canEdit} onToggle={() => editTask(child.id, { completed: !child.completed_at }).catch((err) => setError(errorMessage(err)))} />
                  <button type="button" className="task-subtask-title" onClick={() => onSelect(child.id)}>{child.title}</button>
                  <DueChip task={child} />
                </li>
              ))}
            </ul>
          )}
          {canEdit && canNest && (
            <form className="task-inline-form" onSubmit={addSub}>
              <input
                className="form-control form-control-sm"
                placeholder={t('guilds.tasks.detail.addSubtask')}
                aria-label={t('guilds.tasks.detail.newSubtaskTitle')}
                maxLength={MAX_TITLE}
                value={subTitle}
                onChange={(e) => setSubTitle(e.target.value)}
              />
            </form>
          )}
          {!task.children.length && !(canEdit && canNest) && <p className="vc-hint">{t('guilds.tasks.detail.noneDot')}</p>}
        </section>

        {error && <p className="error-msg" role="alert">{error}</p>}

        <TaskComments
          task={task}
          user={user}
          canComment={canComment}
          canModerate={canModerate}
          nameColors={nameColors}
          richProps={richProps}
        />

        <p className="vc-hint task-created-note">
          {t('guilds.tasks.detail.addedBy', { name: nameFor(task.created_by), date: formatDateTime(task.created_at * 1000) })}
        </p>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title={t('guilds.tasks.detail.delete')}
          message={progress.total
            ? t('guilds.tasks.detail.deleteWithSubtasks', { title: task.title, count: progress.total })
            : t('guilds.tasks.detail.deleteMessage', { title: task.title })}
          confirmLabel={t('common.delete')}
          focusConfirm
          onConfirm={async () => {
            await removeTask(task.id);
            onClose();
          }}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </aside>
  );
}
