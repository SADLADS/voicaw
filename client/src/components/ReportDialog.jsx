import React, { useState } from 'react';
import Modal from './guild/Modal';
import { REPORT_CATEGORIES, sendReport } from '../services/reportService';
import { blockUser, isBlocked } from '../utils/blocks';
import { errorMessage } from '../utils/guildDisplay';
import { t } from '../i18n';

// Reporting a message or a person to Voicaw's admins (server/reports.js). `target`:
// { kind: 'message', place: 'guild' | 'dm' | 'group', msg, groupId? } or { kind: 'user', userId }.
// `name` is who's reported. In an encrypted chat (DM, group) the server can't read the message:
// only the reporter can choose to share its text ("Let moderators see this message", off).
export default function ReportDialog({ target, name, onClose }) {
  const [category, setCategory] = useState(null);
  const [note, setNote] = useState('');
  const [share, setShare] = useState(false);
  const reportedId = target.kind === 'message' ? target.msg.sender_id : target.userId;
  const [alsoBlock, setAlsoBlock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);
  const encrypted = target.kind === 'message' && target.place !== 'guild';
  const canBlock = reportedId != null && !isBlocked(reportedId) && !(target.kind === 'message' && target.msg.webhook_id);

  async function send(e) {
    e.preventDefault();
    if (!category) return;
    setBusy(true);
    setError(null);
    try {
      await sendReport({
        kind: target.kind,
        category,
        note: note.trim() || undefined,
        ...(target.kind === 'message'
          ? {
            place: target.place,
            messageId: target.msg.id,
            ...(target.groupId ? { groupId: target.groupId } : {}),
            ...(encrypted && share ? { sharedText: target.msg.plaintext ?? '' } : {}),
          }
          : { userId: target.userId }),
      });
      if (alsoBlock && canBlock) await blockUser(reportedId);
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const title = target.kind === 'message' ? t('chat.report.messageTitle') : t('chat.report.userTitle', { name });
  if (sent) {
    return (
      <Modal title={title} onClose={onClose} actions={<button type="button" className="btn btn-primary" onClick={onClose}>{t('common.done')}</button>}>
        <p>{t('chat.report.thanks')}</p>
      </Modal>
    );
  }
  return (
    <Modal
      title={title}
      onClose={onClose}
      className="report-dialog"
      actions={(
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" form="report-form" className="btn btn-danger" disabled={!category || busy}>{t('chat.report.send')}</button>
        </>
      )}
    >
      <form id="report-form" onSubmit={send}>
        <p className="vc-hint">{t('chat.report.intro')}</p>
        <fieldset className="report-categories">
          <legend>{t('chat.report.why')}</legend>
          {REPORT_CATEGORIES.map((c) => (
            <label key={c} className="report-category">
              <input type="radio" name="report-category" value={c} checked={category === c} onChange={() => setCategory(c)} />
              {' '}{t(`chat.report.categories.${c}`)}
            </label>
          ))}
        </fieldset>
        <label className="report-note">
          {t('chat.report.note')}
          <textarea className="form-control" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {encrypted && (
          <>
            <label className="report-share">
              <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
              {' '}{t('chat.report.share')}
            </label>
            <p className="vc-hint">{share ? t('chat.report.shareOn') : t('chat.report.shareOff')}</p>
          </>
        )}
        {canBlock && (
          <label className="report-block">
            <input type="checkbox" checked={alsoBlock} onChange={(e) => setAlsoBlock(e.target.checked)} />
            {' '}{t('chat.report.alsoBlock', { name })}
          </label>
        )}
        {error && <p className="error-msg" role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
