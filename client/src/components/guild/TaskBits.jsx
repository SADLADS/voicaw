import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCalendar, faCheck } from '@fortawesome/free-solid-svg-icons';
import { formatDate, useDateFormat } from '../../utils/dateFormat';
import { dueDateValue, dueStatus } from '../../utils/taskTree';

// Small pieces of a task drawn on the board (ListChannelView) and in its details (TaskDetail).

// Due date chip: red when overdue, yellow today or in the next two days.
export function DueChip({ task }) {
  useDateFormat();
  if (!task.due_date) return null;
  const status = dueStatus(task.due_date, { completed: Boolean(task.completed_at) });
  const label = status === 'overdue' ? 'Overdue' : status === 'today' ? 'Due today' : 'Due';
  return (
    <span className={`task-due${status ? ` ${status}` : ''}`} title={`${label}: ${formatDate(dueDateValue(task.due_date))}`}>
      <FontAwesomeIcon icon={faCalendar} />
      {status === 'today' ? 'Today' : formatDate(dueDateValue(task.due_date))}
    </span>
  );
}

// Beside a date field: how urgent it is ("Overdue", "Due today", "Due soon"), else nothing.
export function DueStatus({ task }) {
  const status = dueStatus(task.due_date, { completed: Boolean(task.completed_at) });
  if (!status) return null;
  const text = { overdue: 'Overdue', today: 'Due today', soon: 'Due soon' }[status];
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
      aria-label={done ? `Mark "${task.title}" not done` : `Mark "${task.title}" done`}
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
