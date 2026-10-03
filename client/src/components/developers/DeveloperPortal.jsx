import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus } from '@fortawesome/free-solid-svg-icons';
import DeveloperPage from './DeveloperPage';
import ApplicationPage from './ApplicationPage';
import Avatar from '../Avatar';
import Modal from '../guild/Modal';
import { createApplication, fetchApplications, rememberBots } from '../../services/developerService';
import { errorMessage } from '../../utils/guildDisplay';
import { displayName, useProfiles } from '../../utils/profiles';
import { t } from '../../i18n';

const NAME_LENGTH = 32;

// The developer portal (/developers): your applications (bots), and making a new one; with an
// application id (/developers/applications/:appId), that application's settings.
export default function DeveloperPortal() {
  const { appId } = useParams();
  return (
    <DeveloperPage>
      {appId ? <ApplicationPage key={appId} appId={appId} /> : <ApplicationList />}
    </DeveloperPage>
  );
}

function ApplicationList() {
  useProfiles();
  const navigate = useNavigate();
  const [apps, setApps] = useState(null);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchApplications()
      .then((list) => {
        rememberBots(list);
        setApps(list);
      })
      .catch(() => setError(t('developers.loadFailed')));
  }, []);

  return (
    <section className="dev-section">
      <div className="dev-section-head">
        <h2>{t('developers.list.heading')}</h2>
        <button type="button" className="btn btn-primary vc-button" onClick={() => setCreating(true)}>
          <FontAwesomeIcon icon={faPlus} /> {t('developers.list.new')}
        </button>
      </div>
      <p className="vc-hint">{t('developers.list.intro')}</p>
      {error && <p className="error-msg" role="alert">{error}</p>}
      {apps && !apps.length && <p className="dev-empty">{t('developers.list.empty')}</p>}
      {apps && apps.length > 0 && (
        <ul className="dev-app-grid">
          {apps.map((app) => (
            <li key={app.id}>
              <button
                type="button"
                className="dev-app-tile"
                onClick={() => navigate(`/developers/applications/${app.id}`)}
                aria-label={t('developers.list.open', { name: app.name })}
              >
                <Avatar userId={app.bot.id} className="dev-app-avatar" />
                <span className="dev-app-name">{displayName(app.bot.id, app.name)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <NewApplicationDialog
          onClose={() => setCreating(false)}
          onCreated={(app) => navigate(`/developers/applications/${app.id}`, { state: { token: app.token } })}
        />
      )}
    </section>
  );
}

function NewApplicationDialog({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(await createApplication(name.trim()));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t('developers.create.title')}
      onClose={onClose}
      actions={(
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" form="dev-new-app" className="btn btn-primary vc-button" disabled={busy || name.trim().length < 2}>
            {t('developers.create.submit')}
          </button>
        </>
      )}
    >
      <form id="dev-new-app" onSubmit={submit}>
        <label htmlFor="dev-new-app-name">{t('developers.create.nameLabel')}</label>
        <input
          id="dev-new-app-name"
          className="form-control"
          value={name}
          maxLength={NAME_LENGTH}
          placeholder={t('developers.create.namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <p className="vc-hint">{t('developers.create.hint')}</p>
        {error && <p className="error-msg" role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
