import React, { useState } from 'react';
import { builtInServerHost, findServer, isBuiltIn, isBuiltInServer, saveServer, serverHost } from '../utils/server';
import { t } from '../i18n';

const ERRORS = {
  invalid_address: 'auth.server.invalidAddress',
  unreachable: 'auth.server.unreachable',
};

// Which server the login screen logs in to, and changing it (utils/server.js): the address is
// checked, then this device's login data is forgotten and the page reloads onto the new server.
export default function ServerChoice() {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function switchTo(server) {
    // Nothing from another server's account may stay (ids are only unique on one server).
    const { forgetLogin } = await import('../services/logout');
    await forgetLogin();
    await saveServer(server);
    window.location.reload();
  }

  async function connect(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const server = await findServer(address);
      if (isBuiltIn(server) && isBuiltInServer()) {
        setOpen(false);
        return;
      }
      await switchTo(server);
    } catch (err) {
      setError(t(ERRORS[err.code] ?? ERRORS.unreachable));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <p className="login-server">
        {t('auth.server.current', { host: serverHost() })}
        {' · '}
        <button type="button" className="link-button" onClick={() => setOpen(true)}>
          {t('auth.server.change')}
        </button>
      </p>
    );
  }

  return (
    <form className="login-server-form mb-3" onSubmit={connect}>
      <p className="register-password-hint">{t('auth.server.hint')}</p>
      {error && <div className="login-error" role="alert">{error}</div>}
      <input
        name="server"
        className="form-control mb-2"
        placeholder={t('auth.server.addressPlaceholder')}
        aria-label={t('auth.server.address')}
        autoComplete="url"
        autoCapitalize="none"
        spellCheck={false}
        required
        autoFocus
        value={address}
        onChange={(e) => setAddress(e.target.value)}
      />
      <div className="login-server-actions">
        <button className="btn btn-vc" type="submit" disabled={busy}>
          {busy ? t('auth.pleaseWait') : t('auth.server.connect')}
        </button>
        {!isBuiltInServer() && (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => switchTo(null)}>
            {t('auth.server.useBuiltIn', { host: builtInServerHost() })}
          </button>
        )}
        <button type="button" className="link-button" disabled={busy} onClick={() => { setOpen(false); setError(''); }}>
          {t('auth.server.cancel')}
        </button>
      </div>
    </form>
  );
}
