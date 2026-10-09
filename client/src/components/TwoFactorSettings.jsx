import React, { useEffect, useMemo, useState } from 'react';
import '../assets/css/recovery.css';
import { useAuth } from '../hooks/useAuth';
import {
  fetchTwoFactor, newTwoFactorSecret, enableTwoFactor, disableTwoFactor, newBackupCodes,
} from '../services/authService';
import { triggerDownload } from '../utils/saveFile';
import { t } from '../i18n';

// Settings → My Account → Two-factor (server/twoFactor.js): off until turned on. Setting it up
// shows a QR code (and the key, for typing in) for an authenticator app, then asks for one of
// its codes and the password; the ten backup codes are shown once. Turning it off or making
// new backup codes needs the password and a code.
export default function TwoFactorSettings() {
  const { user } = useAuth();
  const [status, setStatus] = useState(null);
  const [loadError, setLoadError] = useState(null);
  // null, 'setup', 'disable', 'backup' (new backup codes), or { codes } while they're shown.
  const [step, setStep] = useState(null);

  const load = () => fetchTwoFactor().then(setStatus, (err) => setLoadError(err.message));
  useEffect(() => {
    load();
  }, []);

  const showCodes = (codes) => {
    setStep({ codes });
    load();
  };

  let body;
  if (step?.codes) {
    body = <BackupCodes codes={step.codes} username={user.username} onDone={() => setStep(null)} />;
  } else if (step === 'setup') {
    body = <SetUp username={user.username} onEnabled={showCodes} onCancel={() => setStep(null)} />;
  } else if (step === 'disable' || step === 'backup') {
    body = (
      <ConfirmWithCode
        username={user.username}
        submitLabel={step === 'disable' ? t('settings.twoFactor.turnOff') : t('settings.twoFactor.showNewCodes')}
        onConfirm={step === 'disable' ? disableTwoFactor : newBackupCodes}
        onDone={(codes) => {
          if (step === 'backup') return showCodes(codes);
          setStep(null);
          load();
        }}
        onCancel={() => setStep(null)}
      />
    );
  } else if (status?.enabled) {
    body = (
      <div className="account-security-form">
        <p className="account-security-success">{t('settings.twoFactor.on')}</p>
        <p className="recovery-hint">{t('settings.twoFactor.backupCodesLeft', { count: status.backupCodesLeft })}</p>
        <button type="button" className="btn btn-sm btn-vc" onClick={() => setStep('backup')}>{t('settings.twoFactor.newBackupCodes')}</button>
        {' '}
        <button type="button" className="btn btn-sm btn-secondary" onClick={() => setStep('disable')}>{t('settings.twoFactor.turnOff')}</button>
      </div>
    );
  } else if (status) {
    body = (
      <div className="account-security-form">
        <p className="recovery-hint">{t('settings.twoFactor.off')}</p>
        <button type="button" className="btn btn-sm btn-vc" onClick={() => setStep('setup')}>{t('settings.twoFactor.setUp')}</button>
      </div>
    );
  } else {
    body = loadError ? <p className="error-msg" role="alert">{loadError}</p> : <p className="recovery-hint">{t('common.loading')}</p>;
  }

  return (
    <div className="settings-card">
      <h5>{t('settings.twoFactor.title')}</h5>
      {body}
    </div>
  );
}

// The authenticator app's QR code for `uri` (qrcode-generator, loaded when first shown), as
// an SVG of its modules.
function QrCode({ uri }) {
  const [qr, setQr] = useState(null);
  useEffect(() => {
    let live = true;
    import('qrcode-generator').then(({ default: qrcode }) => {
      const code = qrcode(0, 'M');
      code.addData(uri);
      code.make();
      if (live) setQr(code);
    });
    return () => { live = false; };
  }, [uri]);
  const path = useMemo(() => {
    if (!qr) return '';
    let d = '';
    for (let y = 0; y < qr.getModuleCount(); y++) {
      for (let x = 0; x < qr.getModuleCount(); x++) if (qr.isDark(y, x)) d += `M${x + 2} ${y + 2}h1v1h-1z`;
    }
    return d;
  }, [qr]);
  if (!qr) return <div className="two-factor-qr" />;
  const size = qr.getModuleCount() + 4;
  return (
    <svg className="two-factor-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={t('settings.twoFactor.qrLabel')} shapeRendering="crispEdges">
      <rect width={size} height={size} className="two-factor-qr-light" />
      <path d={path} className="two-factor-qr-dark" />
    </svg>
  );
}

function SetUp({ username, onEnabled, onCancel }) {
  const { secret, uri } = useMemo(() => newTwoFactorSecret(username), [username]);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      onEnabled(await enableTwoFactor(username, password, secret, code));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="account-security-form two-factor-setup" onSubmit={submit} aria-label={t('settings.twoFactor.setUp')}>
      <p>{t('settings.twoFactor.scan')}</p>
      <QrCode uri={uri} />
      <p className="recovery-hint">{t('settings.twoFactor.orType')}</p>
      <div className="recovery-code two-factor-secret" aria-label={t('settings.twoFactor.key')}>
        {secret.match(/.{1,4}/g).map((group, i) => <React.Fragment key={i}>{i > 0 && ' '}<span>{group}</span></React.Fragment>)}
      </div>
      <p>{t('settings.twoFactor.enterCode')}</p>
      <input
        className="form-control"
        placeholder={t('settings.twoFactor.codePlaceholder')}
        inputMode="numeric"
        autoComplete="one-time-code"
        required
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <input
        type="password"
        className="form-control"
        placeholder={t('settings.yourPassword')}
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button type="submit" className="btn btn-sm btn-vc" disabled={busy}>{busy ? t('settings.pleaseWait') : t('settings.twoFactor.turnOn')}</button>
      {' '}
      <button type="button" className="btn btn-sm btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
      {error && <p className="error-msg" role="alert">{error}</p>}
    </form>
  );
}

// The password and a code (the app's or a backup code), then `onConfirm(username, password,
// code)`; its result goes to `onDone`.
function ConfirmWithCode({ username, submitLabel, onConfirm, onDone, onCancel }) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      onDone(await onConfirm(username, password, code));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="account-security-form" onSubmit={submit} aria-label={submitLabel}>
      <input
        type="password"
        className="form-control"
        placeholder={t('settings.yourPassword')}
        autoComplete="current-password"
        required
        autoFocus
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <input
        className="form-control"
        placeholder={t('settings.twoFactor.codeOrBackupPlaceholder')}
        autoComplete="one-time-code"
        autoCapitalize="none"
        spellCheck={false}
        required
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <button type="submit" className="btn btn-sm btn-vc" disabled={busy}>{busy ? t('settings.pleaseWait') : submitLabel}</button>
      {' '}
      <button type="button" className="btn btn-sm btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
      {error && <p className="error-msg" role="alert">{error}</p>}
    </form>
  );
}

// The backup codes, shown once, with copy / save buttons.
function BackupCodes({ codes, username, onDone }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const text = codes.join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const download = () => {
    const file = t('settings.twoFactor.fileText', { username, codes: text });
    const url = URL.createObjectURL(new Blob([file], { type: 'text/plain' }));
    triggerDownload(url, 'voicaw-backup-codes.txt');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <div className="recovery-code-display recovery-code-panel">
      <p>{t('settings.twoFactor.backupCodesIntro', { count: codes.length })}</p>
      <ul className="recovery-code two-factor-backup-codes" aria-label={t('settings.twoFactor.backupCodes')}>
        {codes.map((code) => <li key={code}>{code}</li>)}
      </ul>
      <div className="recovery-code-buttons">
        <button type="button" className="btn btn-sm btn-vc" onClick={copy}>{copied ? t('common.copied') : t('common.copy')}</button>
        <button type="button" className="btn btn-sm btn-vc" onClick={download}>{t('settings.recoveryCode.saveAsFile')}</button>
      </div>
      <label className="recovery-confirm">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        {' '}{t('settings.twoFactor.savedThem')}
      </label>
      <button type="button" className="btn btn-vc w-100" disabled={!saved} onClick={onDone}>{t('common.done')}</button>
    </div>
  );
}
