import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faHashtag, faLock, faVolumeHigh } from '@fortawesome/free-solid-svg-icons';

// # for a text channel, a speaker for voice; a private one gets a small lock (like Discord).
export default function ChannelIcon({ channel, className = '' }) {
  return (
    <span className={`channel-icon ${className}`} title={channel?.private ? 'Private channel' : undefined}>
      <FontAwesomeIcon icon={channel?.type === 'voice' ? faVolumeHigh : faHashtag} />
      {channel?.private && <FontAwesomeIcon icon={faLock} className="channel-icon-lock" aria-label="Private" />}
    </span>
  );
}
