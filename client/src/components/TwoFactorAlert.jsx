import React from 'react';
import { useNavigate } from 'react-router-dom';
import { faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';
import { Icon } from './Icon';
import { useAuth } from '../hooks/useAuth';
import { dismissTwoFactorFailures } from '../services/authService';
import { t } from '../i18n';

// Wrong two-factor codes were tried for this account (server/twoFactor.js): whoever did knew the
// password. Shown on every device until dismissed (or Change password is chosen), which clears
// it everywhere.
export default function TwoFactorAlert() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const count = user && !user.pending ? user.twoFactorFailures ?? 0 : 0;
  if (count <= 0) return null;

  const dismiss = () => {
    setUser((current) => (current ? { ...current, twoFactorFailures: 0 } : current));
    dismissTwoFactorFailures().catch(() => { /* shown again next time: harmless */ });
  };

  return (
    <div className="update-banner two-factor-alert" role="alert">
      <span className="update-banner-icon" aria-hidden="true">
        <Icon icon={faTriangleExclamation} />
      </span>
      <span className="update-banner-text">
        <strong>{t('app.twoFactorAlert.title')}</strong>
        <span>{t('app.twoFactorAlert.text', { count })}</span>
      </span>
      <button
        type="button"
        className="update-banner-button"
        onClick={() => {
          dismiss();
          navigate('/settings/account#password');
        }}
      >
        {t('app.twoFactorAlert.changePassword')}
      </button>
      <button type="button" className="update-banner-close" onClick={dismiss} aria-label={t('settings.dismiss')}>
        ×
      </button>
    </div>
  );
}
