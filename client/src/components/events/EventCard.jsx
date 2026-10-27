import React from 'react';
import { Icon } from '../Icon';
import { faCalendarDays, faLocationDot, faRepeat, faUserGroup, faVolumeHigh } from '@fortawesome/free-solid-svg-icons';
import DocumentCover from '../documents/DocumentCover';
import EventEmoji from './EventEmoji';
import { eventPlace, eventStatusText, formatEventWhen, rsvpSummary } from '../../utils/eventDisplay';
import { describeRepeat } from '../../utils/eventRecurrence';
import { useDateFormat } from '../../utils/dateFormat';

// A scheduled event as a card (the events list, the editor's preview, a link's embed): its
// cover, when (and "in 2 hours", "happening now"), its name (opens it, with `onOpen`), how it
// repeats, where, and how many answered (going, maybe, waiting); `children` are its buttons.
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
          <Icon icon={faCalendarDays} aria-hidden="true" />
          <span>{formatEventWhen(event)}</span>
          {status && <span className={`event-card-status${event.status === 'active' ? ' live' : ''}`}>{status}</span>}
        </div>
        {onOpen ? (
          <button type="button" className="event-card-name" onClick={onOpen}><EventEmoji emoji={event.emoji} />{event.name}</button>
        ) : (
          <div className="event-card-name"><EventEmoji emoji={event.emoji} />{event.name}</div>
        )}
        {event.recurrence && (
          <div className="event-card-line">
            <Icon icon={faRepeat} aria-hidden="true" />
            <span>{describeRepeat(event.recurrence, start)}</span>
          </div>
        )}
        {place.label && (
          <div className="event-card-line">
            <Icon icon={place.voice ? faVolumeHigh : faLocationDot} aria-hidden="true" />
            <span>{place.label}</span>
          </div>
        )}
        <div className="event-card-footer">
          <span className="event-card-count">
            <Icon icon={faUserGroup} aria-hidden="true" /> {rsvpSummary(event)}
          </span>
          {children && <span className="event-card-buttons">{children}</span>}
        </div>
      </div>
    </article>
  );
}
