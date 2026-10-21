import React, { useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '../../assets/css/events.css';
import EventCard from './EventCard';
import InterestButton from './InterestButton';
import { LayoutContext } from '../../contexts';
import { fetchEvent, setEventInterest } from '../../services/guildService';
import { interestAfter, interestKept } from '../../utils/eventDisplay';
import { occurrenceView, pastView } from '../../utils/eventRecurrence';
import { onGuildEvent } from '../../utils/ws-client';
import { errorMessage } from '../../utils/guildDisplay';
import { usePrivacyPrefs } from '../../utils/privacy';
import { t } from '../../i18n';

// Events shown after a tap this session, so they stay shown when the list redraws.
const shownEvents = new Set();

// The card under a message with an event link (utils/inviteLinks eventFromUrl): the event as in
// the events list, with Interested and View, only for events you can see. A repeating event's
// link with a date (`on`) shows that occurrence (or that it took place, or was cancelled); one
// without, the next.
// `autoLoad` false (encrypted chats): asking the server about the event would tell it which
// event someone was sent, so, as invite cards (InviteEmbed), it only asks once Show is tapped,
// unless Settings → Privacy says to load them anyway (utils/privacy `inviteEmbedsInEncrypted`).
export default function EventEmbed({ guildId, eventId, on = null, autoLoad = true }) {
  const navigate = useNavigate();
  const guild = useContext(LayoutContext)?.guildList?.layouts[guildId];
  const loadAnyway = usePrivacyPrefs().inviteEmbedsInEncrypted;
  const [shown, setShown] = useState(() => shownEvents.has(eventId));
  const load = autoLoad || loadAnyway || shown;
  const [event, setEvent] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!load) return undefined;
    let cancelled = false;
    fetchEvent(eventId, { on })
      .then((data) => { if (!cancelled) setEvent(data); })
      .catch((err) => { if (!cancelled) setError(err); });
    const off = onGuildEvent((e) => {
      if (e.type === 'guild_event_update' && e.event.id === eventId) {
        setEvent((before) => (before ? { ...e.event, ...interestKept(before, e.event), occurrence: before.occurrence } : before));
      }
      else if (e.type === 'guild_event_delete' && e.event.id === eventId) setEvent(null);
      else if (e.type === 'guild_event_interest' && e.eventId === eventId) setEvent((before) => (before ? { ...before, user_count: e.userCount } : before));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [eventId, on, load]);

  if (!load) {
    const show = () => {
      shownEvents.add(eventId);
      setShown(true);
    };
    return (
      <div className="event-embed event-embed-gone event-embed-hidden">
        <span>{t('events.embed.hidden')}</span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={show}>{t('events.embed.show')}</button>
      </div>
    );
  }

  if (error || !event || ['completed', 'canceled'].includes(event.status)) {
    if (!error) return null;
    return (
      <div className="event-embed event-embed-gone">
        {error?.response?.status === 404 ? t('events.embed.gone') : errorMessage(error)}
      </div>
    );
  }

  const occ = event.occurrence;
  if (occ?.status === 'canceled') {
    return <div className="event-embed event-embed-gone">{t('events.embed.cancelled', { name: event.name })}</div>;
  }
  // The occurrence the link is to: what took place then, that date, or the next.
  const card = occ?.status === 'completed' ? pastView(occ)
    : occ ? { ...occurrenceView(event, occ.original_start), user_count: occ.user_count ?? event.user_count }
      : occurrenceView(event);
  const path = `/guild/${guildId}?event=${event.id}${on ? `&on=${on}` : ''}`;

  // `choice`: { interested, occurrence } (InterestButton).
  function chooseInterest(choice) {
    const before = { interested: Boolean(event.interested), interested_all: Boolean(event.interested_all), my_occurrences: event.my_occurrences ?? {} };
    setEvent((e) => ({ ...e, ...interestAfter(e, choice) }));
    setEventInterest(event.id, choice.interested, { occurrence: choice.occurrence }).catch(() => setEvent((e) => ({ ...e, ...before })));
  }

  return (
    <div className="event-embed">
      <EventCard event={card} guild={guild} onOpen={() => navigate(path)} className={card.past ? 'past' : ''}>
        {!card.past && (
          <InterestButton event={card} className={`btn btn-sm${card.interested ? ' btn-primary' : ' btn-secondary'}`} onChoose={chooseInterest}>
            {t('events.actions.interested')}
          </InterestButton>
        )}
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => navigate(path)}>
          {t('events.embed.view')}
        </button>
      </EventCard>
    </div>
  );
}
