import React, { useEffect, useRef, useState } from 'react';
import api from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import { Trans } from 'react-i18next';
import { t } from '../i18n';
import { onSignupRequests, onTesterRequests } from '../utils/ws-client';
import { shareOrigin } from '../utils/guildDisplay';
import { formatDateTime } from '../utils/dateFormat';
import { displayName } from '../utils/profiles';

const SOURCE_LABELS = {
  admin: 'settings.admin.source.admin',
  env: 'settings.admin.source.env',
  unset: 'settings.admin.source.unset',
  default: 'settings.admin.source.default',
};

function errorText(err, fallback) {
  return err.response?.data?.error || fallback;
}

// App invites (server/signups.js): how long one lasts and how many sign-ups it lets in.
const EXPIRY_OPTIONS = [
  [60 * 60, t('guildAdmin.auditLog.age.hours', { count: 1 })],
  [24 * 60 * 60, t('guildAdmin.auditLog.age.days', { count: 1 })],
  [7 * 24 * 60 * 60, t('guildAdmin.auditLog.age.days', { count: 7 })],
  [30 * 24 * 60 * 60, t('guildAdmin.auditLog.age.days', { count: 30 })],
  [0, t('guildAdmin.invite.never')],
];
const USE_OPTIONS = [
  [0, t('guildAdmin.invite.noLimit')],
  ...[1, 5, 10, 25, 100].map((count) => [count, t('guildAdmin.invite.uses', { count })]),
];

// The link to share for an app invite (App.jsx's /join/ route).
const joinLink = (code) => `${shareOrigin()}/join/${code}`;

// A setting that takes one of its `choices` (a menu that saves as soon as it changes).
function ChoiceRow({ setting, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async (value) => {
    setSaving(true);
    setError(null);
    try {
      const { data } = await api.put(`/admin/settings/${setting.key}`, { value });
      onSaved(data.settings);
    } catch (err) {
      setError(errorText(err, t('settings.admin.couldntSave')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="admin-setting">
      <label htmlFor={`admin-${setting.key}`}>{setting.label}</label>
      <p className="admin-setting-help">
        {setting.description}
        {setting.env && <>{' '}<Trans i18nKey="settings.admin.envFallback" values={{ env: setting.env }} components={{ code: <code /> }} /></>}
      </p>
      <div className="admin-setting-row">
        <select
          id={`admin-${setting.key}`}
          className="form-select form-control"
          value={setting.value}
          disabled={saving}
          onChange={(e) => save(e.target.value)}
        >
          {setting.choices.map((choice) => (
            <option key={choice} value={choice}>{t(`settings.admin.choices.${setting.key}.${choice}`)}</option>
          ))}
        </select>
        {setting.source === 'admin' && (
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={saving}
            onClick={() => save(null)}
            title={setting.env ? t('settings.admin.goBackToEnv', { env: setting.env }) : t('settings.admin.useDefault')}
          >
            {setting.env ? t('settings.admin.useEnv') : t('settings.admin.useDefault')}
          </button>
        )}
      </div>
      <p className="admin-setting-state">{t(SOURCE_LABELS[setting.source === 'unset' ? 'default' : setting.source])}</p>
      {error && <p className="error-msg">{error}</p>}
    </div>
  );
}

// One app-wide setting. Secrets are never sent back: you can replace or clear one, not read it.
function SettingRow({ setting, onSaved }) {
  const [value, setValue] = useState(setting.secret ? '' : setting.value ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async (next) => {
    setSaving(true);
    setError(null);
    try {
      const { data } = await api.put(`/admin/settings/${setting.key}`, { value: next });
      onSaved(data.settings);
      if (setting.secret) setValue('');
    } catch (err) {
      setError(errorText(err, t('settings.admin.couldntSave')));
    } finally {
      setSaving(false);
    }
  };

  const current = setting.secret
    ? (setting.hint ? t('settings.admin.sourceWithHint', { source: t(SOURCE_LABELS[setting.source]), hint: setting.hint }) : t(SOURCE_LABELS.unset))
    : t(SOURCE_LABELS[setting.source]);

  return (
    <form
      className="admin-setting"
      onSubmit={(e) => {
        e.preventDefault();
        save(value);
      }}
    >
      <label htmlFor={`admin-${setting.key}`}>{setting.label}</label>
      <p className="admin-setting-help">
        {setting.description}
        {setting.env && <>{' '}<Trans i18nKey="settings.admin.envFallback" values={{ env: setting.env }} components={{ code: <code /> }} /></>}
      </p>
      <div className="admin-setting-row">
        <input
          id={`admin-${setting.key}`}
          type={setting.secret ? 'password' : 'text'}
          autoComplete="off"
          placeholder={setting.secret ? (setting.hint ? t('settings.admin.replaceValue') : t('settings.admin.enterValue')) : ''}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className="btn btn-sm uploadbutton" disabled={saving || !value.trim()}>
          {t('common.save')}
        </button>
        {setting.source === 'admin' && (
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={saving}
            onClick={() => save(null)}
            title={setting.env ? t('settings.admin.goBackToEnv', { env: setting.env }) : t('settings.admin.clear')}
          >
            {setting.env ? t('settings.admin.useEnv') : t('settings.admin.clear')}
          </button>
        )}
      </div>
      <p className="admin-setting-state">{current}</p>
      {error && <p className="error-msg">{error}</p>}
    </form>
  );
}

function AdminList({ admins, onChange, me }) {
  const [username, setUsername] = useState('');
  const [error, setError] = useState(null);

  const add = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const { data } = await api.post('/admin/admins', { username: username.trim() });
      onChange(data.admins);
      setUsername('');
    } catch (err) {
      setError(errorText(err, t('settings.admin.couldntAdd')));
    }
  };

  const remove = async (id) => {
    setError(null);
    try {
      const { data } = await api.delete(`/admin/admins/${id}`);
      onChange(data.admins);
    } catch (err) {
      setError(errorText(err, t('settings.admin.couldntRemove')));
    }
  };

  return (
    <div className="admin-setting">
      <label htmlFor="admin-add">{t('settings.admin.admins')}</label>
      <p className="admin-setting-help">{t('settings.admin.adminsHelp')}</p>
      <ul className="admin-list">
        {admins.map((a) => (
          <li key={a.id}>
            <span>{a.username}</span>
            {a.id !== me && (
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => remove(a.id)}>
                {t('common.remove')}
              </button>
            )}
          </li>
        ))}
      </ul>
      <form className="admin-setting-row" onSubmit={add}>
        <input
          id="admin-add"
          type="text"
          autoComplete="off"
          placeholder={t('settings.admin.username')}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <button type="submit" className="btn btn-sm uploadbutton" disabled={!username.trim()}>
          {t('settings.admin.makeAdmin')}
        </button>
      </form>
      {error && <p className="error-msg">{error}</p>}
    </div>
  );
}

// Accounts waiting for approval (sign-ups set to need it): approve, or decline (the account is
// deleted).
function RequestList({ requests, onChange }) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const act = async (id, approve) => {
    if (!approve && !window.confirm(t('settings.admin.requests.confirmDecline'))) return;
    setError(null);
    setBusy(id);
    try {
      const { data } = approve
        ? await api.post(`/admin/requests/${id}/approve`)
        : await api.delete(`/admin/requests/${id}`);
      onChange(data.requests);
    } catch (err) {
      setError(errorText(err, t('settings.admin.couldntSave')));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="admin-setting">
      <label>{t('settings.admin.requests.title')}</label>
      <p className="admin-setting-help">{t('settings.admin.requests.help')}</p>
      {requests.length === 0 ? (
        <p className="admin-setting-state">{t('settings.admin.requests.none')}</p>
      ) : (
        <ul className="admin-list">
          {requests.map((r) => (
            <li key={r.id}>
              <span>
                {displayName(r.id, r.display_name || r.username)}
                {r.display_name && r.display_name !== r.username && <span className="admin-list-detail"> {r.username}</span>}
                <span className="admin-list-detail"> · {formatDateTime(r.account_created * 1000)}</span>
              </span>
              <span className="admin-list-actions">
                <button type="button" className="btn btn-sm uploadbutton" disabled={busy === r.id} onClick={() => act(r.id, true)}>
                  {t('settings.admin.requests.approve')}
                </button>
                <button type="button" className="btn btn-sm btn-secondary" disabled={busy === r.id} onClick={() => act(r.id, false)}>
                  {t('settings.admin.requests.decline')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error-msg">{error}</p>}
    </div>
  );
}

// App invites: links that let someone sign up (when sign-ups need one) or skip the wait for
// approval.
function InviteList({ invites, onChange }) {
  const [maxAge, setMaxAge] = useState(7 * 24 * 60 * 60);
  const [maxUses, setMaxUses] = useState(1);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(null);

  const create = async () => {
    setError(null);
    try {
      const { data } = await api.post('/admin/invites', { maxAge, maxUses });
      onChange(data.invites);
      copy(data.invite.code);
    } catch (err) {
      setError(errorText(err, t('settings.admin.couldntSave')));
    }
  };

  const revoke = async (code) => {
    setError(null);
    try {
      const { data } = await api.delete(`/admin/invites/${code}`);
      onChange(data.invites);
    } catch (err) {
      setError(errorText(err, t('settings.admin.couldntRemove')));
    }
  };

  async function copy(code) {
    try {
      await navigator.clipboard.writeText(joinLink(code));
      setCopied(code);
    } catch {
      setCopied(null);
    }
  }

  return (
    <div className="admin-setting">
      <label>{t('settings.admin.invites.title')}</label>
      <p className="admin-setting-help">{t('settings.admin.invites.help')}</p>
      <div className="admin-setting-row admin-invite-options">
        <label>
          {t('guildAdmin.invite.expireAfter')}
          <select className="form-select form-control" value={maxAge} onChange={(e) => setMaxAge(Number(e.target.value))}>
            {EXPIRY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          {t('guildAdmin.invite.maxUses')}
          <select className="form-select form-control" value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
            {USE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <button type="button" className="btn btn-sm uploadbutton" onClick={create}>
          {t('settings.admin.invites.create')}
        </button>
      </div>
      {invites.length > 0 && (
        <ul className="admin-list">
          {invites.map((invite) => (
            <li key={invite.code}>
              <span className="admin-invite">
                <code>{joinLink(invite.code)}</code>
                <span className="admin-list-detail">
                  {[
                    invite.max_uses
                      ? t('settings.admin.invites.usedOf', { count: invite.uses, max: invite.max_uses })
                      : t('settings.admin.invites.used', { count: invite.uses }),
                    invite.expires_at
                      ? t('guildAdmin.invite.expires', { date: formatDateTime(invite.expires_at * 1000) })
                      : t('guildAdmin.auditLog.changes.neverExpires'),
                  ].join(' · ')}
                </span>
              </span>
              <span className="admin-list-actions">
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => copy(invite.code)}>
                  {copied === invite.code ? t('common.copied') : t('common.copy')}
                </button>
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => revoke(invite.code)}>
                  {t('settings.admin.invites.revoke')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error-msg">{error}</p>}
    </div>
  );
}

// People asking on voicaw.com to join the Android app's closed test on Google Play
// (server/routes/testerRequests.js): an admin adds the emails to Play's tester list by hand,
// then marks them added. Waiting ones first.
function TesterList() {
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => api.get('/admin/tester-requests').then(
      ({ data }) => { if (live) setRequests(data.testers ?? null); },
      () => {}
    );
    load();
    const off = onTesterRequests(load);
    return () => {
      live = false;
      off();
    };
  }, []);

  const act = async (request, change) => {
    if (change === 'delete' && !window.confirm(t('settings.admin.testers.confirmDelete', { email: request.email }))) return;
    setError(null);
    setBusy(request.id);
    try {
      const url = `/admin/tester-requests/${request.id}`;
      const { data } = change === 'delete'
        ? await api.delete(url)
        : await api.put(url, { added: change === 'added' });
      setRequests(data.testers);
    } catch (err) {
      setError(errorText(err, t('settings.admin.couldntSave')));
    } finally {
      setBusy(null);
    }
  };

  // For pasting into the Play Console's list (it takes them comma-separated).
  const copyWaiting = async () => {
    try {
      await navigator.clipboard.writeText(requests.filter((r) => !r.added_at).map((r) => r.email).join(', '));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  if (!requests) return null;
  const waiting = requests.filter((r) => !r.added_at).length;
  return (
    <div className="admin-setting">
      <label>{t('settings.admin.testers.title')}</label>
      <p className="admin-setting-help">{t('settings.admin.testers.help')}</p>
      {requests.length === 0 ? (
        <p className="admin-setting-state">{t('settings.admin.testers.none')}</p>
      ) : (
        <ul className="admin-list">
          {requests.map((r) => (
            <li key={r.id}>
              <span className="admin-invite">
                <code>{r.email}</code>
                <span className="admin-list-detail">
                  {[r.name, formatDateTime(r.created_at * 1000),
                    r.added_at && t('settings.admin.testers.added', { date: formatDateTime(r.added_at * 1000) })]
                    .filter(Boolean).join(' · ')}
                </span>
                {r.note && <span className="admin-list-detail admin-tester-note">{r.note}</span>}
              </span>
              <span className="admin-list-actions">
                <button
                  type="button"
                  className={`btn btn-sm ${r.added_at ? 'btn-secondary' : 'uploadbutton'}`}
                  disabled={busy === r.id}
                  onClick={() => act(r, r.added_at ? 'waiting' : 'added')}
                >
                  {r.added_at ? t('settings.admin.testers.markWaiting') : t('settings.admin.testers.markAdded')}
                </button>
                <button type="button" className="btn btn-sm btn-secondary" disabled={busy === r.id} onClick={() => act(r, 'delete')}>
                  {t('settings.admin.testers.delete')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {waiting > 0 && (
        <button type="button" className="btn btn-sm btn-secondary" onClick={copyWaiting}>
          {copied ? t('common.copied') : t('settings.admin.testers.copyWaiting')}
        </button>
      )}
      {error && <p className="error-msg">{error}</p>}
    </div>
  );
}

// Settings → Admin: app-wide settings, only shown to global admins (the server says who).
// Changes apply at once on the server; other people's apps pick them up when they next load.
// `onAvailable()` runs once it turns out you're an admin (Settings shows the Admin category then).
export default function AdminSettings({ onAvailable }) {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const onAvailableRef = useRef(onAvailable);
  onAvailableRef.current = onAvailable;

  useEffect(() => {
    let live = true;
    const load = () => api.get('/admin').then(
      ({ data: body }) => {
        if (!live || !body?.settings) return;
        setData(body);
        onAvailableRef.current?.();
      },
      () => {} // 403: not an admin, nothing to show
    );
    load();
    // Someone asked for an account (or another admin dealt with a request).
    const off = onSignupRequests(load);
    return () => {
      live = false;
      off();
    };
  }, []);

  if (!data) return null;
  return (
    <div className="settings-card admin-settings">
      <h5>{t('settings.admin.title')}</h5>
      {data.settings.map((setting) => {
        const Row = setting.choices ? ChoiceRow : SettingRow;
        return (
          <Row
            key={setting.key}
            setting={setting}
            onSaved={(settings) => setData((d) => ({ ...d, settings }))}
          />
        );
      })}
      <RequestList requests={data.requests ?? []} onChange={(requests) => setData((d) => ({ ...d, requests }))} />
      <TesterList />
      <InviteList invites={data.invites ?? []} onChange={(invites) => setData((d) => ({ ...d, invites }))} />
      <AdminList admins={data.admins} me={user?.id} onChange={(admins) => setData((d) => ({ ...d, admins }))} />
    </div>
  );
}
