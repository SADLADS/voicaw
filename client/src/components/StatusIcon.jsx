import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMobileScreenButton } from '@fortawesome/free-solid-svg-icons';
import { statusLabel } from '../utils/presence';

// Someone's online status on the corner of their picture (the parent must be position:
// relative): a diamond coloured by the status (online, idle, offline), or a phone when they're
// only active on a phone. Styles: STATUS ICONS in voicaw.css.
export default function StatusIcon({ status, title }) {
  const label = title ?? statusLabel(status);
  return (
    <span className={`status-icon ${status}`} title={label} role="img" aria-label={label}>
      {status === 'mobile' && <FontAwesomeIcon icon={faMobileScreenButton} />}
    </span>
  );
}
