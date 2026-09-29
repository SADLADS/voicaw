import React, { useState } from 'react';
import '../assets/css/recovery.css';
import { triggerDownload } from '../utils/saveFile';

// Shows a new recovery code once, with copy / save buttons, and only lets the user go on
// once they say they've kept it. `onDone` may be async (e.g. storing the code); if it fails,
// its message is shown, and `onSkip` (if given) offers a way on without the code.
export default function RecoveryCodeDisplay({ code, username, onDone, onSkip, intro, doneLabel = 'Continue' }) {
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
    const text = `Voicaw recovery code for ${username}\n\n${code}\n\n`
      + 'If you forget your password, use "Forgot password?" on the login page with this code.\n'
      + 'Keep it somewhere safe and private: anyone with it can take over your account.\n';
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    triggerDownload(url, 'voicaw-recovery-code.txt');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <div className="recovery-code-display">
      {intro && <p>{intro}</p>}
      <p>
        This is your <strong>recovery code</strong>. If you ever forget your password, it's the only
        way back into your account and your messages. Nobody else has a copy, not even the server,
        and it won't be shown again.
      </p>
      <div className="recovery-code" aria-label="Recovery code">
        {code.split('-').map((group, i, groups) => (
          <span key={i}>{group}{i < groups.length - 1 && '-'}</span>
        ))}
      </div>
      <div className="recovery-code-buttons">
        <button type="button" className="btn btn-sm btn-vc" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        <button type="button" className="btn btn-sm btn-vc" onClick={download}>Save as file</button>
      </div>
      <p className="recovery-hint">
        Save it in a password manager, or write it down and keep it somewhere safe.
      </p>
      <label className="recovery-confirm">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        {' '}I've saved my recovery code
      </label>
      <button type="button" className="btn btn-vc w-100" disabled={!saved || busy} onClick={done}>
        {busy ? 'Please wait…' : doneLabel}
      </button>
      {error && (
        <p className="recovery-error" role="alert">
          {error}
          {onSkip && (
            <>
              {' '}
              <button type="button" className="link-button" onClick={onSkip}>Skip for now</button>
            </>
          )}
        </p>
      )}
    </div>
  );
}
