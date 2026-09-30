import React, { useState } from 'react';
import Modal from './Modal';
import { setGuildNotifications } from '../../services/guildService';
import { errorMessage } from '../../utils/guildDisplay';

const LEVELS = [
  ['all', 'All messages', 'A notification for every message in the channels you can see.'],
  ['mentions', 'Only @mentions', 'When someone mentions you, @everyone or @here, or one of your roles.'],
  ['none', 'Nothing', 'No notifications from this server. Mentions still show in red.'],
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
      title="Notification Settings"
      onClose={onClose}
      actions={<button type="button" className="btn btn-primary btn-sm vc-button" onClick={onClose}>Done</button>}
    >
      <fieldset className="notify-levels">
        <legend className="vc-label">Server notifications</legend>
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
      <p className="vc-hint">Notifications need to be turned on for this device in Settings.</p>
      {error && <p className="error-msg" role="alert">{error}</p>}
    </Modal>
  );
}
