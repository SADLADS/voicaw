import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMobileScreenButton } from '@fortawesome/free-solid-svg-icons';
import { statusLabel } from '../utils/presence';

// Someone's online status as a dot (styled by `className` + the status: online, mobile, idle,
// offline); a phone when they're only active on a phone.
export default function StatusIcon({ status, className, title }) {
  const label = title ?? statusLabel(status);
  return (
    <span className={`${className} ${status}`} title={label} role="img" aria-label={label}>
      {status === 'mobile' && <FontAwesomeIcon icon={faMobileScreenButton} />}
    </span>
  );
}
