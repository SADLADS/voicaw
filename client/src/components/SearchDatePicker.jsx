import React from 'react';
import { Icon } from './Icon';
import { faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { dayKey, monthGrid, monthKey } from '../utils/eventCalendar';
import { formatLongDate, formatMonthYear, formatWeekday, useDateFormat } from '../utils/dateFormat';
import { t } from '../i18n';

// The calendar before: and after: open under the search box (MessageSearch): a month, Monday
// first (as the events calendar), `day` (a Date: the typed date, or where the arrow keys or
// the month buttons moved to) marked and today outlined. `onMove(date)` shows another day,
// `onPick(date)` writes one into the box. Every button cancels its mousedown, so the focus
// (and typing) stays in the search box.
export default function SearchDatePicker({ title, day, onMove, onPick }) {
  useDateFormat();
  const month = monthKey(day);
  const days = monthGrid(month);
  const today = dayKey(new Date());
  const chosen = dayKey(day);
  const keepFocus = (e) => e.preventDefault();
  // The same day of another month (or its last, if shorter).
  const moveMonth = (by) => {
    const last = new Date(day.getFullYear(), day.getMonth() + by + 1, 0).getDate();
    onMove(new Date(day.getFullYear(), day.getMonth() + by, Math.min(day.getDate(), last)));
  };

  return (
    <div className="search-date-picker">
      <div className="search-date-picker-header">
        <span className="emoji-suggestions-title">{title}</span>
        <button type="button" className="icon-button" aria-label={t('events.calendar.previous')} onMouseDown={keepFocus} onClick={() => moveMonth(-1)}>
          <Icon icon={faChevronLeft} />
        </button>
        <strong>{formatMonthYear(day)}</strong>
        <button type="button" className="icon-button" aria-label={t('events.calendar.next')} onMouseDown={keepFocus} onClick={() => moveMonth(1)}>
          <Icon icon={faChevronRight} />
        </button>
      </div>
      <div className="search-date-picker-grid" role="grid" aria-label={formatMonthYear(day)}>
        {days.slice(0, 7).map((date) => (
          <span key={`w${date.getDay()}`} role="columnheader" className="search-date-picker-weekday" title={formatWeekday(date)}>
            {formatWeekday(date, { short: true })}
          </span>
        ))}
        {days.map((date) => {
          const key = dayKey(date);
          const classes = ['search-date-picker-day'];
          if (monthKey(date) !== month) classes.push('other-month');
          if (key === today) classes.push('today');
          if (key === chosen) classes.push('chosen');
          return (
            <button
              key={key}
              type="button"
              role="gridcell"
              className={classes.join(' ')}
              aria-label={formatLongDate(date)}
              aria-selected={key === chosen}
              onMouseDown={(e) => { e.preventDefault(); onPick(date); }}
            >
              {date.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
