import React from 'react';
import { Icon } from './Icon';
import { faRobot } from '@fortawesome/free-solid-svg-icons';
import Avatar from './Avatar';
import { unblockUser, unblockWebhook, useBlocked, useBlockedWebhooks } from '../utils/blocks';
import { displayName, useProfiles } from '../utils/profiles';
import { t } from '../i18n';

// Settings → Privacy → Blocked: everyone you've blocked (utils/blocks.js), each with Unblock,
// then the webhooks you've blocked (with their guild).
export default function BlockedUsers() {
  useProfiles();
  const blocked = [...useBlocked()];
  const webhooks = useBlockedWebhooks();
  return (
    <div className="settings-card">
      <h5>{t('settings.blocked.title')}</h5>
      <p className="vc-hint">{t('settings.blocked.hint')}</p>
      {blocked.length === 0 && webhooks.length === 0 ? (
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
          {webhooks.map((hook) => (
            <li key={`webhook-${hook.id}`}>
              <span className="blocked-user-avatar blocked-webhook-icon"><Icon icon={faRobot} /></span>
              <span className="blocked-user-name">
                {hook.name}
                <span className="blocked-webhook-place vc-hint">
                  {hook.guild_name ? t('settings.blocked.webhookIn', { guild: hook.guild_name }) : t('settings.blocked.webhook')}
                </span>
              </span>
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => unblockWebhook(hook.id).catch(() => {})}>
                {t('chat.blocked.unblock')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
