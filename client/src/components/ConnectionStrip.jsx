import React, { useEffect, useState } from 'react';
import { connectionTrouble, noteRequestAnswered, useConnection } from '../utils/connection';
import { useOfflineMode } from '../utils/offlineMode';
import { reconnectNow } from '../utils/ws-client';
import api from '../utils/api';
import { t } from '../i18n';

// How long trouble lasts before the strip shows: a phone back from the background reconnects
// in a moment, and needn't flash it.
const SHOW_AFTER_MS = 2000;
const CHECK_EVERY_MS = 5000;

// The connection strip (utils/connection.js): Voicaw can't be reached while the app is in use.
// One place says so, counting down to the next try, instead of every request failing with its
// own message. Not in offline mode (the app started without the server), which has its banner.
export default function ConnectionStrip() {
  const connection = useConnection();
  const { offline } = useOfflineMode();
  const trouble = !offline && connectionTrouble(connection);
  const [shown, setShown] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!trouble) {
      setShown(false);
      return undefined;
    }
    const timer = setTimeout(() => setShown(true), SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [trouble]);

  useEffect(() => {
    if (!shown || !connection.nextAttemptAt) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [shown, connection.nextAttemptAt]);

  // Only requests went unanswered (the socket may be fine): ask now and then whether Voicaw
  // answers again; any answer clears it.
  useEffect(() => {
    if (!shown || !connection.apiDown) return undefined;
    const timer = setInterval(() => api.get('/config', { offlineCopy: 'never' }).catch(() => {}), CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [shown, connection.apiDown]);

  if (!shown) return null;

  const seconds = connection.nextAttemptAt ? Math.ceil((connection.nextAttemptAt - now) / 1000) : 0;
  const tryNow = () => {
    reconnectNow();
    // A request's report clears with any answer: ask for one.
    api.get('/config', { offlineCopy: 'never' }).then(noteRequestAnswered, () => {});
  };

  return (
    <div className="connection-strip" role="status">
      <span className="connection-strip-dot" aria-hidden="true" />
      <span className="connection-strip-text">
        <strong>{t('errors.connection.lost')}</strong>{' '}
        <span>{seconds > 0 ? t('errors.connection.retryIn', { seconds }) : t('errors.connection.retrying')}</span>
      </span>
      <button type="button" className="connection-strip-button" onClick={tryNow}>{t('errors.connection.tryNow')}</button>
    </div>
  );
}
