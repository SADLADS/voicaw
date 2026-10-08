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
import { t } from '../i18n';

const STATUS_LABELS = {
  online: 'app.connection.online',
  connecting: 'app.connection.connecting',
  offline: 'app.connection.offline',
};

// You, at the bottom of the sidebar (like Discord): profile picture, name, and whether this
// device is connected, with mute, deafen (voice) and the settings button. Clicking the picture
// and name opens UserMenu (custom status, Edit Profile, Copy User ID, Log out); right-clicking
// them opens nothing.
export default function UserPanel({ user, onLogout }) {
  useProfiles();
  const meRef = useRef(null);
  const [menuAnchor, setMenuAnchor] = useState(null);
  const { voiceEnabled } = useContext(ConfigContext);
  const status = useSyncExternalStore(onConnectionState, getConnectionState);
  if (!user) return null;

  return (
    <div className="user-panel" aria-label={t('app.userPanel.you')}>
      <button
        type="button"
        ref={meRef}
        className={`user-panel-me${menuAnchor ? ' open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={Boolean(menuAnchor)}
        title={t('app.userMenu.yourAccount')}
        onClick={() => setMenuAnchor(menuAnchor ? null : meRef.current.getBoundingClientRect())}
        onContextMenu={(e) => e.preventDefault()}
      >
        <span className="user-panel-avatar status-avatar">
          <Avatar userId={user.id} />
          <span className={`status-icon user-panel-status ${status}`} role="img" aria-label={t(STATUS_LABELS[status])} />
        </span>
        <span className="user-panel-text">
          <span className="user-panel-name">{nameOf(user)}</span>
          <span className="user-panel-state">{t(STATUS_LABELS[status])}</span>
        </span>
      </button>
      {menuAnchor && (
        <UserMenu user={user} anchor={menuAnchor} trigger={meRef.current} onLogout={onLogout} onClose={() => setMenuAnchor(null)} />
      )}
      {voiceEnabled && <VoiceControls />}
      <NavLink to="/settings" className="user-panel-button user-panel-settings" aria-label={t('common.settings')} title={t('common.settings')}>
        <FontAwesomeIcon icon={faGear} />
      </NavLink>
    </div>
  );
}
