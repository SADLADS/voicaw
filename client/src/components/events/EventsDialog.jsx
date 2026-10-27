import React, { useContext, useEffect, useMemo, useState } from 'react';
import { Icon } from '../Icon';
import {
  faBan, faChevronLeft, faEllipsis, faLink, faPen, faPlay, faStop,
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
import RsvpButton from './RsvpButton';
import ScopeDialog from './ScopeDialog';
import DocumentCover from '../documents/DocumentCover';
import { MessageContent } from '../MessageList';
import { ConfigContext, InteractionContext } from '../../contexts';
import {
  cancelEvent, endEvent, fetchEvent, fetchEventHistory, fetchEventRsvps, setEventRsvp, skipOccurrence, startEvent,
} from '../../services/guildService';
import {
  canCreateEvents, canManageEvent, eventPlace, eventStatusText, formatEventWhen, rsvpAfter, rsvpSummary,
} from '../../utils/eventDisplay';
import { dateKeyIn, describeRepeat, occurrenceView, pastView, upcomingOccurrences } from '../../utils/eventRecurrence';
import { fromKey } from '../../utils/eventCalendar';
import { errorMessage, eventLink } from '../../utils/guildDisplay';
import { displayName, useProfiles } from '../../utils/profiles';
import { useDateFormat } from '../../utils/dateFormat';
import { t } from '../../i18n';

// How many of a repeating event's next dates its page lists.
const NEXT_DATES = 5;

// The date of an occurrence in links ('YYYY-MM-DD' in the event's time zone).
const linkDate = (view) => dateKeyIn(view.original_start ?? view.start_time, view.timezone);

// The event's description drawn like a message (markdown, mentions, emoji).
function Description({ text, user }) {
  const { s3Endpoint } = useContext(ConfigContext);
  const msg = useMemo(() => ({ plaintext: text, reactions: [] }), [text]);
  return <MessageContent msg={msg} user={user} s3Endpoint={s3Endpoint} />;
}

// RSVP (RsvpButton; `waitlisted`: you're going past its limit), Start or End for those who
// may, and the "more" button. An occurrence that took place has only the "more" button (its
// link).
function EventButtons({ event, waitlisted, manages, busy, onRsvp, onStart, onEnd, onMore }) {
  return (
    <>
      {!event.past && manages && event.current && event.status === 'scheduled' && (
        <button type="button" className="btn btn-success btn-sm" onClick={onStart} disabled={busy}>
          <Icon icon={faPlay} /> {t('events.actions.start')}
        </button>
      )}
      {!event.past && manages && event.status === 'active' && (
        <button type="button" className="btn btn-danger btn-sm" onClick={onEnd} disabled={busy}>
          <Icon icon={faStop} /> {t('events.actions.end')}
        </button>
      )}
      {!event.past && <RsvpButton event={event} waitlisted={waitlisted} onChoose={onRsvp} />}
      <button type="button" className="btn btn-secondary btn-sm event-more" aria-label={t('events.actions.more')} title={t('events.actions.more')} onClick={onMore}>
        <Icon icon={faEllipsis} />
      </button>
    </>
  );
}

const RSVP_GROUPS = ['going', 'waitlisted', 'maybe', 'declined'];

// Who answered the occurrence shown (occurrenceView's), by answer: going (of its limit), the
// waitlist in its order, maybe, can't go. For one that took place, how many were interested.
function RsvpList({ event }) {
  useProfiles();
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const occurrence = event.current ? null : event.original_start;
  const counts = event.rsvp_counts;
  useEffect(() => {
    if (event.past) return undefined;
    let cancelled = false;
    fetchEventRsvps(event.id, { occurrence })
      .then((found) => { if (!cancelled) setList(found); })
      .catch((err) => { if (!cancelled) setError(errorMessage(err)); });
    return () => {
      cancelled = true;
    };
    // Again whenever the counts change (someone answered).
  }, [event.id, event.past, occurrence, event.user_count, counts?.going, counts?.maybe, counts?.declined, counts?.waitlisted, event.rsvp_limit]);
  if (event.past) return <p className="vc-hint">{t('events.detail.pastCount', { count: event.user_count ?? 0 })}</p>;
  if (error) return <p className="error-msg" role="alert">{error}</p>;
  if (!list) return <p className="vc-hint">{t('events.detail.loading')}</p>;
  if (!list.length) return <p className="vc-hint">{t('events.detail.nobodyAnswered')}</p>;
  return (
    <div className="event-rsvps">
      {RSVP_GROUPS.map((group) => {
        const ids = list.filter((r) => r.rsvp === group).map((r) => r.user_id);
        if (!ids.length) return null;
        const heading = group === 'going' && event.rsvp_limit != null
          ? t('events.rsvp.groupGoingOf', { count: ids.length, limit: event.rsvp_limit })
          : t(`events.rsvp.group.${group}`, { count: ids.length });
        return (
          <section key={group} className={`event-rsvp-group ${group}`} aria-label={heading}>
            <h5 className="event-editor-label">{heading}</h5>
            <ul className="event-interested">
              {ids.map((id) => (
                <li key={id}>
                  <Avatar userId={id} className="event-interested-avatar" />
                  <span>{displayName(id, t('events.unknownUser'))}</span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

// A repeating event's next dates (from its current occurrence), the one shown marked; each
// opens that date.
function NextDates({ series, shown, onOpen }) {
  const dates = useMemo(() => upcomingOccurrences(series, NEXT_DATES), [series]);
  if (dates.length < 2) return null;
  return (
    <div className="event-detail-dates">
      <span className="event-editor-label">{t('events.detail.nextDates')}</span>
      <ul>
        {dates.map((o) => (
          <li key={o.original}>
            <button
              type="button"
              className={`event-detail-date${o.original === shown ? ' shown' : ''}`}
              aria-current={o.original === shown ? 'date' : undefined}
              onClick={() => onOpen(o.original)}
            >
              {formatEventWhen(series, { start: o.start, end: o.end })}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// One occurrence in full (`event`: occurrenceView's, or pastView's for one that took place):
// cover, when, how it repeats and its next dates (`series`, the event as listed, if it's still
// on), who made it, where, how many answered, the description, and who answered what (a tab).
function EventDetail({ event, series, guild, user, buttons, onOpenOccurrence }) {
  useDateFormat();
  useProfiles();
  const [tab, setTab] = useState('info');
  const place = eventPlace(event, guild);
  const status = eventStatusText(event);
  const start = new Date(event.start_time * 1000);
  return (
    <div className={`event-detail${event.past ? ' past' : ''}`}>
      {event.image && <DocumentCover cover={event.image} className="event-detail-cover" />}
      <div className="settings-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'info'} className={`settings-tab${tab === 'info' ? ' active' : ''}`} onClick={() => setTab('info')}>
          {t('events.detail.info')}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'rsvps'} className={`settings-tab${tab === 'rsvps' ? ' active' : ''}`} onClick={() => setTab('rsvps')}>
          {event.past
            ? t('events.detail.interestedTab', { count: event.user_count ?? 0 })
            : event.rsvp_counts
              ? t('events.detail.rsvpTab', { count: Object.values(event.rsvp_counts).reduce((a, b) => a + b, 0) })
              : t('events.detail.rsvps')}
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
          {!event.past && event.rsvp_counts && <p className="event-detail-line event-detail-rsvps">{rsvpSummary(event)}</p>}
          <p className="event-detail-line event-detail-creator">
            <Avatar userId={event.creator_id} className="event-interested-avatar" />
            {t('events.detail.createdBy', { name: displayName(event.creator_id, t('events.unknownUser')) })}
          </p>
          {event.description && <div className="event-detail-description"><Description text={event.description} user={user} /></div>}
          {series?.recurrence && !event.past && <NextDates series={series} shown={event.original_start} onOpen={onOpenOccurrence} />}
          {series && event.past && (
            <button type="button" className="btn btn-secondary btn-sm event-detail-next" onClick={() => onOpenOccurrence(null)}>
              {t('events.detail.showNext', { date: formatEventWhen(series) })}
            </button>
          )}
        </div>
      ) : (
        <RsvpList event={event} />
      )}
      <div className="event-detail-buttons">{buttons}</div>
    </div>
  );
}

// The guild's events (Calendar in the channel list), in three tabs of one dialog that keeps its
// size: the month (EventCalendar, first, where it opens), the week (EventWeek) and the list,
// soonest first; or one event (`eventId`, from any of them, a link or a notification). A
// repeating one shows one occurrence: `occurrence` (its original start; the current one by
// default), or `on`, a link's date, which the server turns into one (or into what took place
// then, or says it was cancelled); `past` is an occurrence that took place (the history's).
// `history` (and `loadHistory(from, to)`, as the calendar shows days) is what took place, drawn
// greyed. `view` ({ tab: 'calendar' | 'week' | 'events', month, day; the week is the day's }) is
// kept by the caller, so it's still there after the editor, and changed with `onView`.
// `onOpenEvent(id, occurrence?, past?)` opens one; `onCreate(start?)` opens the editor (start:
// unix s, from a calendar day), `onEdit(event, scope, occurrence)` with 'this', 'following' or
// 'all'. RSVP (`setRsvp` shows yours at once: useGuildEvents), Start/End and the menu (edit,
// copy links, cancel; a repeating event asks which dates) follow your permissions
// (utils/eventDisplay).
export default function EventsDialog({
  guild, user, events, loaded, setRsvp, history = [], loadHistory = () => Promise.resolve(), eventId, occurrence = null,
  on = null, past = null, view, onView, onOpenEvent, onCreate, onEdit, onClose,
}) {
  const { isMobile } = useContext(InteractionContext);
  const [menu, setMenu] = useState(null); // { event (a view), anchor }
  const [confirm, setConfirm] = useState(null); // { event }: cancelling one that doesn't repeat
  const [scope, setScope] = useState(null); // { kind: 'edit' | 'cancel', event }: which dates
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  // Why a link's date isn't the one shown ({ eventId, text }).
  const [note, setNote] = useState(null);
  // How many answered occurrences other than the current one (`${id}-${original}`: { user_count,
  // rsvp_counts, waitlist }).
  const [counts, setCounts] = useState({});
  const [missing, setMissing] = useState(false);
  const series = eventId != null ? events.find((e) => e.id === eventId) ?? null : null;

  // What's shown: the occurrence asked for, what took place then once the series has moved
  // past it, or its current one (a cancelled date's next).
  const shown = useMemo(() => {
    if (past) return pastView(past);
    if (!series) return null;
    if (occurrence == null || !series.recurrence || occurrence === series.occurrence_start) return occurrenceView(series);
    if (occurrence < series.occurrence_start) {
      const record = history.find((r) => r.id === series.id && r.original_start === occurrence);
      return record ? pastView(record) : occurrenceView(series);
    }
    if (series.occurrences?.some((o) => o.original_start === occurrence && o.status === 'canceled')) return occurrenceView(series);
    return occurrenceView(series, occurrence);
  }, [past, series, occurrence, history]);
  const countKey = shown && !shown.past && !shown.current ? `${shown.id}-${shown.original_start}` : null;
  const open = shown && countKey ? { ...shown, user_count: null, rsvp_counts: null, waitlist: null, ...counts[countKey] } : shown;

  useEffect(() => {
    setError(null);
    setCopied(false);
    setMissing(false);
    setNote((before) => (before?.eventId === eventId ? before : null));
  }, [eventId, occurrence]);

  // A link's date: which occurrence it is (or what took place then, even when the event is gone).
  useEffect(() => {
    if (eventId == null || on == null) return undefined;
    let cancelled = false;
    fetchEvent(eventId, { on })
      .then((found) => {
        if (cancelled) return;
        const occ = found.occurrence;
        if (occ?.status === 'completed') return onOpenEvent(found.id, occ.original_start, occ);
        if (!occ || occ.status === 'canceled') setNote({ eventId: found.id, text: t(occ ? 'events.detail.cancelledDate' : 'events.detail.notADate') });
        onOpenEvent(found.id, occ && occ.status !== 'canceled' ? occ.original_start : null);
      })
      .catch(async (err) => {
        if (cancelled) return;
        if (err?.response?.status !== 404) return setError(errorMessage(err));
        const day = Math.floor(fromKey(on).getTime() / 1000);
        const list = await fetchEventHistory(guild.id, day - 2 * 86400, day + 3 * 86400).catch(() => []);
        if (cancelled) return;
        const record = list.find((r) => r.id === eventId && linkDate(r) === on);
        if (record) onOpenEvent(eventId, record.original_start, record);
        else onOpenEvent(eventId);
      });
    return () => {
      cancelled = true;
    };
    // Only for a new link, not when the callbacks change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, on]);

  // An event that isn't listed may have been continued by another ("this and following"): the
  // server answers with that one.
  useEffect(() => {
    if (eventId == null || on != null || past || !loaded || series) return undefined;
    let cancelled = false;
    fetchEvent(eventId)
      .then((found) => {
        if (cancelled) return;
        if (found.id !== eventId && events.some((e) => e.id === found.id)) onOpenEvent(found.id);
        else setMissing(true);
      })
      .catch(() => { if (!cancelled) setMissing(true); });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, on, past, loaded, Boolean(series)]);

  // A later occurrence's count is only the server's.
  const countFor = shown && countKey ? shown.original_start : null;
  useEffect(() => {
    if (countFor == null) return undefined;
    let cancelled = false;
    fetchEvent(eventId, { occurrence: countFor })
      .then((found) => {
        const occ = found.occurrence;
        if (cancelled || occ?.user_count == null) return;
        const known = { user_count: occ.user_count, rsvp_counts: occ.rsvp_counts ?? null, waitlist: occ.waitlist ?? null };
        setCounts((c) => ({ ...c, [`${eventId}-${countFor}`]: known }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Again when you answer, or anyone answers the series.
  }, [eventId, countFor, shown?.rsvp, series?.user_count, series?.rsvp_counts, series?.rsvp_limit]);

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

  // `choice`: { rsvp, occurrence } (RsvpButton) on an occurrence of `listed`.
  function chooseRsvp(listed, choice) {
    const before = { rsvp: listed.rsvp ?? null, rsvp_all: listed.rsvp_all ?? null, my_rsvps: listed.my_rsvps ?? {}, interested: Boolean(listed.interested) };
    setRsvp(listed.id, rsvpAfter(listed, choice));
    setEventRsvp(listed.id, choice.rsvp, { occurrence: choice.occurrence }).catch((err) => {
      setRsvp(listed.id, before);
      setError(errorMessage(err));
    });
  }

  // The buttons of occurrence `shownEvent` (a view) of `listed` (the event as listed; none for
  // one that took place and is gone).
  function buttonsFor(shownEvent, listed) {
    return (
      <EventButtons
        event={shownEvent}
        waitlisted={Boolean(shownEvent.waitlist?.includes(user.id))}
        manages={Boolean(listed) && canManageEvent(listed, guild, user.id)}
        busy={busy}
        onRsvp={(choice) => chooseRsvp(listed, choice)}
        onStart={() => run(() => startEvent(shownEvent.id))}
        onEnd={() => run(() => endEvent(shownEvent.id))}
        onMore={(e) => setMenu({ event: shownEvent, anchor: e.currentTarget.getBoundingClientRect() })}
      />
    );
  }

  async function copy(link) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setError(t('events.menu.copyFailed'));
    }
  }

  function menuItems(shownEvent) {
    const listed = events.find((e) => e.id === shownEvent.id);
    const manages = Boolean(listed) && !shownEvent.past && canManageEvent(listed, guild, user.id);
    // Only a date still to come is asked about; a started one is changed as a whole.
    const asks = Boolean(shownEvent.recurrence) && shownEvent.status === 'scheduled';
    const links = shownEvent.recurrence || shownEvent.past
      ? [
        { key: 'link', label: t('events.menu.copyOccurrenceLink'), icon: faLink, onSelect: () => copy(eventLink(guild.id, shownEvent.id, linkDate(shownEvent))) },
        ...(listed?.recurrence ? [{ key: 'seriesLink', label: t('events.menu.copySeriesLink'), icon: faLink, onSelect: () => copy(eventLink(guild.id, shownEvent.id)) }] : []),
      ]
      : [{ key: 'link', label: t('events.menu.copyLink'), icon: faLink, onSelect: () => copy(eventLink(guild.id, shownEvent.id)) }];
    return [
      ...(manages ? [{
        key: 'edit',
        label: t('events.menu.edit'),
        icon: faPen,
        onSelect: () => (asks ? setScope({ kind: 'edit', event: shownEvent }) : onEdit(listed, 'all')),
      }] : []),
      ...links,
      ...(manages ? [{
        key: 'cancel',
        label: t('events.menu.cancel'),
        icon: faBan,
        danger: true,
        onSelect: () => (asks ? setScope({ kind: 'cancel', event: shownEvent }) : setConfirm({ event: shownEvent })),
      }] : []),
    ];
  }

  if (scope) {
    const { kind, event } = scope;
    const listed = events.find((e) => e.id === event.id);
    return (
      <ScopeDialog
        kind={kind}
        view={event}
        onChoose={async (chosen) => {
          if (kind === 'edit') {
            setScope(null);
            onEdit(listed, chosen, event.original_start);
            return;
          }
          if (chosen === 'this') await skipOccurrence(event.id, { occurrence: event.original_start });
          else if (chosen === 'following') await cancelEvent(event.id, { from: event.original_start });
          else await cancelEvent(event.id);
          setScope(null);
          const gone = chosen === 'all' || (chosen === 'following' && event.current);
          onOpenEvent(gone ? null : event.id);
        }}
        onClose={() => setScope(null)}
      />
    );
  }

  if (confirm) {
    const { event } = confirm;
    return (
      <ConfirmDialog
        title={t('events.confirm.cancel.title', { name: event.name })}
        message={t('events.confirm.cancel.message', { name: event.name, date: formatEventWhen(event) })}
        confirmLabel={t('events.confirm.cancel.confirm')}
        onConfirm={async () => {
          await cancelEvent(event.id);
          onOpenEvent(null);
        }}
        onClose={() => setConfirm(null)}
      />
    );
  }

  const resolving = eventId != null && on != null;
  const gone = eventId != null && !open && !resolving && missing;
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
              <Icon icon={faChevronLeft} /> {view.tab !== 'events' ? t('events.dialog.backToCalendar') : t('events.dialog.allEvents')}
            </button>
          )}
          {eventId == null && view.tab === 'events' && mayCreate && (
            <button type="button" className="btn btn-primary btn-sm vc-button" onClick={() => onCreate()}>{t('events.dialog.create')}</button>
          )}
        </>
      )}
    >
      {note && note.eventId === eventId && open && <p className="vc-hint" role="status">{note.text}</p>}
      {open && (
        <EventDetail
          key={`${open.id}-${open.original_start ?? ''}-${open.past ? 'past' : ''}`}
          event={open}
          series={series}
          guild={guild}
          user={user}
          buttons={buttonsFor(open, series)}
          onOpenOccurrence={(original) => onOpenEvent(eventId, original)}
        />
      )}
      {resolving && <p className="vc-hint">{t('events.detail.loading')}</p>}
      {gone && <p className="vc-hint">{t('events.dialog.gone')}</p>}
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
          history={history}
          loadHistory={loadHistory}
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
          history={history}
          loadHistory={loadHistory}
          day={view.day}
          onDay={(day) => onView({ day, month: day.slice(0, 7) })}
          onOpenEvent={onOpenEvent}
          onCreate={mayCreate ? onCreate : null}
        />
      )}
      {eventId == null && view.tab === 'events' && (
        events.length ? (
          <div className="event-list">
            {events.map((event) => {
              const current = occurrenceView(event);
              return (
                <EventCard key={event.id} event={current} guild={guild} onOpen={() => onOpenEvent(event.id)}>
                  {buttonsFor(current, event)}
                </EventCard>
              );
            })}
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
