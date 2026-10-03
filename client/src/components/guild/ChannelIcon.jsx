import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faFileLines, faHashtag, faListCheck, faLock, faVolumeHigh } from '@fortawesome/free-solid-svg-icons';
import { t } from '../../i18n';

const ICONS = { voice: faVolumeHigh, list: faListCheck, doc: faFileLines };

// # for a text channel, a speaker for voice, a checklist for a list, a page for documents; a
// private one gets a small lock (like Discord).
export default function ChannelIcon({ channel, className = '' }) {
  return (
    <span className={`channel-icon ${className}`} title={channel?.private ? t('guilds.channelIcon.privateChannel') : undefined}>
      <FontAwesomeIcon icon={ICONS[channel?.type] ?? faHashtag} />
      {channel?.private && <FontAwesomeIcon icon={faLock} className="channel-icon-lock" aria-label={t('guilds.channelIcon.private')} />}
    </span>
  );
}
