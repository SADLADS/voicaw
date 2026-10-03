import React, { useState } from 'react';
import Modal from './Modal';
import { setGuildNotifications } from '../../services/guildService';
import { errorMessage } from '../../utils/guildDisplay';
import { t } from '../../i18n';

const LEVELS = [
  ['all', t('guildAdmin.notifyLevels.all.label'), t('guildAdmin.notifyLevels.all.hint')],
  ['mentions', t('guildAdmin.notifyLevels.mentions.label'), t('guildAdmin.notifyLevels.mentions.hint')],
  ['none', t('guildAdmin.notifyLevels.none.label'), t('guildAdmin.notifyLevels.none.hint')],
];

// Your notification level for the guild (all messages, only mentions, nothing): which of its
// messages push to your devices. Saved as soon as it's picked.
export default function NotificationDialog({ guild, onClose }) {
  const [level, setLevel] = useState(guild.my_notify_level ?? 'mentions');
  const [error, setError] = useState(null);

  async function pick(next) {
    const before = level;
    setLevel(next);
    setError(null);
    try {
      await setGuildNotifications(guild.id, next);
    } catch (err) {
      setLevel(before);
      setError(errorMessage(err));
    }
  }

  return (
    <Modal
      title={t('guildAdmin.guildMenu.notifications')}
      onClose={onClose}
      actions={<button type="button" className="btn btn-primary btn-sm vc-button" onClick={onClose}>{t('common.done')}</button>}
    >
      <fieldset className="notify-levels">
        <legend className="vc-label">{t('guildAdmin.notifications.legend')}</legend>
        {LEVELS.map(([value, label, hint]) => (
          <label key={value} className="role-toggle">
            <input type="radio" name="notify-level" value={value} checked={level === value} onChange={() => pick(value)} />
            <span>
              <strong>{label}</strong>
              <small className="vc-hint">{hint}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="vc-hint">{t('guildAdmin.notifications.deviceHint')}</p>
      {error && <p className="error-msg" role="alert">{error}</p>}
    </Modal>
  );
}
