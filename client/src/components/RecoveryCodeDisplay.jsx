import React, { useState } from 'react';
import '../assets/css/recovery.css';
import { triggerDownload } from '../utils/saveFile';
import { Trans } from 'react-i18next';
import { t } from '../i18n';

// Shows a new recovery code once, with copy / save buttons, and only lets the user go on
// once they say they've kept it. `onDone` may be async (e.g. storing the code); if it fails,
// its message is shown, and `onSkip` (if given) offers a way on without the code.
export default function RecoveryCodeDisplay({ code, username, onDone, onSkip, intro, doneLabel = t('settings.recoveryCode.continue') }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const done = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const download = () => {
    const text = t('settings.recoveryCode.fileText', { username, code });
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    triggerDownload(url, 'voicaw-recovery-code.txt');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <div className="recovery-code-display">
      {intro && <p>{intro}</p>}
      <p>
        <Trans i18nKey="settings.recoveryCode.explanation" components={{ b: <strong /> }} />
      </p>
      <div className="recovery-code" aria-label={t('settings.recoveryCode.title')}>
        {code.split('-').map((group, i, groups) => (
          <span key={i}>{group}{i < groups.length - 1 && '-'}</span>
        ))}
      </div>
      <div className="recovery-code-buttons">
        <button type="button" className="btn btn-sm btn-vc" onClick={copy}>{copied ? t('common.copied') : t('common.copy')}</button>
        <button type="button" className="btn btn-sm btn-vc" onClick={download}>{t('settings.recoveryCode.saveAsFile')}</button>
      </div>
      <p className="recovery-hint">
        {t('settings.recoveryCode.keepItSafe')}
      </p>
      <label className="recovery-confirm">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        {' '}{t('settings.recoveryCode.savedIt')}
      </label>
      <button type="button" className="btn btn-vc w-100" disabled={!saved || busy} onClick={done}>
        {busy ? t('settings.pleaseWait') : doneLabel}
      </button>
      {error && (
        <p className="recovery-error" role="alert">
          {error}
          {onSkip && (
            <>
              {' '}
              <button type="button" className="link-button" onClick={onSkip}>{t('settings.recoveryCode.skip')}</button>
            </>
          )}
        </p>
      )}
    </div>
  );
}
