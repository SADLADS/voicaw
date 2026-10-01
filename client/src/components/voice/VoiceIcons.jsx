import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faHeadphones, faMicrophone, faMicrophoneSlash } from '@fortawesome/free-solid-svg-icons';

export function MicIcon({ muted }) {
  return <FontAwesomeIcon icon={muted ? faMicrophoneSlash : faMicrophone} fixedWidth />;
}

// Headphones, struck through when deafened (Font Awesome's free set has no such icon).
export function HeadphonesIcon({ deafened }) {
  return (
    <span className={`headphones-icon${deafened ? ' slashed' : ''}`}>
      <FontAwesomeIcon icon={faHeadphones} fixedWidth />
    </span>
  );
}
