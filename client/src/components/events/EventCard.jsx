import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCalendarDays, faLocationDot, faRepeat, faUserGroup, faVolumeHigh } from '@fortawesome/free-solid-svg-icons';
import DocumentCover from '../documents/DocumentCover';
import { eventPlace, eventStatusText } from '../../utils/eventDisplay';
import { describeRepeat } from '../../utils/eventRecurrence';
import { formatEventTime, useDateFormat } from '../../utils/dateFormat';
import { t } from '../../i18n';

// A scheduled event as a card (the events list, the editor's preview, a link's embed): its
// cover, when (and "in 2 hours", "happening now"), its name (opens it, with `onOpen`), how it
// repeats, where, and how many are interested; `children` are its buttons.
export default function EventCard({ event, guild, onOpen = null, children = null, className = '' }) {
  useDateFormat();
  const place = eventPlace(event, guild);
  const status = eventStatusText(event);
  const start = new Date(event.start_time * 1000);
  return (
    <article className={`event-card${event.status === 'active' ? ' live' : ''} ${className}`} aria-label={event.name}>
      {event.image && <DocumentCover cover={event.image} className="event-card-cover" />}
      <div className="event-card-body">
        <div className="event-card-when">
          <FontAwesomeIcon icon={faCalendarDays} aria-hidden="true" />
          <span>{formatEventTime(start)}</span>
          {status && <span className={`event-card-status${event.status === 'active' ? ' live' : ''}`}>{status}</span>}
        </div>
        {onOpen ? (
          <button type="button" className="event-card-name" onClick={onOpen}>{event.name}</button>
        ) : (
          <div className="event-card-name">{event.name}</div>
        )}
        {event.recurrence && (
          <div className="event-card-line">
            <FontAwesomeIcon icon={faRepeat} aria-hidden="true" />
            <span>{describeRepeat(event.recurrence, start)}</span>
          </div>
        )}
        {place.label && (
          <div className="event-card-line">
            <FontAwesomeIcon icon={place.voice ? faVolumeHigh : faLocationDot} aria-hidden="true" />
            <span>{place.label}</span>
          </div>
        )}
        <div className="event-card-footer">
          <span className="event-card-count">
            <FontAwesomeIcon icon={faUserGroup} aria-hidden="true" /> {t('events.interestedCount', { count: event.user_count })}
          </span>
          {children && <span className="event-card-buttons">{children}</span>}
        </div>
      </div>
    </article>
  );
}
