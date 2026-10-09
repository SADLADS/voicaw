import React, { useEffect, useState } from 'react';
import Modal from './guild/Modal';
import { MessageContent } from './MessageList';
import { summarizeAttachments } from '../utils/attachmentMarkup';
import { formatDateTime, useDateFormat } from '../utils/dateFormat';
import { t } from '../i18n';

// An edited message's versions, oldest first, ending with what it says now (Edit history in
// docs/messages.md). `loadEdits(msg)` is the chat hook's: it fetches (and in DMs and groups
// decrypts) them. Attachments show as their names: one an edit removed is deleted, so it
// can't be shown any more.
export default function EditHistoryDialog({ msg, loadEdits, onClose, user, s3Endpoint, reactionNames, mentionRoles, myRoleIds }) {
  useDateFormat();
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);

  // loadEdits is a new function every render; the message is what matters.
  useEffect(() => {
    let cancelled = false;
    loadEdits(msg)
      .then((loaded) => { if (!cancelled) setHistory(loaded); })
      .catch((err) => { if (!cancelled) setError(err.response?.data?.error || t('chat.editHistory.loadFailed')); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msg.id, msg.plaintext]);

  const versions = history && [
    ...history.versions,
    { plaintext: msg.plaintext, written_at: history.edited_at, edited: 1, current: true },
  ];

  return (
    <Modal
      title={t('chat.editHistory.title')}
      onClose={onClose}
      className="edit-history-dialog"
      actions={<button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.close')}</button>}
    >
      {error && <p className="error-msg" role="alert">{error}</p>}
      {!history && !error && <p className="vc-hint">{t('common.loading')}</p>}
      {history?.versions.length === 0 && <p className="vc-hint">{t('chat.editHistory.none')}</p>}
      {versions && (
        <ol className="edit-history-list">
          {versions.map((v, i) => (
            <li key={i} className={`edit-history-version${v.current ? ' current' : ''}`}>
              <div className="edit-history-meta">
                <strong>
                  {v.current ? t('chat.editHistory.current') : v.edited ? t('chat.editHistory.edit') : t('chat.editHistory.original')}
                </strong>
                {' '}
                {v.written_at
                  ? <small title={formatDateTime(v.written_at * 1000, { seconds: true })}>{formatDateTime(v.written_at * 1000)}</small>
                  : <small>{t('chat.editHistory.unknownTime')}</small>}
                {v.unsigned && <em className="message-signature unsigned" title={t('chat.message.unsignedTitle')}>{t('chat.message.unsigned')}</em>}
                {v.unverified && <em className="message-signature unverified" title={t('chat.message.unverifiedTitle')}>{t('chat.message.unverified')}</em>}
              </div>
              {v.plaintext == null ? (
                <p className="vc-hint">{t('chat.editHistory.unreadable')}</p>
              ) : (
                <MessageContent
                  msg={{ id: `${msg.id}-${i}`, plaintext: summarizeAttachments(v.plaintext), sender_id: msg.sender_id, timestamp: msg.timestamp }}
                  user={user}
                  s3Endpoint={s3Endpoint}
                  reactionNames={reactionNames}
                  mentionRoles={mentionRoles}
                  myRoleIds={myRoleIds}
                />
              )}
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}
