import React, { useContext, useState } from 'react';
import { Trans } from 'react-i18next';
import '../assets/css/login.css';
import '../assets/css/recovery.css';
import { connectWebSocket } from '../utils/ws-client';
import {
  MIN_PASSWORD_LENGTH, logIn, register, recoverAccount, generateRecoveryCode, saveRecoveryCode, suspendedText,
} from '../services/authService';
import { SUSPENDED_NOTICE } from '../utils/ws-client';

// This account was just suspended while the app was open (ws-client): what to say, once.
function takeSuspendedNotice() {
  try {
    const saved = sessionStorage.getItem(SUSPENDED_NOTICE);
    if (!saved) return '';
    sessionStorage.removeItem(SUSPENDED_NOTICE);
    return suspendedText(JSON.parse(saved).reason);
  } catch {
    return '';
  }
}
import RecoveryCodeDisplay from './RecoveryCodeDisplay';
import ServerChoice from './ServerChoice';
import { ConfigContext } from '../contexts';
import { t } from '../i18n';

// The terms of use a server's config doesn't name others (server/index.js `termsUrl`).
const DEFAULT_TERMS_URL = 'https://voicaw.com/terms/';

// The server's refusals of an invite or a reason, in the app's language.
const SIGNUP_ERRORS = {
  invite_required: 'auth.errors.inviteRequired',
  invalid_invite: 'auth.errors.invalidInvite',
  reason_required: 'auth.errors.reasonRequired',
  reason_too_long: 'auth.errors.reasonTooLong',
};

// The longest answer to "why do you want to join" the server takes (server/signups.js).
const MAX_REASON = 1000;

// Logging in, signing up and recovering an account. Signing up follows the server's sign-up
// mode (server/signups.js): an invite field when it needs one (or when one skips the wait for
// approval), and why they want to join when it needs approval (required if the server says, unless
// there's an invite). `invite`: the code from an app invite link (/join/<code>), filled in.
export default function Login({ onLoginSuccess, invite = '' }) {
  const {
    signupMode = 'open', signupReason = 'optional', termsVersion, termsUrl = DEFAULT_TERMS_URL,
  } = useContext(ConfigContext) ?? {};
  const [loginData, setLoginData] = useState({ username: '', password: '' });
  const [registerData, setRegisterData] = useState({ username: '', password: '', invite, reason: '' });
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [recoverData, setRecoverData] = useState({ username: '', code: '', password: '', confirm: '', twoFactorCode: '' });
  // The recovered account has two-factor on: the form asks for a code too.
  const [recoverNeedsTwoFactor, setRecoverNeedsTwoFactor] = useState(false);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  // 'login' (log in or register), 'recover' (forgot password), or { user, recoveryCode,
  // password? } while a new code is shown: after registering (already stored), or after
  // logging in to an account without one (`password` set: stored once the user continues),
  // or { twoFactor: { finish } } while asking for a two-factor code (authService logIn).
  const [mode, setMode] = useState('login');
  const [error, setError] = useState(takeSuspendedNotice);
  const [loading, setLoading] = useState(false);

  const switchTo = (next) => {
    setError('');
    setMode(next);
  };

  async function handleLogin(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await logIn(loginData.username, loginData.password);
      if (result.twoFactor) {
        setTwoFactorCode('');
        setMode({ twoFactor: result });
        return;
      }
      loggedIn(result);
    } catch (err) {
      setError(err.message);
      console.error('Login error:', err);
    } finally {
      setLoading(false);
    }
  }

  function loggedIn(user) {
    // Accounts from before recovery codes get one now.
    if (!user.hasRecoveryCode) {
      setMode({ user, recoveryCode: generateRecoveryCode(), password: loginData.password });
      return;
    }
    enterApp(user);
  }

  async function handleTwoFactor(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      loggedIn(await mode.twoFactor.finish(twoFactorCode));
    } catch (err) {
      if (err.code === 'two_factor_expired') {
        setMode('login');
        setError(t('auth.twoFactor.expired'));
      } else setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function enterApp(user) {
    // Push notifications are set up after login (Layout re-syncs the subscription;
    // asking for permission needs a tap, see NotificationPrompt / Settings).
    connectWebSocket();
    onLoginSuccess(user);
  }

  async function handleRegister(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { user, recoveryCode } = await register(
        registerData.username, registerData.password, signupMode === 'open' ? '' : registerData.invite, termsVersion,
        signupMode === 'request' ? registerData.reason : ''
      );
      setMode({ user, recoveryCode });
    } catch (err) {
      setError(SIGNUP_ERRORS[err.code] ? t(SIGNUP_ERRORS[err.code], { count: MAX_REASON }) : err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRecover(e) {
    e.preventDefault();
    setError('');
    if (recoverData.password !== recoverData.confirm) {
      setError(t('auth.recover.passwordsDontMatch'));
      return;
    }
    setLoading(true);
    try {
      enterApp(await recoverAccount(recoverData.username, recoverData.code, recoverData.password, recoverData.twoFactorCode));
    } catch (err) {
      if (err.code === 'two_factor_required') setRecoverNeedsTwoFactor(true);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function finishRecoveryCode() {
    if (mode.password) {
      await saveRecoveryCode(mode.user.username, mode.password, mode.recoveryCode);
      enterApp({ ...mode.user, hasRecoveryCode: true });
    } else if (mode.user) onLoginSuccess(mode.user);
    else {
      alert(t('auth.register.registered'));
      switchTo('login');
    }
  }

  if (mode.recoveryCode) {
    return (
      <div className="login-page">
        <div className="form-container">
          <h3 className="login-header text-center mb-3">{t('auth.recoveryCode.title')}</h3>
          <RecoveryCodeDisplay
            code={mode.recoveryCode}
            username={mode.user?.username ?? registerData.username}
            intro={mode.password && t('auth.recoveryCode.introNoCode')}
            onDone={finishRecoveryCode}
            onSkip={mode.password ? () => enterApp(mode.user) : undefined}
          />
        </div>
      </div>
    );
  }

  if (mode.twoFactor) {
    return (
      <div className="login-page">
        <div className="form-container">
          <h3 className="login-header text-center mb-3">{t('auth.twoFactor.title')}</h3>
          <p className="register-password-hint">{t('auth.twoFactor.hint')}</p>

          {error && <div className="login-error" role="alert">{error}</div>}

          <form onSubmit={handleTwoFactor} className="mb-3">
            <input
              name="two-factor-code"
              className="form-control mb-2"
              placeholder={t('auth.twoFactor.codePlaceholder')}
              autoComplete="one-time-code"
              autoCapitalize="none"
              spellCheck={false}
              required
              autoFocus
              value={twoFactorCode}
              onChange={e => setTwoFactorCode(e.target.value)}
            />
            <button className="btn btn-vc w-100" type="submit" disabled={loading}>
              {loading ? t('auth.pleaseWait') : t('auth.twoFactor.submit')}
            </button>
          </form>
          <button type="button" className="link-button" onClick={() => switchTo('login')}>
            {t('auth.twoFactor.back')}
          </button>
        </div>
      </div>
    );
  }

  if (mode === 'recover') {
    return (
      <div className="login-page">
        <div className="form-container">
          <h3 className="login-header text-center mb-3">{t('auth.recover.title')}</h3>
          <p className="register-password-hint">
            {t('auth.recover.hint')}
          </p>

          {error && <div className="login-error" role="alert">{error}</div>}

          <form onSubmit={handleRecover} className="mb-3">
            <input
              name="username"
              className="form-control mb-2"
              placeholder={t('auth.username')}
              autoComplete="username"
              required
              value={recoverData.username}
              onChange={e => setRecoverData({ ...recoverData, username: e.target.value })}
            />
            <input
              name="recovery-code"
              className="form-control mb-2"
              placeholder={t('auth.recover.codePlaceholder')}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              required
              value={recoverData.code}
              onChange={e => setRecoverData({ ...recoverData, code: e.target.value })}
            />
            <input
              type="password"
              name="new-password"
              className="form-control mb-2"
              placeholder={t('auth.recover.newPasswordPlaceholder')}
              autoComplete="new-password"
              required
              value={recoverData.password}
              onChange={e => setRecoverData({ ...recoverData, password: e.target.value })}
            />
            <input
              type="password"
              name="confirm-password"
              className="form-control mb-2"
              placeholder={t('auth.recover.confirmPlaceholder')}
              autoComplete="new-password"
              required
              value={recoverData.confirm}
              onChange={e => setRecoverData({ ...recoverData, confirm: e.target.value })}
            />
            {recoverNeedsTwoFactor && (
              <input
                name="two-factor-code"
                className="form-control mb-2"
                placeholder={t('auth.twoFactor.recoverCodePlaceholder')}
                autoComplete="one-time-code"
                autoCapitalize="none"
                spellCheck={false}
                required
                autoFocus
                value={recoverData.twoFactorCode}
                onChange={e => setRecoverData({ ...recoverData, twoFactorCode: e.target.value })}
              />
            )}
            <button className="btn btn-vc w-100" type="submit" disabled={loading}>
              {loading ? t('auth.pleaseWait') : t('auth.recover.submit')}
            </button>
          </form>
          <button type="button" className="link-button" onClick={() => switchTo('login')}>
            {t('auth.recover.backToLogin')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="form-container">
        <h3 className="login-header text-center mb-3">{t('auth.login.title')}</h3>
        <ServerChoice />

        {error && <div className="login-error" role="alert">{error}</div>}

        <form onSubmit={handleLogin} className="mb-3">
          <input
            name="username"
            className="form-control mb-2"
            placeholder={t('auth.username')}
            required
            value={loginData.username}
            onChange={e => setLoginData({ ...loginData, username: e.target.value })}
          />
          <input
            type="password"
            name="password"
            className="form-control mb-2"
            placeholder={t('auth.password')}
            required
            value={loginData.password}
            onChange={e => setLoginData({ ...loginData, password: e.target.value })}
          />
          <button className="btn btn-vc w-100" type="submit" disabled={loading}>
            {loading ? t('auth.pleaseWait') : t('auth.login.submit')}
          </button>
          <button type="button" className="link-button mt-2" onClick={() => switchTo('recover')}>
            {t('auth.login.forgotPassword')}
          </button>
        </form>

        <hr />

        <form onSubmit={handleRegister}>
          <input
            name="username"
            className="form-control mb-2"
            placeholder={t('auth.register.usernamePlaceholder')}
            required
            value={registerData.username}
            onChange={e => setRegisterData({ ...registerData, username: e.target.value })}
          />
          <input
            type="password"
            name="password"
            className="form-control mb-2"
            placeholder={t('auth.register.passwordPlaceholder')}
            required
            value={registerData.password}
            onChange={e => setRegisterData({ ...registerData, password: e.target.value })}
          />
          <p className="register-password-hint">
            {t('auth.register.passwordHint', { count: MIN_PASSWORD_LENGTH })}
          </p>
          {signupMode !== 'open' && (
            <>
              <input
                name="invite"
                className="form-control mb-2"
                placeholder={signupMode === 'invite' ? t('auth.register.invitePlaceholder') : t('auth.register.inviteOptionalPlaceholder')}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                required={signupMode === 'invite'}
                value={registerData.invite}
                onChange={e => setRegisterData({ ...registerData, invite: e.target.value })}
              />
              <p className="register-password-hint">
                {signupMode === 'invite' ? t('auth.register.inviteHint') : t('auth.register.requestHint')}
              </p>
            </>
          )}
          {signupMode === 'request' && (
            <textarea
              name="reason"
              className="form-control mb-2 register-reason"
              rows={3}
              maxLength={MAX_REASON}
              placeholder={signupReason === 'required' ? t('auth.register.reasonPlaceholder') : t('auth.register.reasonOptionalPlaceholder')}
              aria-label={t('auth.register.reasonPlaceholder')}
              required={signupReason === 'required' && !registerData.invite.trim()}
              value={registerData.reason}
              onChange={e => setRegisterData({ ...registerData, reason: e.target.value })}
            />
          )}
          {/* The server's terms of use (voicaw.com/terms/ unless it says): it refuses a sign-up without them. */}
          <label className="register-terms">
            <input type="checkbox" required checked={agreedToTerms} onChange={(e) => setAgreedToTerms(e.target.checked)} />
            {' '}
            <Trans
              i18nKey="auth.register.agree"
              components={{ terms: <a href={termsUrl} target="_blank" rel="noreferrer" /> }}
            />
          </label>
          <button className="btn btn-secondary w-100" type="submit" disabled={loading}>
            {loading ? t('auth.pleaseWait') : t('auth.register.submit')}
          </button>
        </form>
      </div>
    </div>
  );
}
