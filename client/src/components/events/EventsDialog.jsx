import React, { useContext, useEffect, useMemo, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faBan, faBell, faCalendarXmark, faCheck, faChevronLeft, faEllipsis, faLink, faPen, faPlay, faStop, faClock,
} from '@fortawesome/free-solid-svg-icons';
import '../../assets/css/events.css';
import Modal from '../guild/Modal';
import ConfirmDialog from '../guild/ConfirmDialog';
import ContextMenu from '../ContextMenu';
import Avatar from '../Avatar';
import EventCard from './EventCard';
import EventCalendar from './EventCalendar';
import EventWeek from './EventWeek';
import EventEmoji from './EventEmoji';
import DocumentCover from '../documents/DocumentCover';
import { MessageContent } from '../MessageList';
import { ConfigContext, InteractionContext } from '../../contexts';
import {
  cancelEvent, endEvent, fetchEventUsers, setEventInterest, skipOccurrence, startEvent,
} from '../../services/guildService';
import { canCreateEvents, canManageEvent, eventPlace, eventStatusText, formatEventWhen } from '../../utils/eventDisplay';
import { describeRepeat } from '../../utils/eventRecurrence';
import { errorMessage, eventLink } from '../../utils/guildDisplay';
import { displayName, useProfiles } from '../../utils/profiles';
import { useDateFormat } from '../../utils/dateFormat';
import { t } from '../../i18n';

// The event's description drawn like a message (markdown, mentions, emoji).
function Description({ text, user }) {
  const { s3Endpoint } = useContext(ConfigContext);
  const msg = useMemo(() => ({ plaintext: text, reactions: [] }), [text]);
  return <MessageContent msg={msg} user={user} s3Endpoint={s3Endpoint} />;
}

// Interested (toggle), Start or End for those who may, and the "more" button.
function EventButtons({ event, manages, busy, onInterest, onStart, onEnd, onMore }) {
  return (
    <>
      {manages && event.status === 'scheduled' && (
        <button type="button" className="btn btn-success btn-sm" onClick={onStart} disabled={busy}>
          <FontAwesomeIcon icon={faPlay} /> {t('events.actions.start')}
        </button>
      )}
      {manages && event.status === 'active' && (
        <button type="button" className="btn btn-danger btn-sm" onClick={onEnd} disabled={busy}>
          <FontAwesomeIcon icon={faStop} /> {t('events.actions.end')}
        </button>
      )}
      <button
        type="button"
        className={`btn btn-sm event-interest${event.interested ? ' btn-primary active' : ' btn-secondary'}`}
        aria-pressed={Boolean(event.interested)}
        onClick={onInterest}
      >
        <FontAwesomeIcon icon={event.interested ? faCheck : faBell} /> {t('events.actions.interested')}
      </button>
      <button type="button" className="btn btn-secondary btn-sm event-more" aria-label={t('events.actions.more')} title={t('events.actions.more')} onClick={onMore}>
        <FontAwesomeIcon icon={faEllipsis} />
      </button>
    </>
  );
}

// Who's interested in the event.
function InterestedList({ event }) {
  useProfiles();
  const [ids, setIds] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetchEventUsers(event.id)
      .then((list) => { if (!cancelled) setIds(list); })
      .catch((err) => { if (!cancelled) setError(errorMessage(err)); });
    return () => {
      cancelled = true;
    };
  }, [event.id, event.user_count]);
  if (error) return <p className="error-msg" role="alert">{error}</p>;
  if (!ids) return <p className="vc-hint">{t('events.detail.loading')}</p>;
  if (!ids.length) return <p className="vc-hint">{t('events.detail.nobodyInterested')}</p>;
  return (
    <ul className="event-interested">
      {ids.map((id) => (
        <li key={id}>
          <Avatar userId={id} className="event-interested-avatar" />
          <span>{displayName(id, t('events.unknownUser'))}</span>
        </li>
      ))}
    </ul>
  );
}

// One event in full: cover, when, how it repeats, who made it, where, the description, and
// who's interested (a tab).
function EventDetail({ event, guild, user, buttons }) {
  useDateFormat();
  useProfiles();
  const [tab, setTab] = useState('info');
  const place = eventPlace(event, guild);
  const status = eventStatusText(event);
  const start = new Date(event.start_time * 1000);
  return (
    <div className="event-detail">
      {event.image && <DocumentCover cover={event.image} className="event-detail-cover" />}
      <div className="settings-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'info'} className={`settings-tab${tab === 'info' ? ' active' : ''}`} onClick={() => setTab('info')}>
          {t('events.detail.info')}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'interested'} className={`settings-tab${tab === 'interested' ? ' active' : ''}`} onClick={() => setTab('interested')}>
          {t('events.detail.interestedTab', { count: event.user_count })}
        </button>
      </div>
      {tab === 'info' ? (
        <div className="event-detail-info">
          <div className="event-card-when">
            <span>{formatEventWhen(event, { withEnd: true })}</span>
            {status && <span className={`event-card-status${event.status === 'active' ? ' live' : ''}`}>{status}</span>}
          </div>
          <h4 className="event-detail-name"><EventEmoji emoji={event.emoji} />{event.name}</h4>
          {event.recurrence && <p className="event-detail-line">{describeRepeat(event.recurrence, start)}</p>}
          {place.label && (
            <p className="event-detail-line">
              {place.voice ? t('events.place.inChannel', { name: place.label }) : place.label}
            </p>
          )}
          <p className="event-detail-line event-detail-creator">
            <Avatar userId={event.creator_id} className="event-interested-avatar" />
            {t('events.detail.createdBy', { name: displayName(event.creator_id, t('events.unknownUser')) })}
          </p>
          {event.description && <div className="event-detail-description"><Description text={event.description} user={user} /></div>}
        </div>
      ) : (
        <InterestedList event={event} />
      )}
      <div className="event-detail-buttons">{buttons}</div>
    </div>
  );
}

// The guild's events (Calendar in the channel list), in two tabs of one dialog that keeps its
// size: the month (EventCalendar, first, where it opens), the week (EventWeek) and the list, soonest first; or one event (`eventId`,
// from either, a link or a notification). `view` ({ tab: 'calendar' | 'week' | 'events', month, day; the week is the day's })
// is kept by the caller, so it's still there after the editor, and changed with `onView`.
// `onCreate(start?)` opens the editor (start: unix s, from a calendar day). Interested,
// Start/End and the menu (edit, edit or cancel this occurrence, cancel, copy link) follow your
// permissions (utils/eventDisplay).
export default function EventsDialog({
  guild, user, events, loaded, setInterested, eventId, view, onView, onOpenEvent, onCreate, onEdit, onClose,
}) {
  const { isMobile } = useContext(InteractionContext);
  const [menu, setMenu] = useState(null); // { event, anchor }
  const [confirm, setConfirm] = useState(null); // { kind: 'cancel' | 'skip', event }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const open = eventId != null ? events.find((e) => e.id === eventId) : null;

  useEffect(() => {
    setError(null);
    setCopied(false);
  }, [eventId]);

  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function toggleInterest(event) {
    const next = !event.interested;
    setInterested(event.id, next);
    setEventInterest(event.id, next).catch((err) => {
      setInterested(event.id, !next);
      setError(errorMessage(err));
    });
  }

  function buttonsFor(event) {
    return (
      <EventButtons
        event={event}
        manages={canManageEvent(event, guild, user.id)}
        busy={busy}
        onInterest={() => toggleInterest(event)}
        onStart={() => run(() => startEvent(event.id))}
        onEnd={() => run(() => endEvent(event.id))}
        onMore={(e) => setMenu({ event, anchor: e.currentTarget.getBoundingClientRect() })}
      />
    );
  }

  function menuItems(event) {
    const manages = canManageEvent(event, guild, user.id);
    const repeating = Boolean(event.recurrence) && event.status === 'scheduled';
    return [
      ...(manages ? [{ key: 'edit', label: t(event.recurrence ? 'events.menu.editAll' : 'events.menu.edit'), icon: faPen, onSelect: () => onEdit(event, false) }] : []),
      ...(manages && repeating ? [
        { key: 'occurrence', label: t('events.menu.editOccurrence'), icon: faClock, onSelect: () => onEdit(event, true) },
        { key: 'skip', label: t('events.menu.skipOccurrence'), icon: faCalendarXmark, onSelect: () => setConfirm({ kind: 'skip', event }) },
      ] : []),
      {
        key: 'link',
        label: t('events.menu.copyLink'),
        icon: faLink,
        onSelect: async () => {
          try {
            await navigator.clipboard.writeText(eventLink(guild.id, event.id));
            setCopied(true);
          } catch {
            setError(t('events.menu.copyFailed'));
          }
        },
      },
      ...(manages ? [{ key: 'cancel', label: t('events.menu.cancel'), icon: faBan, danger: true, onSelect: () => setConfirm({ kind: 'cancel', event }) }] : []),
    ];
  }

  if (confirm) {
    const { kind, event } = confirm;
    return (
      <ConfirmDialog
        title={t(`events.confirm.${kind}.title`, { name: event.name })}
        message={t(`events.confirm.${kind}.message`, { name: event.name, date: formatEventWhen(event) })}
        confirmLabel={t(`events.confirm.${kind}.confirm`)}
        onConfirm={async () => {
          if (kind === 'cancel') {
            await cancelEvent(event.id);
            onOpenEvent(null);
          } else {
            await skipOccurrence(event.id);
          }
        }}
        onClose={() => setConfirm(null)}
      />
    );
  }

  const missing = eventId != null && !open && loaded;
  const title = open ? open.name : t('events.dialog.title', { count: events.length });
  const mayCreate = canCreateEvents(guild);
  const tabs = ['calendar', 'week', 'events'];
  return (
    <Modal
      title={title}
      className="events-dialog"
      onClose={onClose}
      // No bar at all when there's no button (the calendar has its own Create Event).
      actions={eventId == null && !(view.tab === 'events' && mayCreate) ? null : (
        <>
          {eventId != null && (
            <button type="button" className="btn btn-secondary btn-sm events-back" onClick={() => onOpenEvent(null)}>
              <FontAwesomeIcon icon={faChevronLeft} /> {view.tab !== 'events' ? t('events.dialog.backToCalendar') : t('events.dialog.allEvents')}
            </button>
          )}
          {eventId == null && view.tab === 'events' && mayCreate && (
            <button type="button" className="btn btn-primary btn-sm vc-button" onClick={() => onCreate()}>{t('events.dialog.create')}</button>
          )}
        </>
      )}
    >
      {open && <EventDetail event={open} guild={guild} user={user} buttons={buttonsFor(open)} />}
      {missing && <p className="vc-hint">{t('events.dialog.gone')}</p>}
      {eventId == null && (
        <div className="settings-tabs events-tabs" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={view.tab === tab}
              className={`settings-tab${view.tab === tab ? ' active' : ''}`}
              onClick={() => onView({ tab })}
            >
              {t(`events.dialog.tab.${tab}`)}
            </button>
          ))}
        </div>
      )}
      {eventId == null && view.tab === 'calendar' && (
        <EventCalendar
          guild={guild}
          events={events}
          month={view.month}
          day={view.day}
          onMonth={(month) => onView({ month })}
          onDay={(day) => onView({ day })}
          onOpenEvent={onOpenEvent}
          onCreate={mayCreate ? onCreate : null}
        />
      )}
      {eventId == null && view.tab === 'week' && (
        <EventWeek
          guild={guild}
          events={events}
          day={view.day}
          onDay={(day) => onView({ day, month: day.slice(0, 7) })}
          onOpenEvent={onOpenEvent}
          onCreate={mayCreate ? onCreate : null}
        />
      )}
      {eventId == null && view.tab === 'events' && (
        events.length ? (
          <div className="event-list">
            {events.map((event) => (
              <EventCard key={event.id} event={event} guild={guild} onOpen={() => onOpenEvent(event.id)}>
                {buttonsFor(event)}
              </EventCard>
            ))}
          </div>
        ) : (
          <div className="events-empty">
            <p><strong>{t('events.dialog.emptyTitle')}</strong></p>
            <p className="vc-hint">{loaded ? t('events.dialog.emptyHint') : t('events.detail.loading')}</p>
          </div>
        )
      )}
      {copied && <p className="vc-hint" role="status">{t('events.menu.copied')}</p>}
      {error && <p className="error-msg" role="alert">{error}</p>}
      {menu && (
        <ContextMenu
          title={menu.event.name}
          label={menu.event.name}
          items={menuItems(menu.event)}
          anchor={menu.anchor}
          sheet={isMobile}
          onClose={() => setMenu(null)}
        />
      )}
    </Modal>
  );
}
