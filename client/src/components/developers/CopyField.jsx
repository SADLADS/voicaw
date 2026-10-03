import React, { useEffect, useState } from 'react';
import { t } from '../../i18n';

// A read-only value (an id, a token, a link) with a Copy button.
export default function CopyField({ id, value, label, secret = false }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setCopied(false);
  }, [value]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  return (
    <>
      {label && <label htmlFor={id}>{label}</label>}
      <div className="vc-form-row dev-copy-field">
        <input
          id={id}
          className={`form-control${secret ? ' dev-secret' : ''}`}
          readOnly
          value={value}
          onFocus={(e) => e.target.select()}
          spellCheck={false}
        />
        <button type="button" className="btn btn-primary vc-button" onClick={copy}>
          {copied ? t('common.copied') : t('common.copy')}
        </button>
      </div>
      {failed && <p className="error-msg" role="alert">{t('developers.copyFailed')}</p>}
    </>
  );
}
