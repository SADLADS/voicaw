import React, { useState } from 'react';
import Modal from './Modal';
import { cloneChannel } from '../../services/guildService';
import { errorMessage } from '../../utils/guildDisplay';
import { t } from '../../i18n';

// Duplicate Channel (from the channel menu, like Discord's Clone Channel): a new channel just
// below this one with the same type, topic, category and permissions, named as typed (the same
// name to start with). Nothing in it is copied.
export default function CloneChannelDialog({ guild, channel, onCreated, onClose }) {
  const [name, setName] = useState(channel.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const kind = ['list', 'doc', 'voice'].includes(channel.type) ? channel.type : 'text';

  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await cloneChannel(guild.id, channel.id, name);
      onCreated?.(created);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t('guildAdmin.cloneChannel.title', { name: channel.name })}
      onClose={onClose}
      actions={(
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" form="clone-channel-form" className="btn btn-primary btn-sm vc-button" disabled={busy || !name.trim()}>
            {t('guildAdmin.cloneChannel.submit')}
          </button>
        </>
      )}
    >
      <form id="clone-channel-form" onSubmit={submit}>
        <label className="vc-label" htmlFor="clone-channel-name">{t('guildAdmin.channelDialog.name')}</label>
        <input
          id="clone-channel-name"
          className="form-control"
          value={name}
          maxLength={100}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
        <p className="vc-hint mt-2">{t(`guildAdmin.cloneChannel.hint.${kind}`)}</p>
        {error && <p className="error-msg" role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
