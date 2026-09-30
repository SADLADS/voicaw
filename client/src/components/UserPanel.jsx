import React, { useContext, useSyncExternalStore } from 'react';
import { NavLink } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faGear } from '@fortawesome/free-solid-svg-icons';
import { ConfigContext } from '../contexts';
import { getConnectionState, onConnectionState } from '../utils/ws-client';
import VoiceControls from './voice/VoiceControls';
import { nameOf, useProfiles } from '../utils/profiles';
import Avatar from './Avatar';

const STATUS_LABELS = { online: 'Online', connecting: 'Connecting…', offline: 'Offline' };

// You, at the bottom of the sidebar (like Discord): profile picture, name, and whether this
// device is connected, with mute, deafen (voice) and the settings button.
export default function UserPanel({ user }) {
  useProfiles();
  const { voiceEnabled } = useContext(ConfigContext);
  const status = useSyncExternalStore(onConnectionState, getConnectionState);
  if (!user) return null;

  return (
    <div className="user-panel" aria-label="You">
      <div className="user-panel-avatar">
        <Avatar userId={user.id} />
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
