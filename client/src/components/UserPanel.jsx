import React, { useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { NavLink } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faGear } from '@fortawesome/free-solid-svg-icons';
import defaultpfp from '../assets/images/default.png';
import { ConfigContext } from '../contexts';
import { getConnectionState, onConnectionState } from '../utils/ws-client';
import { onProfilePictureChange } from '../utils/profilePicture';
import VoiceControls from './voice/VoiceControls';
import { nameOf, useProfiles } from '../utils/profiles';

const STATUS_LABELS = { online: 'Online', connecting: 'Connecting…', offline: 'Offline' };

// You, at the bottom of the sidebar (like Discord): profile picture, name, and whether this
// device is connected, with mute, deafen (voice) and the settings button.
export default function UserPanel({ user }) {
  useProfiles();
  const { s3Endpoint, voiceEnabled } = useContext(ConfigContext);
  const status = useSyncExternalStore(onConnectionState, getConnectionState);
  // Bumped when a new picture is uploaded, to skip the browser's cached one.
  const [pictureVersion, setPictureVersion] = useState(0);
  const [pictureFailed, setPictureFailed] = useState(false);

  useEffect(() => onProfilePictureChange(() => {
    setPictureFailed(false);
    setPictureVersion(Date.now());
  }), []);

  if (!user) return null;
  const picture = pictureFailed || !s3Endpoint
    ? defaultpfp
    : `${s3Endpoint}/profile-pics/${user.id}${pictureVersion ? `?v=${pictureVersion}` : ''}`;

  return (
    <div className="user-panel" aria-label="You">
      <div className="user-panel-avatar">
        <img src={picture} alt="" onError={() => setPictureFailed(true)} />
        <span className={`user-panel-status ${status}`} role="img" aria-label={STATUS_LABELS[status]} />
      </div>
      <div className="user-panel-text">
        <span className="user-panel-name">{nameOf(user)}</span>
        <span className="user-panel-state">{STATUS_LABELS[status]}</span>
      </div>
      {voiceEnabled && <VoiceControls />}
      <NavLink to="/settings" className="user-panel-button" aria-label="User settings" title="User settings">
        <FontAwesomeIcon icon={faGear} />
      </NavLink>
    </div>
  );
}
