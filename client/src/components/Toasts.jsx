import React from 'react';
import { faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';
import { Icon } from './Icon';
import { dismissToast, useToasts } from '../services/toasts';
import { t } from '../i18n';

// The toasts services/toasts.js holds, stacked above the message box.
export default function Toasts() {
  const toasts = useToasts();
  if (!toasts.length) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          <span className="toast-icon" aria-hidden="true"><Icon icon={faTriangleExclamation} /></span>
          <div className="toast-body">
            <div className="toast-title">{toast.title}</div>
            <div className="toast-text">{toast.text}</div>
          </div>
          {toast.onRetry && (
            <button
              type="button"
              className="toast-retry"
              onClick={() => { dismissToast(toast.id); toast.onRetry(); }}
            >
              {t('errors.tryAgain')}
            </button>
          )}
          <button type="button" className="toast-close" onClick={() => dismissToast(toast.id)} aria-label={t('common.close')}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
