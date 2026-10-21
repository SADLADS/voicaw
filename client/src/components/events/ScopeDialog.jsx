import React, { useState } from 'react';
import Modal from '../guild/Modal';
import { formatEventWhen } from '../../utils/eventDisplay';
import { errorMessage } from '../../utils/guildDisplay';
import { t } from '../../i18n';

const SCOPES = ['this', 'following', 'all'];

// Which dates of a repeating event an edit or a cancel is for, as calendars ask: this event (the
// occurrence `view`, occurrenceView's), this and following ones, or all of them. `kind`: 'edit'
// or 'cancel'. `onChoose(scope)` (async for a cancel, whose error shows here).
export default function ScopeDialog({ kind, view, onChoose, onClose }) {
  const [scope, setScope] = useState('this');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const cancelling = kind === 'cancel';

  async function choose() {
    setBusy(true);
    setError(null);
    try {
      await onChoose(scope);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t(cancelling ? 'events.confirm.scope.cancelTitle' : 'events.confirm.scope.editTitle')}
      className="event-scope-dialog"
      onClose={onClose}
      actions={(
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>{t('events.editor.back')}</button>
          <button type="button" className={`btn btn-sm ${cancelling ? 'btn-danger' : 'btn-primary vc-button'}`} onClick={choose} disabled={busy}>
            {t(cancelling ? 'events.confirm.scope.cancelConfirm' : 'events.confirm.scope.continue')}
          </button>
        </>
      )}
    >
      <fieldset className="event-scope-choice">
        <legend>{t('events.confirm.scope.question', { name: view.name })}</legend>
        {SCOPES.map((key) => (
          <label key={key} className="event-editor-check">
            <input type="radio" name="event-scope" value={key} checked={scope === key} onChange={() => setScope(key)} />
            {key === 'this' ? t('events.confirm.scope.this', { date: formatEventWhen(view) }) : t(`events.confirm.scope.${key}`)}
          </label>
        ))}
      </fieldset>
      {cancelling && <p className="vc-hint">{t('events.confirm.scope.cancelHint')}</p>}
      {error && <p className="error-msg" role="alert">{error}</p>}
    </Modal>
  );
}
