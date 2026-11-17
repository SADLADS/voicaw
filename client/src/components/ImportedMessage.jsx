import React from 'react';
import { faBoxArchive } from '@fortawesome/free-solid-svg-icons';
import { Icon } from './Icon';
import ProfileBanner from './ProfileBanner';
import { t } from '../i18n';
import { displayName, useProfiles } from '../utils/profiles';
import { formatLongDate, useDateFormat } from '../utils/dateFormat';
import { ReactionEmoji } from './MessageReactions';

// Messages from a history import (docs/guilds.md, History imports; the server adds `imported`
// to each, server/guildImports.js decorateImported). The tag's word is the importer's own label
// ("Discord"...), or "Imported"; its look and the note behind it are always the app's, so no
// label can hide that the message was imported or claim it's verified.

// The tag after the author's name, with the note (on hover, or a tap on a phone).
export function ImportTag({ imported, authorName }) {
  useDateFormat();
  useProfiles();
  if (!imported) return null;
  const importer = imported.importer_id != null ? displayName(imported.importer_id) : t('chat.imported.someone');
  const date = imported.imported_at ? formatLongDate(imported.imported_at * 1000) : null;
  const from = imported.source_channel_name && imported.source_guild_name
    ? t('chat.imported.fromChannel', { channel: imported.source_channel_name, guild: imported.source_guild_name })
    : imported.source_guild_name
      ? t('chat.imported.fromGuild', { guild: imported.source_guild_name })
      : t('chat.imported.fromArchive');
  return (
    <span className="import-tag" tabIndex={0} onClick={(e) => e.stopPropagation()}>
      <Icon icon={faBoxArchive} />
      <span className="import-tag-label">{imported.label || t('chat.imported.tag')}</span>
      <span className="import-tag-popover" role="tooltip">
        <strong>{t('chat.imported.title')}</strong>
        <span>{from}</span>
        <span>{date ? t('chat.imported.byOn', { name: importer, date }) : t('chat.imported.by', { name: importer })}</span>
        <span>{t('chat.imported.disclaimer')}</span>
        {imported.author?.mapped && authorName && (
          <span>{t('chat.imported.linked', { name: authorName, importer })}</span>
        )}
      </span>
    </span>
  );
}

// An unlinked author's picture: the archive's (stored by the import, on our own server) or
// their initial.
export function ImportedAvatar({ name, src, className = '', ...rest }) {
  if (src) return <img className={className} src={src} alt={name} draggable={false} {...rest} />;
  return (
    <span className={`${className} imported-avatar-initial`} role="img" aria-label={name} {...rest}>
      {Array.from(name?.trim() || '?')[0].toUpperCase()}
    </span>
  );
}

// Their card (from the name or picture): no account behind it.
export function ImportedAuthorCard({ author }) {
  return (
    <div className="profile-card imported-author-card">
      <ProfileBanner src={null} color={null} className="profile-card-banner" />
      <div className="profile-card-top">
        <span className="profile-card-avatar">
          <ImportedAvatar name={author.name} src={author.avatar} />
        </span>
        <div className="profile-card-names">
          <span className="profile-card-name">{author.name}</span>{' '}
          <ImportTag imported={author.imported} />
        </div>
      </div>
      <div className="profile-card-section">
        <p className="profile-card-bio">{t('chat.imported.authorAbout')}</p>
      </div>
    </div>
  );
}

// The archive's reactions: read-only chips with their counts, whose names (members' as they
// are now, the rest as the archive had them) show on hover.
export function ImportedReactions({ reactions }) {
  useProfiles();
  if (!reactions?.length) return null;
  return (
    <div className="message-reactions imported-reactions" aria-label={t('chat.imported.reactions')}>
      {reactions.map((r) => {
        const names = (r.users ?? []).map((u) => (u.user_id != null ? displayName(u.user_id) : u.name));
        return (
          <span
            key={r.emoji}
            className="reaction-chip imported-reaction"
            title={names.length ? t('chat.imported.reactedBy', { names: names.join(', ') }) : t('chat.imported.reactionsTitle')}
          >
            <ReactionEmoji native={r.emoji} />
            <span className="reaction-count">{r.count}</span>
          </span>
        );
      })}
    </div>
  );
}
