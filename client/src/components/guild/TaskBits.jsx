import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCalendar, faCheck } from '@fortawesome/free-solid-svg-icons';
import { formatDate, useDateFormat } from '../../utils/dateFormat';
import { dueDateValue, dueStatus } from '../../utils/taskTree';
import { t } from '../../i18n';

// Small pieces of a task drawn on the board (ListChannelView) and in its details (TaskDetail).

// Due date chip: red when overdue, yellow today or in the next two days.
export function DueChip({ task }) {
  useDateFormat();
  if (!task.due_date) return null;
  const status = dueStatus(task.due_date, { completed: Boolean(task.completed_at) });
  const date = formatDate(dueDateValue(task.due_date));
  const title = status === 'overdue' ? t('guilds.tasks.due.overdueOn', { date })
    : status === 'today' ? t('guilds.tasks.due.todayOn', { date }) : t('guilds.tasks.due.dueOn', { date });
  return (
    <span className={`task-due${status ? ` ${status}` : ''}`} title={title}>
      <FontAwesomeIcon icon={faCalendar} />
      {status === 'today' ? t('guilds.tasks.due.today') : date}
    </span>
  );
}

// Beside a date field: how urgent it is ("Overdue", "Due today", "Due soon"), else nothing.
export function DueStatus({ task }) {
  const status = dueStatus(task.due_date, { completed: Boolean(task.completed_at) });
  if (!status) return null;
  const text = { overdue: t('guilds.tasks.due.overdue'), today: t('guilds.tasks.due.dueToday'), soon: t('guilds.tasks.due.soon') }[status];
  return <span className={`task-due-status ${status}`}>{text}</span>;
}

// The round checkbox in front of a task.
export function TaskCheck({ task, disabled, onToggle }) {
  const done = Boolean(task.completed_at);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={done ? t('guilds.tasks.markNotDone', { title: task.title }) : t('guilds.tasks.markDone', { title: task.title })}
      className={`task-check${done ? ' done' : ''}`}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {done && <FontAwesomeIcon icon={faCheck} />}
    </button>
  );
}
