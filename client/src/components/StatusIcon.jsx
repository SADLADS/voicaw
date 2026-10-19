import React from 'react';
import { Icon } from './Icon';
import { faMobileScreenButton } from '@fortawesome/free-solid-svg-icons';
import { statusLabel } from '../utils/presence';

// Someone's online status on the corner of their picture: a diamond coloured by the status
// (online, idle, offline), or a phone when they're only active on a phone. Put it next to the
// picture in a `.status-avatar`, which cuts its shape out of the picture (STATUS ICONS in
// voicaw.css).
export default function StatusIcon({ status, title }) {
  const label = title ?? statusLabel(status);
  return (
    <span className={`status-icon ${status}`} title={label} role="img" aria-label={label}>
      {status === 'mobile' && <Icon icon={faMobileScreenButton} />}
    </span>
  );
}
