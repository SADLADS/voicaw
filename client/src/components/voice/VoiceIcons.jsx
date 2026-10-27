import React from 'react';
import { Icon } from '../Icon';
import { faCameraRotate, faEarListen, faHeadphones, faMicrophone, faMicrophoneSlash, faVideo, faVideoSlash } from '@fortawesome/free-solid-svg-icons';

export function MicIcon({ muted }) {
  return <Icon icon={muted ? faMicrophoneSlash : faMicrophone} fixedWidth />;
}

export function CameraIcon({ off = false }) {
  return <Icon icon={off ? faVideoSlash : faVideo} fixedWidth />;
}

// A phone's other camera (front or back).
export function SwitchCameraIcon() {
  return <Icon icon={faCameraRotate} fixedWidth />;
}

// A bot that can hear the channel (Listen; server/permissions.js).
export function EarIcon() {
  return <Icon icon={faEarListen} fixedWidth />;
}

// Headphones, struck through when deafened (Font Awesome's free set has no such icon).
export function HeadphonesIcon({ deafened }) {
  return (
    <span className={`headphones-icon${deafened ? ' slashed' : ''}`}>
      <Icon icon={faHeadphones} fixedWidth />
    </span>
  );
}
