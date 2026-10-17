import React, { useContext, useState } from 'react';
import api from '../utils/api';
import { ConfigContext } from '../contexts';
import '../assets/css/login.css';
import { t } from '../i18n';

// Instead of the app, once, for someone who hasn't accepted the current terms of use (from
// before there were any, or since they changed; server/terms.js): read them, agree, or log out.
// Google Play wants people to accept the rules before they post.
export default function TermsGate({ onAccepted, onLogout }) {
  const { termsVersion, termsUrl = 'https://voicaw.com/terms/', privacyUrl = 'https://voicaw.com/privacy/' } = useContext(ConfigContext);
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function accept() {
    setSaving(true);
    setError(null);
    try {
      await api.post('/terms/accept', { version: termsVersion });
      onAccepted();
    } catch {
      setError(t('auth.terms.error'));
      setSaving(false);
    }
  }

  return (
    <div className="login-page terms-gate">
      <div className="form-container" role="group" aria-labelledby="terms-gate-title">
        <h3 id="terms-gate-title" className="login-header text-center mb-3">{t('auth.terms.title')}</h3>
        <p>{t('auth.terms.text')}</p>
        <p className="terms-gate-links">
          <a href={termsUrl} target="_blank" rel="noreferrer">{t('auth.terms.read')}</a>
          <a href={privacyUrl} target="_blank" rel="noreferrer">{t('auth.terms.privacy')}</a>
        </p>
        <label className="register-terms">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} disabled={saving} />
          {' '}{t('auth.terms.agree')}
        </label>
        {error && <p className="error-msg" role="alert">{error}</p>}
        <button type="button" className="btn btn-primary w-100 mt-2" onClick={accept} disabled={!agreed || saving || !termsVersion}>
          {t('auth.terms.continue')}
        </button>
        <button type="button" className="link-button mt-2" onClick={onLogout}>{t('auth.terms.logOut')}</button>
      </div>
    </div>
  );
}
