import React, { useContext, useRef, useState, useSyncExternalStore } from 'react';
import { NavLink } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faGear } from '@fortawesome/free-solid-svg-icons';
import { ConfigContext } from '../contexts';
import { getConnectionState, onConnectionState } from '../utils/ws-client';
import VoiceControls from './voice/VoiceControls';
import { nameOf, useProfiles } from '../utils/profiles';
import Avatar from './Avatar';
import UserMenu from './UserMenu';

const STATUS_LABELS = { online: 'Online', connecting: 'Connecting…', offline: 'Offline' };

// You, at the bottom of the sidebar (like Discord): profile picture, name, and whether this
// device is connected, with mute, deafen (voice) and the settings button. Clicking the picture
// and name opens UserMenu (custom status, Edit Profile, Log out).
export default function UserPanel({ user, onLogout }) {
  useProfiles();
  const meRef = useRef(null);
  const [menuAnchor, setMenuAnchor] = useState(null);
  const { voiceEnabled } = useContext(ConfigContext);
  const status = useSyncExternalStore(onConnectionState, getConnectionState);
  if (!user) return null;

  return (
    <div className="user-panel" aria-label="You">
      <button
        type="button"
        ref={meRef}
        className={`user-panel-me${menuAnchor ? ' open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={Boolean(menuAnchor)}
        title="Your account"
        onClick={() => setMenuAnchor(menuAnchor ? null : meRef.current.getBoundingClientRect())}
      >
        <span className="user-panel-avatar status-avatar">
          <Avatar userId={user.id} />
          <span className={`status-icon user-panel-status ${status}`} role="img" aria-label={STATUS_LABELS[status]} />
        </span>
        <span className="user-panel-text">
          <span className="user-panel-name">{nameOf(user)}</span>
          <span className="user-panel-state">{STATUS_LABELS[status]}</span>
        </span>
      </button>
      {menuAnchor && (
        <UserMenu user={user} anchor={menuAnchor} trigger={meRef.current} onLogout={onLogout} onClose={() => setMenuAnchor(null)} />
      )}
      {voiceEnabled && <VoiceControls />}
      <NavLink to="/settings" className="user-panel-button user-panel-settings" aria-label="Settings" title="Settings">
        <FontAwesomeIcon icon={faGear} />
      </NavLink>
    </div>
  );
}
