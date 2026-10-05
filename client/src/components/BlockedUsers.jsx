import React from 'react';
import Avatar from './Avatar';
import { unblockUser, useBlocked } from '../utils/blocks';
import { displayName, useProfiles } from '../utils/profiles';
import { t } from '../i18n';

// Settings → Privacy → Blocked: everyone you've blocked (utils/blocks.js), each with Unblock.
export default function BlockedUsers() {
  useProfiles();
  const blocked = [...useBlocked()];
  return (
    <div className="settings-card">
      <h5>{t('settings.blocked.title')}</h5>
      <p className="vc-hint">{t('settings.blocked.hint')}</p>
      {blocked.length === 0 ? (
        <p className="vc-hint">{t('settings.blocked.none')}</p>
      ) : (
        <ul className="blocked-users">
          {blocked.map((id) => (
            <li key={id}>
              <Avatar userId={id} className="blocked-user-avatar" />
              <span className="blocked-user-name">{displayName(id, t('settings.blocked.someone'))}</span>
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => unblockUser(id).catch(() => {})}>
                {t('chat.blocked.unblock')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
