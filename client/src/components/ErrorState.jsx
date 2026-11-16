import React, { useContext, useEffect, useRef, useState } from 'react';
import { faKey, faRotateRight, faTriangleExclamation, faWifi } from '@fortawesome/free-solid-svg-icons';
import { Icon } from './Icon';
import { LayoutContext } from '../contexts';
import { describeError } from '../utils/errors';
import { connectionTrouble, useConnection } from '../utils/connection';
import { t } from '../i18n';

// The error components (Errors in docs/client.md). Each takes `error`: what was thrown (an
// axios error, an Error, or text already in words), shown through utils/errors.js, never as
// axios's own message.

// Tries again by itself once Voicaw can be reached again, if it failed for want of it.
function useRetryWhenBack(kind, onRetry) {
  const trouble = connectionTrouble(useConnection());
  const wasTrouble = useRef(trouble);
  useEffect(() => {
    if (wasTrouble.current && !trouble && kind === 'offline') onRetry?.();
    wasTrouble.current = trouble;
  }, [trouble, kind, onRetry]);
}

// A whole pane that couldn't load (a chat, a thread's list...): what failed, why, Try again,
// and Details (status, request, time) to copy into a bug report. `action` replaces Try again
// with something else that fixes it ({ label, onClick }).
export function ErrorState({ error, title, onRetry, action, className = '' }) {
  const { onLogout } = useContext(LayoutContext) ?? {};
  const [details, setDetails] = useState(false);
  const [copied, setCopied] = useState(false);
  const info = describeError(error);
  useRetryWhenBack(info.kind, onRetry);

  let heading = title ?? t('errors.titles.generic');
  let text = info.text;
  let icon = faTriangleExclamation;
  let tone = 'danger';
  let fix = action ?? (onRetry && (info.retryable || info.kind === 'device') ? { label: t('errors.tryAgain'), onClick: onRetry, retry: true } : null);
  if (info.code === 'no_keys') {
    heading = t('errors.noKeys.title');
    text = t('errors.noKeys.text');
    icon = faKey;
    tone = 'neutral';
    fix = onLogout ? { label: t('errors.noKeys.action'), onClick: onLogout } : null;
  } else if (info.code === 'offline_not_saved' || info.kind === 'offline') {
    icon = faWifi;
    tone = 'neutral';
    if (info.code === 'offline_not_saved') heading = t('errors.titles.offline');
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(info.detail);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className={`error-state ${className}`} role="alert">
      <span className={`error-state-icon ${tone}`} aria-hidden="true"><Icon icon={icon} /></span>
      <h3 className="error-state-title">{heading}</h3>
      <p className="error-state-text">{text}</p>
      {(fix || info.detail) && (
        <div className="error-state-actions">
          {fix && (
            <button type="button" className="error-state-button" onClick={fix.onClick}>
              {fix.retry && <Icon icon={faRotateRight} />}
              {fix.label}
            </button>
          )}
          {info.detail && info.code !== 'no_keys' && (
            <button type="button" className="error-state-link" aria-expanded={details} onClick={() => setDetails(!details)}>
              {t(details ? 'errors.hideDetails' : 'errors.details')}
            </button>
          )}
        </div>
      )}
      {details && info.detail && (
        <div className="error-state-details">
          <span>{info.detail}</span>
          <button type="button" onClick={copy}>{t(copied ? 'common.copied' : 'common.copy')}</button>
        </div>
      )}
    </div>
  );
}

// A list that couldn't load, in the list's place (the DM list, a thread list...).
export function InlineError({ error, title, onRetry, className = '' }) {
  const info = describeError(error);
  useRetryWhenBack(info.kind, onRetry);
  return (
    <div className={`inline-error ${className}`} role="alert">
      <Icon icon={faTriangleExclamation} />
      <div className="inline-error-body">
        <div className="inline-error-title">{title ?? t('errors.titles.generic')}</div>
        <div className="inline-error-text">{info.text}</div>
        {onRetry && info.retryable && (
          <button type="button" className="inline-error-retry" onClick={onRetry}>{t('errors.tryAgain')}</button>
        )}
      </div>
    </div>
  );
}

// A form that didn't go through: what didn't happen (`title`, optional) and why.
export function FormError({ error, title, className = '' }) {
  if (!error) return null;
  const text = describeError(error).text;
  return (
    <div className={`form-error ${className}`} role="alert">
      <Icon icon={faTriangleExclamation} />
      <div>
        {title && <div className="form-error-title">{title}</div>}
        <div className="form-error-text">{text}</div>
      </div>
    </div>
  );
}
