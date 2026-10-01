import React, { useEffect, useRef, useState } from 'react';
import api from '../utils/api';
import { useAuth } from '../hooks/useAuth';

const SOURCE_LABELS = {
  admin: 'Set here',
  env: 'From server/.env',
  unset: 'Not set',
};

function errorText(err, fallback) {
  return err.response?.data?.error || fallback;
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
      setError(errorText(err, "Couldn't save"));
    } finally {
      setSaving(false);
    }
  };

  const current = setting.secret
    ? (setting.hint ? `${SOURCE_LABELS[setting.source]}: ${setting.hint}` : SOURCE_LABELS.unset)
    : SOURCE_LABELS[setting.source];

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
        {setting.env && <> Without a value here, <code>{setting.env}</code> in server/.env is used.</>}
      </p>
      <div className="admin-setting-row">
        <input
          id={`admin-${setting.key}`}
          type={setting.secret ? 'password' : 'text'}
          autoComplete="off"
          placeholder={setting.secret ? (setting.hint ? 'Enter a new value to replace it' : 'Enter a value') : ''}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className="btn btn-sm uploadbutton" disabled={saving || !value.trim()}>
          Save
        </button>
        {setting.source === 'admin' && (
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={saving}
            onClick={() => save(null)}
            title={setting.env ? `Go back to ${setting.env} from server/.env` : 'Clear'}
          >
            {setting.env ? 'Use .env' : 'Clear'}
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
      setError(errorText(err, "Couldn't add them"));
    }
  };

  const remove = async (id) => {
    setError(null);
    try {
      const { data } = await api.delete(`/admin/admins/${id}`);
      onChange(data.admins);
    } catch (err) {
      setError(errorText(err, "Couldn't remove them"));
    }
  };

  return (
    <div className="admin-setting">
      <label htmlFor="admin-add">Admins</label>
      <p className="admin-setting-help">Admins can change everything in this section.</p>
      <ul className="admin-list">
        {admins.map((a) => (
          <li key={a.id}>
            <span>{a.username}</span>
            {a.id !== me && (
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => remove(a.id)}>
                Remove
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
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <button type="submit" className="btn btn-sm uploadbutton" disabled={!username.trim()}>
          Make admin
        </button>
      </form>
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
    api.get('/admin').then(
      ({ data: body }) => {
        if (!live || !body?.settings) return;
        setData(body);
        onAvailableRef.current?.();
      },
      () => {} // 403: not an admin, nothing to show
    );
    return () => { live = false; };
  }, []);

  if (!data) return null;
  return (
    <div className="settings-card admin-settings">
      <h5>Admin</h5>
      {data.settings.map((setting) => (
        <SettingRow
          key={setting.key}
          setting={setting}
          onSaved={(settings) => setData((d) => ({ ...d, settings }))}
        />
      ))}
      <AdminList admins={data.admins} me={user?.id} onChange={(admins) => setData((d) => ({ ...d, admins }))} />
    </div>
  );
}
