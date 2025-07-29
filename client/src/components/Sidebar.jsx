import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faComments,
  faUsers,
  faCalendarAlt,
  faCog,
  faSignOutAlt
} from '@fortawesome/free-solid-svg-icons';

export default function Sidebar({ onLogout, hasUnreadDms }) {
  const location = useLocation();

  // Helper to check if path is active (starts with)
  const isActivePath = (path) => location.pathname.startsWith(path);

  return (
    <div
      className="sidebar d-flex flex-column align-items-center"
      style={{ width: '72px', height: '100vh' }}
    >
      <NavLink to="/" className="my-3" style={{ display: 'block' }}>
        <img src="/logo-white.svg" alt="Voicaw Logo" style={{ width: '50px', height: '50px' }} />
      </NavLink>

      <div className={`nav-item my-3 ${isActivePath('/dm') ? 'active' : ''}`}>
      <span className={`dot${hasUnreadDms ? ' visible' : ''}`}></span>
        <NavLink to="/dm" className="nav-icon">
          <FontAwesomeIcon icon={faComments} />
        </NavLink>
      </div>

      <div className={`nav-item my-3 ${isActivePath('/plaza') ? 'active' : ''}`}>
        <span className="dot"></span>
        <NavLink to="/plaza" className="nav-icon">
          <FontAwesomeIcon icon={faUsers} />
        </NavLink>
      </div>

      <div className={`nav-item my-3 ${isActivePath('/calendar') ? 'active' : ''}`}>
        <span className="dot"></span>
        <NavLink to="/calendar" className="nav-icon">
          <FontAwesomeIcon icon={faCalendarAlt} />
        </NavLink>
      </div>

      <div className={`nav-item my-3 ${isActivePath('/settings') ? 'active' : ''}`}>
        <span className="dot"></span>
        <NavLink to="/settings" className="nav-icon">
          <FontAwesomeIcon icon={faCog} />
        </NavLink>
      </div>

      <div className="mt-auto mb-4">
        <button onClick={onLogout} className="btn btn-sm btn-danger" title="Logout">
          <FontAwesomeIcon icon={faSignOutAlt} />
        </button>
      </div>
    </div>
  );
}
