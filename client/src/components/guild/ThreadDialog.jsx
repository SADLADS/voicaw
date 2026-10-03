import React, { useState } from 'react';
import Modal from './Modal';
import { createThread, updateThread } from '../../services/guildService';
import { errorMessage } from '../../utils/guildDisplay';
import { summarizeAttachments } from '../../utils/attachmentMarkup';
import { customEmojiToText } from '../../emoji/customEmoji';
import { t } from '../../i18n';

const MAX_NAME = 100;
// How much of a message a thread's suggested name takes.
const SUGGESTED_LENGTH = 40;

// A name to suggest for a thread started from `msg`: the start of what it says.
function suggestedName(msg) {
  const text = customEmojiToText(summarizeAttachments(msg?.plaintext ?? '')).replace(/\s+/g, ' ').trim();
  return text.length > SUGGESTED_LENGTH ? `${text.slice(0, SUGGESTED_LENGTH - 1)}…` : text;
}

// Starting a thread in `channel` (from message `message`, or on its own), or renaming `thread`.
// `onDone(thread)` gets the new or renamed thread.
export default function ThreadDialog({ channel, message = null, thread = null, onDone, onClose }) {
  const renaming = Boolean(thread);
  const [name, setName] = useState(() => (renaming ? thread.name : suggestedName(message)));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function save(e) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const saved = renaming
        ? await updateThread(thread.id, { name: trimmed })
        : await createThread(channel.id, trimmed, message?.id ?? null);
      onDone?.(saved);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={renaming ? t('guilds.threads.rename') : t('guilds.threads.create')}
      onClose={onClose}
      actions={(
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" form="thread-form" className="btn btn-primary btn-sm vc-button" disabled={busy || !name.trim()}>
            {renaming ? t('common.save') : t('guilds.threads.create')}
          </button>
        </>
      )}
    >
      <form id="thread-form" className="vc-form" onSubmit={save}>
        {!renaming && (
          <p className="vc-hint">
            {message
              ? t('guilds.threads.dialogHintMessage', { name: channel.name })
              : t('guilds.threads.dialogHint', { name: channel.name })}
          </p>
        )}
        <label htmlFor="thread-name">{t('guilds.threads.nameLabel')}</label>
        <input
          id="thread-name"
          className="form-control"
          maxLength={MAX_NAME}
          placeholder={t('guilds.threads.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        {error && <p className="error-text">{error}</p>}
      </form>
    </Modal>
  );
}
