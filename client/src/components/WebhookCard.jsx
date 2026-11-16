import React from 'react';
import ProfileBanner from './ProfileBanner';
import defaultAvatar from '../assets/images/default.png';
import { t } from '../i18n';

// A webhook's card (ProfilePopover, from a webhook message's name or picture): the picture and
// name that message was sent with, its APP tag and what a webhook is. There's no account behind
// it, so no full profile, status or bio. `webhook` is { id, name, avatar }. The picture may be
// another site's (a webhook's avatar_url): no referrer, as in the message. Its right-click menu
// blocks it (PageMenus, from the data-webhook-* attributes).
export default function WebhookCard({ webhook }) {
  const marks = { 'data-webhook-id': webhook.id, 'data-webhook-name': webhook.name };
  return (
    <div className="profile-card webhook-card">
      <ProfileBanner src={null} color={null} className="profile-card-banner" />
      <div className="profile-card-top">
        <span className="profile-card-avatar">
          <img
            src={webhook.avatar || defaultAvatar}
            alt={t('app.profile.picture', { name: webhook.name })}
            referrerPolicy="no-referrer"
            draggable={false}
            onError={(e) => { e.currentTarget.src = defaultAvatar; }}
            {...marks}
          />
        </span>
        <div className="profile-card-names">
          <span className="profile-card-name" {...marks}>{webhook.name}</span>{' '}
          <span className="app-tag" title={t('chat.message.webhookTitle')}>{t('chat.message.webhookTag')}</span>
        </div>
      </div>
      <div className="profile-card-section">
        <p className="profile-card-bio">{t('app.profile.webhookAbout')}</p>
      </div>
    </div>
  );
}
