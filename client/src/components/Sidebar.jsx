import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faComments } from '@fortawesome/free-solid-svg-icons';
import logo from '../assets/images/logo-no-border.svg';

export default function Sidebar({ hasUnreadDms }) {
  const location = useLocation();

  // Helper to check if path is active (starts with)
  const isActivePath = (path) => location.pathname.startsWith(path);

  return (
    <div
      className="sidebar d-flex flex-column align-items-center"
      style={{ width: '72px' }}
    >
      <div className="nav-item">
      <NavLink to="/" className="" style={{ display: 'block' }}>
      <img src={logo} alt="Voicaw Logo" style={{ width: '50px', height: '50px' }} />

      </NavLink>
      </div>

      <div className={`nav-item ${isActivePath('/dm') ? 'active' : ''}`}>
      <span className={`dot${hasUnreadDms ? ' visible' : ''}`}></span>
        <NavLink to="/dm" className="nav-icon">
          <FontAwesomeIcon icon={faComments} />
        </NavLink>
      </div>

      {/* Guilds and a calendar are planned; their icons go here. */}

    </div>
  );
}
