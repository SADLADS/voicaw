import React, { useState } from 'react';
import Modal from './Modal';
import { errorMessage } from '../../utils/guildDisplay';

// "Are you sure?": `onConfirm` (async) runs on the red button; its error is shown here.
export default function ConfirmDialog({ title, message, confirmLabel, onConfirm, onClose }) {
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
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-danger btn-sm" onClick={confirm} disabled={busy}>{confirmLabel}</button>
        </>
      )}
    >
      <p>{message}</p>
      {error && <p className="error-msg" role="alert">{error}</p>}
    </Modal>
  );
}
