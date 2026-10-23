import React, { useEffect, useState } from 'react';
import { connectMediaServer, disconnectMediaServer, fetchMediaServer } from '../../services/guildService';
import { errorMessage } from '../../utils/guildDisplay';
import { formatDateTime } from '../../utils/dateFormat';
import { displayName, useProfiles } from '../../utils/profiles';
import { t } from '../../i18n';

const KINDS = [['jellyfin', 'Jellyfin'], ['emby', 'Emby']];
const kindName = (kind) => KINDS.find(([key]) => key === kind)?.[1] ?? kind;

// Guild Settings → Watch Together (Manage Guild): the guild's Jellyfin or Emby server
// (server/mediaServers.js). Connecting logs in with an account's username and password, which
// the server doesn't keep (only the login's token); everyone watching gets that account's
// access, so it should be one made for the guild, not an administrator (the server refuses
// those). Disconnecting takes its videos out of the queues.
export default function MediaServerSettings({ guild }) {
  useProfiles();
  const [server, setServer] = useState(undefined); // undefined: loading; null: none
  const [form, setForm] = useState({ kind: 'jellyfin', url: '', username: '', password: '' });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchMediaServer(guild.id).then(setServer).catch((err) => {
      setServer(null);
      setError(errorMessage(err));
    });
  }, [guild.id]);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  async function connect(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      setServer(await connectMediaServer(guild.id, form));
      setForm((f) => ({ ...f, password: '' }));
      setEditing(false);
      setStatus(t('guildAdmin.mediaServer.connected'));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await disconnectMediaServer(guild.id);
      setServer(null);
      setStatus(t('guildAdmin.mediaServer.disconnected'));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const showForm = server === null || editing;

  return (
    <section className="media-server-settings">
      <h6>{t('guildAdmin.mediaServer.title')}</h6>
      <p className="vc-hint">{t('guildAdmin.mediaServer.hint')}</p>
      {server === undefined && !error && <p className="vc-hint">{t('common.loading')}</p>}
      {server && (
        <div className="media-server-current">
          <div>
            <strong>{server.name}</strong> <span className="vc-hint">({kindName(server.kind)})</span>
          </div>
          <div className="vc-hint">{server.url}</div>
          <div className="vc-hint">
            {t('guildAdmin.mediaServer.account', {
              username: server.username,
              name: displayName(server.connected_by, t('guildAdmin.mediaServer.someone')),
              date: formatDateTime(server.connected_at * 1000),
            })}
          </div>
          {!editing && (
            <div className="vc-form-row">
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => {
                setForm((f) => ({ ...f, kind: server.kind, url: server.url, username: server.username, password: '' }));
                setEditing(true);
              }}>
                {t('guildAdmin.mediaServer.change')}
              </button>
              <button type="button" className="btn btn-outline-danger btn-sm" disabled={busy} onClick={disconnect}>
                {t('guildAdmin.mediaServer.disconnect')}
              </button>
            </div>
          )}
        </div>
      )}
      {showForm && server !== undefined && (
        <form className="vc-form" onSubmit={connect}>
          <label htmlFor="media-server-kind">{t('guildAdmin.mediaServer.kind')}</label>
          <select id="media-server-kind" className="form-select form-control" value={form.kind} onChange={(e) => set('kind', e.target.value)}>
            {KINDS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          <label htmlFor="media-server-url">{t('guildAdmin.mediaServer.url')}</label>
          <input
            id="media-server-url"
            className="form-control"
            type="url"
            inputMode="url"
            placeholder="https://media.example.com"
            maxLength={300}
            value={form.url}
            onChange={(e) => set('url', e.target.value)}
          />
          <span className="vc-hint">{t('guildAdmin.mediaServer.urlHint')}</span>
          <label htmlFor="media-server-username">{t('guildAdmin.mediaServer.username')}</label>
          <input
            id="media-server-username"
            className="form-control"
            autoComplete="off"
            maxLength={100}
            value={form.username}
            onChange={(e) => set('username', e.target.value)}
          />
          <label htmlFor="media-server-password">{t('guildAdmin.mediaServer.password')}</label>
          <input
            id="media-server-password"
            className="form-control"
            type="password"
            autoComplete="new-password"
            maxLength={1000}
            value={form.password}
            onChange={(e) => set('password', e.target.value)}
          />
          <span className="vc-hint">{t('guildAdmin.mediaServer.accountHint')}</span>
          <div className="vc-form-row">
            <button type="submit" className="btn btn-primary btn-sm vc-button" disabled={busy || !form.url.trim() || !form.username.trim()}>
              {busy ? t('guildAdmin.mediaServer.connecting') : t('guildAdmin.mediaServer.connect')}
            </button>
            {editing && (
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setEditing(false)}>
                {t('common.cancel')}
              </button>
            )}
          </div>
        </form>
      )}
      {status && <p className="success-msg">{status}</p>}
      {error && <p className="error-msg" role="alert">{error}</p>}
    </section>
  );
}
