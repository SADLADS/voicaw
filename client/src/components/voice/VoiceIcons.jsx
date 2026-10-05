import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faEarListen, faHeadphones, faMicrophone, faMicrophoneSlash, faVideo, faVideoSlash } from '@fortawesome/free-solid-svg-icons';

export function MicIcon({ muted }) {
  return <FontAwesomeIcon icon={muted ? faMicrophoneSlash : faMicrophone} fixedWidth />;
}

export function CameraIcon({ off = false }) {
  return <FontAwesomeIcon icon={off ? faVideoSlash : faVideo} fixedWidth />;
}

// A bot that can hear the channel (Listen; server/permissions.js).
export function EarIcon() {
  return <FontAwesomeIcon icon={faEarListen} fixedWidth />;
}

// Headphones, struck through when deafened (Font Awesome's free set has no such icon).
export function HeadphonesIcon({ deafened }) {
  return (
    <span className={`headphones-icon${deafened ? ' slashed' : ''}`}>
      <FontAwesomeIcon icon={faHeadphones} fixedWidth />
    </span>
  );
}
