import React, { useContext, useState } from 'react';
import { Icon } from '../Icon';
import { faCalendarCheck, faCircleCheck, faCircleQuestion, faCircleXmark, faHourglassHalf, faXmark } from '@fortawesome/free-solid-svg-icons';
import ContextMenu from '../ContextMenu';
import { InteractionContext } from '../../contexts';
import { RSVPS, formatEventWhen } from '../../utils/eventDisplay';
import { t } from '../../i18n';

const STYLES = { going: 'btn-success', maybe: 'btn-primary', declined: 'btn-secondary declined', waitlisted: 'btn-warning waitlisted' };
const ICONS = { going: faCircleCheck, maybe: faCircleQuestion, declined: faCircleXmark, waitlisted: faHourglassHalf };

// The answers, ticked where `current` is, then taking it back if there is one: menu items, each
// choosing { rsvp, occurrence }.
function answers(current, occurrence, onChoose) {
  return [
    ...RSVPS.map((rsvp) => ({
      key: rsvp,
      label: t(`events.rsvp.${rsvp}`),
      checked: current === rsvp,
      onSelect: () => onChoose({ rsvp, occurrence }),
    })),
    ...(current ? [
      { separator: true },
      { key: 'none', label: t('events.rsvp.clear'), icon: faXmark, onSelect: () => onChoose({ rsvp: null, occurrence }) },
    ] : []),
  ];
}

// RSVP on an event (the occurrence shown: occurrenceView's), labelled with your answer to it
// ("Waitlisted" when you're going past its limit: `waitlisted`). A menu of Going, Maybe, Can't
// go; on a repeating event, for this date or all of them (a submenu each).
// `onChoose({ rsvp, occurrence })` (rsvp null: none; occurrence an original start, or null for
// all of it).
export default function RsvpButton({ event, waitlisted = false, className = '', onChoose }) {
  const { isMobile } = useContext(InteractionContext);
  const [anchor, setAnchor] = useState(null);
  const shown = event.rsvp === 'going' && waitlisted ? 'waitlisted' : event.rsvp ?? null;
  const items = event.recurrence && event.original_start != null
    ? [
      {
        key: 'this',
        label: t('events.rsvp.thisDate', { date: formatEventWhen(event) }),
        submenu: { title: t('events.rsvp.thisDate', { date: formatEventWhen(event) }), items: answers(event.rsvp ?? null, event.original_start, onChoose) },
      },
      {
        key: 'all',
        label: t('events.rsvp.allDates'),
        submenu: { title: t('events.rsvp.allDates'), items: answers(event.rsvp_all ?? null, null, onChoose) },
      },
    ]
    : answers(event.rsvp ?? null, null, onChoose);
  return (
    <>
      <button
        type="button"
        className={`btn btn-sm event-rsvp ${STYLES[shown] ?? 'btn-secondary'} ${className}`}
        aria-haspopup="menu"
        aria-label={shown ? t('events.rsvp.yours', { answer: t(`events.rsvp.${shown}`) }) : t('events.rsvp.button')}
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
      >
        <Icon icon={ICONS[shown] ?? faCalendarCheck} /> {shown ? t(`events.rsvp.${shown}`) : t('events.rsvp.button')}
      </button>
      {anchor && (
        <ContextMenu
          title={event.name}
          label={t('events.rsvp.button')}
          items={items}
          anchor={anchor}
          sheet={isMobile}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}
