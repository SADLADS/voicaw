import React, { useMemo } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft, faChevronRight, faLocationDot, faPlus, faVolumeHigh } from '@fortawesome/free-solid-svg-icons';
import { addMonths, dayKey, eventsByDay, fromKey, isPastDay, monthGrid, monthKey, startOnDay } from '../../utils/eventCalendar';
import { eventPlace } from '../../utils/eventDisplay';
import { formatLongDate, formatMonthYear, formatTime, formatWeekday, useDateFormat } from '../../utils/dateFormat';
import { t } from '../../i18n';

// How many events a day's square lists before "+N more".
const MAX_CHIPS = 3;

// One occurrence in the chosen day's list: time, name, place.
function DayEvent({ item, guild, onOpen }) {
  const place = eventPlace(item.event, guild);
  const live = item.event.status === 'active' && item.start === item.event.start_time;
  return (
    <li>
      <button type="button" className={`event-calendar-day-event${live ? ' live' : ''}`} onClick={onOpen}>
        <span className="event-calendar-day-time">
          {formatTime(item.start * 1000)}
          {item.end != null && ` – ${formatTime(item.end * 1000)}`}
        </span>
        <span className="event-calendar-day-name">{item.event.name}</span>
        {place.label && (
          <span className="event-calendar-day-place">
            <FontAwesomeIcon icon={place.voice ? faVolumeHigh : faLocationDot} aria-hidden="true" /> {place.label}
          </span>
        )}
      </button>
    </li>
  );
}

// The Calendar tab of Events: a month of the guild's events (every occurrence of repeating
// ones), and the chosen day's list beside it (under it on a phone). `onCreate(startSeconds)`,
// when you may make events, makes one on a day: the + on a day still to come, or the day's
// Create Event.
export default function EventCalendar({ guild, events, month, day, onMonth, onDay, onOpenEvent, onCreate }) {
  useDateFormat();
  const days = useMemo(() => monthGrid(month), [month]);
  const byDay = useMemo(() => eventsByDay(events, days), [events, days]);
  const today = dayKey(new Date());
  const shown = fromKey(month);
  const chosen = byDay.get(day) ?? [];
  const canCreateOn = (key) => onCreate && !isPastDay(key);

  function pick(key) {
    onDay(key);
    if (key.slice(0, 7) !== month) onMonth(key.slice(0, 7));
  }

  return (
    <div className="event-calendar">
      <div className="event-calendar-main">
        <div className="event-calendar-toolbar">
          <h4 className="event-calendar-month" aria-live="polite">{formatMonthYear(shown)}</h4>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { onMonth(monthKey(new Date())); onDay(today); }}>
            {t('events.calendar.today')}
          </button>
          <button type="button" className="event-calendar-nav" aria-label={t('events.calendar.previous')} title={t('events.calendar.previous')} onClick={() => onMonth(addMonths(month, -1))}>
            <FontAwesomeIcon icon={faChevronLeft} />
          </button>
          <button type="button" className="event-calendar-nav" aria-label={t('events.calendar.next')} title={t('events.calendar.next')} onClick={() => onMonth(addMonths(month, 1))}>
            <FontAwesomeIcon icon={faChevronRight} />
          </button>
        </div>
        <div className="event-calendar-grid" role="grid" aria-label={formatMonthYear(shown)}>
          <div className="event-calendar-row event-calendar-weekdays" role="row">
            {days.slice(0, 7).map((date) => (
              <span key={date.getDay()} role="columnheader" className="event-calendar-weekday" title={formatWeekday(date)}>
                {formatWeekday(date, { short: true })}
              </span>
            ))}
          </div>
          {[0, 1, 2, 3, 4, 5].map((week) => (
            <div key={week} className="event-calendar-row" role="row">
              {days.slice(week * 7, week * 7 + 7).map((date) => {
                const key = dayKey(date);
                const list = byDay.get(key) ?? [];
                const classes = [
                  'event-calendar-cell',
                  key.slice(0, 7) !== month && 'other-month',
                  key === today && 'today',
                  key === day && 'selected',
                  isPastDay(key) && 'past',
                ].filter(Boolean).join(' ');
                return (
                  <div
                    key={key}
                    role="gridcell"
                    aria-selected={key === day}
                    className={classes}
                    data-day={key}
                    onClick={(e) => { if (!e.defaultPrevented) pick(key); }}
                  >
                    <div className="event-calendar-cell-top">
                      <button
                        type="button"
                        className="event-calendar-date"
                        aria-label={t('events.calendar.dayLabel', { date: `${formatWeekday(date)} ${formatLongDate(date)}`, count: list.length })}
                        aria-current={key === today ? 'date' : undefined}
                        onClick={(e) => { e.preventDefault(); pick(key); }}
                      >
                        {date.getDate()}
                      </button>
                      {canCreateOn(key) && (
                        <button
                          type="button"
                          className="event-calendar-add"
                          aria-label={t('events.calendar.createOn', { date: formatLongDate(date) })}
                          title={t('events.calendar.createOn', { date: formatLongDate(date) })}
                          onClick={(e) => { e.preventDefault(); onDay(key); onCreate(startOnDay(key)); }}
                        >
                          <FontAwesomeIcon icon={faPlus} />
                        </button>
                      )}
                    </div>
                    <div className="event-calendar-chips">
                      {list.slice(0, list.length > MAX_CHIPS ? MAX_CHIPS - 1 : MAX_CHIPS).map((item) => (
                        <button
                          key={`${item.event.id}-${item.start}`}
                          type="button"
                          className={`event-calendar-chip${item.event.status === 'active' && item.start === item.event.start_time ? ' live' : ''}`}
                          title={`${formatTime(item.start * 1000)} ${item.event.name}`}
                          onClick={(e) => { e.preventDefault(); onDay(key); onOpenEvent(item.event.id); }}
                        >
                          <span className="event-calendar-chip-time">{formatTime(item.start * 1000)}</span> {item.event.name}
                        </button>
                      ))}
                      {list.length > MAX_CHIPS && (
                        <span className="event-calendar-more">{t('events.calendar.more', { count: list.length - MAX_CHIPS + 1 })}</span>
                      )}
                    </div>
                    {list.length > 0 && (
                      <span className="event-calendar-dots" aria-hidden="true">
                        {list.slice(0, 3).map((item) => <span key={`${item.event.id}-${item.start}`} className="event-calendar-dot" />)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <section className="event-calendar-day" aria-label={t('events.calendar.dayEvents')}>
        <h5 className="event-calendar-day-title">
          {formatWeekday(fromKey(day))}
          <span>{formatLongDate(fromKey(day))}</span>
        </h5>
        {chosen.length ? (
          <ul className="event-calendar-day-list">
            {chosen.map((item) => (
              <DayEvent key={`${item.event.id}-${item.start}`} item={item} guild={guild} onOpen={() => onOpenEvent(item.event.id)} />
            ))}
          </ul>
        ) : (
          <p className="vc-hint">{t('events.calendar.nothing')}</p>
        )}
        {canCreateOn(day) && (
          <button type="button" className="btn btn-primary btn-sm vc-button event-calendar-create" onClick={() => onCreate(startOnDay(day))}>
            <FontAwesomeIcon icon={faPlus} /> {t('events.dialog.create')}
          </button>
        )}
      </section>
    </div>
  );
}
