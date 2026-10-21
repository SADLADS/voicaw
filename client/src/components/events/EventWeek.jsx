import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import EventEmoji from './EventEmoji';
import { addDays, dayKey, isPastDay, openItem, startAtHour, weekAllDay, weekBlocks, weekDays } from '../../utils/eventCalendar';
import { eventColor, eventPlace } from '../../utils/eventDisplay';
import { formatDayMonth, formatLongDate, formatTime, formatWeekday, useDateFormat } from '../../utils/dateFormat';
import { t } from '../../i18n';

// One hour's height on the week (px; the CSS's --event-week-hour matches it).
const HOUR_PX = 44;
// Where the hours open scrolled to, unless an event of the week is earlier.
const FIRST_HOUR = 8;
// The width kept clear right of the blocks in every day (px).
const FREE_STRIP_PX = 8;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

const colorStyle = (event) => {
  const color = eventColor(event);
  return color ? { '--event-color': color } : {};
};

const isLive = (item) => item.event.status === 'active';

// The minute of the day now, kept up to date (the line across today).
function useMinuteNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

// The Week tab of Events (as Guilded's calendar had): the week of the chosen day, Monday first,
// all-day events along the top and the others as blocks on their hours (side by side where they
// overlap, split at midnight), and greyed what took place (`history`, loaded with
// `loadHistory(from, to)` for the week shown). `onCreate(startSeconds)`, when you may make
// events, makes one on an hour still to come (a click on it).
export default function EventWeek({ guild, events, history = [], loadHistory, day, onDay, onOpenEvent, onCreate }) {
  useDateFormat();
  const now = useMinuteNow();
  const days = useMemo(() => weekDays(day), [day]);
  const blocks = useMemo(() => weekBlocks(events, days, history), [events, days, history]);
  const allDay = useMemo(() => weekAllDay(events, days, history), [events, days, history]);
  useEffect(() => {
    loadHistory?.(Math.floor(days[0].getTime() / 1000), Math.floor(days[6].getTime() / 1000) + 2 * 86400);
  }, [days, loadHistory]);
  const today = dayKey(new Date(now));
  const hasAllDay = days.some((date) => allDay.get(dayKey(date))?.length);
  const scroller = useRef(null);
  const weekKey = dayKey(days[0]);

  // Open on the morning, or earlier for an event before it, once per week shown.
  useEffect(() => {
    const earliest = Math.min(FIRST_HOUR * 60, ...[...blocks.values()].flat().map((block) => block.top));
    if (scroller.current) scroller.current.scrollTop = Math.max(0, Math.floor(earliest / 60) * HOUR_PX - 8);
    // Only when the week changes, not every time an event does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekKey]);

  const range = `${formatDayMonth(days[0])} – ${formatLongDate(days[6])}`;
  const nowDate = new Date(now);
  const nowMinute = nowDate.getHours() * 60 + nowDate.getMinutes();

  function createAt(key, e) {
    if (!onCreate) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const hour = Math.min(23, Math.max(0, Math.floor((e.clientY - rect.top) / HOUR_PX)));
    const start = startAtHour(key, hour);
    if (start == null) return;
    onDay(key);
    onCreate(start);
  }

  return (
    <div className="event-week">
      <div className="event-calendar-toolbar">
        <h4 className="event-calendar-month" aria-live="polite">{range}</h4>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onDay(dayKey(new Date()))}>
          {t('events.calendar.today')}
        </button>
        <button type="button" className="event-calendar-nav" aria-label={t('events.week.previous')} title={t('events.week.previous')} onClick={() => onDay(addDays(day, -7))}>
          <Icon icon={faChevronLeft} />
        </button>
        <button type="button" className="event-calendar-nav" aria-label={t('events.week.next')} title={t('events.week.next')} onClick={() => onDay(addDays(day, 7))}>
          <Icon icon={faChevronRight} />
        </button>
      </div>

      <div className="event-week-grid" role="grid" aria-label={range}>
        <div className="event-week-head" role="row">
          <span className="event-week-gutter" />
          {days.map((date) => {
            const key = dayKey(date);
            return (
              <button
                key={key}
                type="button"
                role="columnheader"
                className={['event-week-day', key === today && 'today', key === day && 'selected', isPastDay(key, now) && 'past'].filter(Boolean).join(' ')}
                aria-current={key === today ? 'date' : undefined}
                aria-label={`${formatWeekday(date)} ${formatLongDate(date)}`}
                onClick={() => onDay(key)}
              >
                <span className="event-week-weekday">{formatWeekday(date, { short: true })}</span>
                <span className="event-week-date">{date.getDate()}</span>
              </button>
            );
          })}
        </div>

        {hasAllDay && (
          <div className="event-week-all-day" role="row">
            <span className="event-week-gutter">{t('events.calendar.allDay')}</span>
            {days.map((date) => (
              <div key={dayKey(date)} className="event-week-all-day-cell" role="gridcell">
                {(allDay.get(dayKey(date)) ?? []).map((item) => (
                  <button
                    key={`${item.event.id}-${item.start}`}
                    type="button"
                    className={['event-calendar-chip', 'all-day', item.event.color != null && 'coloured', isLive(item) && 'live', item.past && 'past'].filter(Boolean).join(' ')}
                    style={colorStyle(item.event)}
                    title={`${item.event.name} (${t('events.calendar.allDay')})`}
                    onClick={() => openItem(onOpenEvent, item)}
                  >
                    <EventEmoji emoji={item.event.emoji} />
                    <span className="event-calendar-chip-name">{item.event.name}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}

        <div className="event-week-scroll" ref={scroller}>
          <div className="event-week-body" style={{ '--event-week-hour': `${HOUR_PX}px` }}>
            <div className="event-week-gutter event-week-hours" aria-hidden="true">
              {HOURS.map((hour) => (
                <span key={hour} className="event-week-hour-label">
                  {hour > 0 && formatTime(new Date(2000, 0, 1, hour))}
                </span>
              ))}
            </div>
            {days.map((date) => {
              const key = dayKey(date);
              return (
                <div
                  key={key}
                  role="gridcell"
                  className={['event-week-column', key === today && 'today', onCreate && !isPastDay(key, now) && 'can-create'].filter(Boolean).join(' ')}
                  title={onCreate && !isPastDay(key, now) ? t('events.calendar.createOn', { date: formatLongDate(date) }) : undefined}
                  onClick={(e) => createAt(key, e)}
                >
                  {(blocks.get(key) ?? []).map((block) => {
                    const place = eventPlace(block.event, guild);
                    const when = `${formatTime(block.start * 1000)}${block.end != null ? ` – ${formatTime(block.end * 1000)}` : ''}`;
                    const short = block.bottom - block.top < 45;
                    return (
                      <button
                        key={`${block.event.id}-${block.start}`}
                        type="button"
                        className={['event-week-block', isLive(block) && 'live', block.past && 'past', block.event.color != null && 'coloured', short && 'short'].filter(Boolean).join(' ')}
                        style={{
                          ...colorStyle(block.event),
                          top: `${(block.top / 60) * HOUR_PX}px`,
                          height: `${((block.bottom - block.top) / 60) * HOUR_PX - 2}px`,
                          // A strip on the right stays free, for making another event at those hours.
                          left: `calc((100% - ${FREE_STRIP_PX}px) * ${block.lane / block.lanes} + 1px)`,
                          width: `calc((100% - ${FREE_STRIP_PX}px) / ${block.lanes} - 2px)`,
                        }}
                        title={[when, block.event.name, place.label].filter(Boolean).join('\n')}
                        onClick={(e) => { e.stopPropagation(); onDay(key); openItem(onOpenEvent, block); }}
                      >
                        <span className="event-week-block-name"><EventEmoji emoji={block.event.emoji} />{block.event.name}</span>
                        {!short && <span className="event-week-block-time">{when}</span>}
                      </button>
                    );
                  })}
                  {key === today && (
                    <span className="event-week-now" style={{ top: `${(nowMinute / 60) * HOUR_PX}px` }} aria-hidden="true" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
