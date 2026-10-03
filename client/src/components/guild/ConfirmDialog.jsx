import React, { useState } from 'react';
import Modal from './Modal';
import { errorMessage } from '../../utils/guildDisplay';
import { t } from '../../i18n';

// "Are you sure?": `onConfirm` (async) runs on the red button; its error is shown here.
// `children` go under the message; with `focusConfirm` the red button starts focused, so Enter
// confirms (Escape cancels, as always).
export default function ConfirmDialog({ title, message, confirmLabel, onConfirm, onClose, children, focusConfirm = false }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      actions={(
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-danger btn-sm" onClick={confirm} disabled={busy} autoFocus={focusConfirm}>
            {confirmLabel}
          </button>
        </>
      )}
    >
      <p>{message}</p>
      {children}
      {error && <p className="error-msg" role="alert">{error}</p>}
    </Modal>
  );
}
