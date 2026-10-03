import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';
import Avatar from '../Avatar';
import Modal from '../guild/Modal';
import GuildIcon from '../guild/GuildIcon';
import CopyField from './CopyField';
import PermissionChecklist from './PermissionChecklist';
import {
  deleteApplication, fetchApplication, inviteLink, rememberBots, removeFromGuild, resetToken, updateApplication,
} from '../../services/developerService';
import { toBitfield } from '../../utils/botPermissions';
import { MAX_PICTURE_BYTES, pictureData } from '../../utils/pictureData';
import { errorMessage } from '../../utils/guildDisplay';
import { formatDate, formatDateTime, useDateFormat } from '../../utils/dateFormat';
import { displayName, useProfiles } from '../../utils/profiles';
import { t } from '../../i18n';

const TABS = ['general', 'bot', 'installation'];
const NAME_LENGTH = 32;
const DESCRIPTION_LENGTH = 190;
// What a new invite link asks for until changed: enough to read and talk.
const DEFAULT_PERMISSIONS = ['VIEW_CHANNEL', 'SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS', 'ADD_REACTIONS'];

// One application's settings, in tabs: General Information, Bot (token, public), Installation
// (permissions, the invite link, its guilds).
export default function ApplicationPage({ appId }) {
  useProfiles();
  const location = useLocation();
  const navigate = useNavigate();
  const [app, setApp] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState(location.state?.token ? 'bot' : 'general');
  // A token just made (on creation, or by Reset Token): shown until the page is left.
  const [token, setToken] = useState(location.state?.token ?? null);

  useEffect(() => {
    // The token came in the history entry: gone from it, so going back doesn't show it again.
    if (location.state?.token) navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate]);

  useEffect(() => {
    fetchApplication(appId)
      .then((data) => {
        rememberBots([data]);
        setApp(data);
      })
      .catch((err) => setError(err?.response?.status === 404 ? errorMessage(err) : t('developers.loadFailed')));
  }, [appId]);

  const changed = (data) => {
    rememberBots([data]);
    setApp(data);
  };

  if (error) {
    return (
      <section className="dev-section">
        <Link to="/developers" className="dev-back"><FontAwesomeIcon icon={faChevronLeft} /> {t('developers.list.heading')}</Link>
        <p className="error-msg" role="alert">{error}</p>
      </section>
    );
  }
  if (!app) return <p className="vc-hint dev-section">{t('common.loading')}</p>;

  return (
    <section className="dev-section">
      <Link to="/developers" className="dev-back"><FontAwesomeIcon icon={faChevronLeft} /> {t('developers.list.heading')}</Link>
      <div className="dev-app-header">
        <Avatar userId={app.bot.id} className="dev-app-header-avatar" />
        <h2>{displayName(app.bot.id, app.name)}</h2>
      </div>
      <div className="dev-tabs" role="tablist" aria-label={t('developers.tabs.label')}>
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`dev-tab${tab === id ? ' active' : ''}`}
            onClick={() => setTab(id)}
          >
            {t(`developers.tabs.${id}`)}
          </button>
        ))}
      </div>
      <div className="dev-tab-panel" role="tabpanel">
        {tab === 'general' && <GeneralTab app={app} onChanged={changed} />}
        {tab === 'bot' && <BotTab app={app} token={token} onToken={setToken} onChanged={changed} />}
        {tab === 'installation' && <InstallationTab app={app} onChanged={changed} />}
      </div>
    </section>
  );
}

function GeneralTab({ app, onChanged }) {
  useDateFormat();
  const navigate = useNavigate();
  const [name, setName] = useState(app.name);
  const [description, setDescription] = useState(app.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const fileRef = useRef(null);

  const dirty = name.trim() !== app.name || description.trim() !== (app.description ?? '');

  async function run(action) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const save = (e) => {
    e.preventDefault();
    run(async () => {
      onChanged(await updateApplication(app.id, { name: name.trim(), description: description.trim() || null }));
      setSaved(true);
    });
  };

  const pick = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_PICTURE_BYTES) return setError(t('developers.general.pictureTooBig'));
    run(async () => onChanged(await updateApplication(app.id, { avatar: await pictureData(file) })));
  };

  return (
    <form className="dev-form" onSubmit={save}>
      <div className="dev-picture">
        <Avatar userId={app.bot.id} className="dev-picture-preview" alt={t('developers.general.picture')} />
        <div className="dev-picture-actions">
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            {t('developers.general.uploadPicture')}
          </button>
          {app.bot.avatar && (
            <button type="button" className="btn btn-link btn-sm" disabled={busy} onClick={() => run(async () => onChanged(await updateApplication(app.id, { avatar: null })))}>
              {t('developers.general.removePicture')}
            </button>
          )}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" hidden onChange={pick} />
        </div>
      </div>

      <label htmlFor="dev-app-name">{t('developers.general.nameLabel')}</label>
      <input id="dev-app-name" className="form-control" value={name} maxLength={NAME_LENGTH} onChange={(e) => setName(e.target.value)} />

      <label htmlFor="dev-app-description">{t('developers.general.descriptionLabel')}</label>
      <textarea
        id="dev-app-description"
        className="form-control"
        rows={3}
        value={description}
        maxLength={DESCRIPTION_LENGTH}
        onChange={(e) => setDescription(e.target.value)}
      />
      <p className="vc-hint">{t('developers.general.descriptionHint')}</p>

      <div className="dev-form-actions">
        <button type="submit" className="btn btn-primary vc-button" disabled={busy || !dirty || name.trim().length < 2}>
          {t('common.saveChanges')}
        </button>
        {saved && !dirty && <span className="vc-hint">{t('developers.general.saved')}</span>}
      </div>
      {error && <p className="error-msg" role="alert">{error}</p>}

      <CopyField id="dev-app-id" label={t('developers.general.idLabel')} value={String(app.id)} />
      <p className="vc-hint">{t('developers.general.created', { date: formatDate(app.created_at * 1000) })}</p>

      <div className="dev-danger">
        <h5>{t('developers.general.dangerZone')}</h5>
        <p className="vc-hint">{t('developers.general.deleteHint')}</p>
        <button type="button" className="btn btn-danger" onClick={() => setConfirmingDelete(true)}>{t('developers.general.delete')}</button>
      </div>
      {confirmingDelete && (
        <Modal
          title={t('developers.general.confirmDeleteTitle', { name: app.name })}
          onClose={() => setConfirmingDelete(false)}
          actions={(
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirmingDelete(false)}>{t('common.cancel')}</button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => run(async () => {
                  await deleteApplication(app.id);
                  navigate('/developers', { replace: true });
                })}
              >
                {t('common.delete')}
              </button>
            </>
          )}
        >
          <p>{t('developers.general.confirmDelete')}</p>
        </Modal>
      )}
    </form>
  );
}

function BotTab({ app, token, onToken, onChanged }) {
  useDateFormat();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirmingReset, setConfirmingReset] = useState(false);

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

  const reset = () => run(async () => {
    const { token: fresh } = await resetToken(app.id);
    onToken(fresh);
    setConfirmingReset(false);
  });

  return (
    <div className="dev-form">
      <CopyField id="dev-bot-username" label={t('developers.bot.usernameLabel')} value={`${app.bot.username}#${app.bot.discriminator}`} />

      <h5 className="dev-subheading">{t('developers.bot.tokenHeading')}</h5>
      {token ? (
        <div className="dev-token-box" role="status">
          <p><FontAwesomeIcon icon={faTriangleExclamation} /> {t('developers.bot.tokenNew')}</p>
          <CopyField id="dev-bot-token" value={token} secret />
          <p className="vc-hint">{t('developers.bot.tokenWarning')}</p>
        </div>
      ) : (
        <p className="vc-hint">{t('developers.bot.tokenHint')}</p>
      )}
      {app.token_reset_at && <p className="vc-hint">{t('developers.bot.tokenLastReset', { date: formatDateTime(app.token_reset_at * 1000) })}</p>}
      <div>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirmingReset(true)}>{t('developers.bot.resetToken')}</button>
      </div>

      <label className="dev-switch">
        <input
          type="checkbox"
          checked={app.public}
          disabled={busy}
          onChange={(e) => run(async () => onChanged(await updateApplication(app.id, { public: e.target.checked })))}
        />
        <span>
          <strong>{t('developers.bot.publicLabel')}</strong>
          <span className="vc-hint">{t('developers.bot.publicHint')}</span>
        </span>
      </label>
      {error && <p className="error-msg" role="alert">{error}</p>}

      {confirmingReset && (
        <Modal
          title={t('developers.bot.confirmResetTitle')}
          onClose={() => setConfirmingReset(false)}
          actions={(
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirmingReset(false)}>{t('common.cancel')}</button>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={reset}>{t('developers.bot.resetToken')}</button>
            </>
          )}
        >
          <p>{t('developers.bot.confirmReset')}</p>
        </Modal>
      )}
    </div>
  );
}

function InstallationTab({ app, onChanged }) {
  const [selected, setSelected] = useState(() => new Set(DEFAULT_PERMISSIONS));
  const [removing, setRemoving] = useState(null);
  const [error, setError] = useState(null);
  const link = useMemo(() => inviteLink(app.id, toBitfield(selected)), [app.id, selected]);

  async function remove(guild) {
    setError(null);
    try {
      await removeFromGuild(app.id, guild.id);
      onChanged({ ...app, guilds: app.guilds.filter((g) => g.id !== guild.id) });
      setRemoving(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="dev-form">
      <p className="vc-hint">{t('developers.install.intro')}</p>
      <CopyField id="dev-invite-link" label={t('developers.install.linkLabel')} value={link} />

      <h5 className="dev-subheading">{t('developers.install.permissionsHeading')}</h5>
      <PermissionChecklist selected={selected} onChange={setSelected} />

      <h5 className="dev-subheading">{t('developers.install.guildsHeading')}</h5>
      {!app.guilds.length && <p className="vc-hint">{t('developers.install.noGuilds')}</p>}
      <ul className="dev-guild-list">
        {app.guilds.map((guild) => (
          <li key={guild.id}>
            <GuildIcon guild={guild} className="dev-guild-icon" />
            <span className="dev-guild-name">{guild.name}</span>
            <button type="button" className="btn btn-link btn-sm" onClick={() => setRemoving(guild)}>
              {t('common.remove')}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="error-msg" role="alert">{error}</p>}
      {removing && (
        <Modal
          title={t('developers.install.remove', { name: removing.name })}
          onClose={() => setRemoving(null)}
          actions={(
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setRemoving(null)}>{t('common.cancel')}</button>
              <button type="button" className="btn btn-danger" onClick={() => remove(removing)}>{t('common.remove')}</button>
            </>
          )}
        >
          <p>{t('developers.install.confirmRemove', { bot: app.name, guild: removing.name })}</p>
        </Modal>
      )}
    </div>
  );
}
