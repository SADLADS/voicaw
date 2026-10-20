import React, { useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '../../assets/css/events.css';
import EventCard from './EventCard';
import { LayoutContext } from '../../contexts';
import { fetchEvent, setEventInterest } from '../../services/guildService';
import { onGuildEvent } from '../../utils/ws-client';
import { errorMessage } from '../../utils/guildDisplay';
import { usePrivacyPrefs } from '../../utils/privacy';
import { t } from '../../i18n';

// Events shown after a tap this session, so they stay shown when the list redraws.
const shownEvents = new Set();

// The card under a message with an event link (utils/inviteLinks eventFromUrl): the event as in
// the events list, with Interested and View, only for events you can see.
// `autoLoad` false (encrypted chats): asking the server about the event would tell it which
// event someone was sent, so, as invite cards (InviteEmbed), it only asks once Show is tapped,
// unless Settings → Privacy says to load them anyway (utils/privacy `inviteEmbedsInEncrypted`).
export default function EventEmbed({ guildId, eventId, autoLoad = true }) {
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
    fetchEvent(eventId)
      .then((data) => { if (!cancelled) setEvent(data); })
      .catch((err) => { if (!cancelled) setError(err); });
    const off = onGuildEvent((e) => {
      if (e.type === 'guild_event_update' && e.event.id === eventId) setEvent((before) => (before ? { ...e.event, interested: before.interested } : before));
      else if (e.type === 'guild_event_delete' && e.event.id === eventId) setEvent(null);
      else if (e.type === 'guild_event_interest' && e.eventId === eventId) setEvent((before) => (before ? { ...before, user_count: e.userCount } : before));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [eventId, load]);

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

  function toggleInterest() {
    const next = !event.interested;
    setEvent((e) => ({ ...e, interested: next }));
    setEventInterest(event.id, next).catch(() => setEvent((e) => ({ ...e, interested: !next })));
  }

  return (
    <div className="event-embed">
      <EventCard event={event} guild={guild} onOpen={() => navigate(`/guild/${guildId}?event=${eventId}`)}>
        <button type="button" className={`btn btn-sm${event.interested ? ' btn-primary' : ' btn-secondary'}`} aria-pressed={Boolean(event.interested)} onClick={toggleInterest}>
          {t('events.actions.interested')}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => navigate(`/guild/${guildId}?event=${eventId}`)}>
          {t('events.embed.view')}
        </button>
      </EventCard>
    </div>
  );
}
