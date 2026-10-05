import React, { useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '../../assets/css/events.css';
import EventCard from './EventCard';
import { LayoutContext } from '../../contexts';
import { fetchEvent, setEventInterest } from '../../services/guildService';
import { onGuildEvent } from '../../utils/ws-client';
import { errorMessage } from '../../utils/guildDisplay';
import { t } from '../../i18n';

// The card under a guild message with an event link (utils/inviteLinks eventFromUrl): the
// event as in the events list, with Interested and View. Only in guild channels (an encrypted
// chat's link isn't sent to the server to look up), and only for events you can see.
export default function EventEmbed({ guildId, eventId }) {
  const navigate = useNavigate();
  const guild = useContext(LayoutContext)?.guildList?.layouts[guildId];
  const [event, setEvent] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
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
  }, [eventId]);

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
