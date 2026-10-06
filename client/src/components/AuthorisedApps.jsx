import React, { useEffect, useState } from 'react';
import Avatar from './Avatar';
import { fetchAuthorisedApps, removeAuthorisedApp } from '../services/developerService';
import { formatDate, useDateFormat } from '../utils/dateFormat';
import { displayName, mergeProfiles, useProfiles } from '../utils/profiles';
import { t } from '../i18n';

// Settings → Authorised apps: the websites you've logged in to with Voicaw (server/oauth.js),
// each with Remove, which ends its access at once.
export default function AuthorisedApps() {
  useProfiles();
  useDateFormat();
  const [apps, setApps] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchAuthorisedApps()
      .then((list) => {
        mergeProfiles(list.map((a) => ({ id: a.id, username: a.username, display_name: a.name, avatar: a.avatar })));
        setApps(list);
      })
      .catch(() => setError(t('settings.authorisedApps.loadFailed')));
  }, []);

  async function remove(app) {
    setError(null);
    try {
      await removeAuthorisedApp(app.id);
      setApps((list) => list.filter((a) => a.id !== app.id));
    } catch {
      setError(t('settings.authorisedApps.loadFailed'));
    }
  }

  return (
    <div className="settings-card">
      <h5>{t('settings.authorisedApps.title')}</h5>
      <p className="vc-hint">{t('settings.authorisedApps.hint')}</p>
      {apps && apps.length === 0 && <p className="vc-hint">{t('settings.authorisedApps.none')}</p>}
      {apps?.length > 0 && (
        <ul className="blocked-users">
          {apps.map((app) => (
            <li key={app.id}>
              <Avatar userId={app.id} className="blocked-user-avatar" />
              <span className="blocked-user-name">
                {displayName(app.id, app.name)}
                <span className="vc-hint authorised-app-since">{t('settings.authorisedApps.since', { date: formatDate(app.authorised_at * 1000) })}</span>
              </span>
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => remove(app)}>
                {t('settings.authorisedApps.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error-msg" role="alert">{error}</p>}
    </div>
  );
}
