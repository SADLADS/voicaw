import React from 'react';
import { NavLink } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faComments,
  faUsers,
  faCalendarAlt,
  faCog,
  faSignOutAlt
} from '@fortawesome/free-solid-svg-icons';

export default function Sidebar({ onLogout }) {
  return (
    <div
      className="sidebar d-flex flex-column align-items-center"
      style={{ width: '72px', height: '100vh', backgroundColor: '#222' }}
    >
      <NavLink to="/" className="my-3" style={{ display: 'block' }}>
        <img src="/logo.svg" alt="Voicaw Logo" style={{ width: '32px', height: '32px' }} />
      </NavLink>

      <div className="nav-item my-3">
        <span className="dot"></span>
        <NavLink
          to="/dm"
          className={({ isActive }) => `nav-icon${isActive ? ' active' : ''}`}
        >
          <FontAwesomeIcon icon={faComments} />
        </NavLink>
      </div>

      <div className="nav-item my-3">
        <span className="dot"></span>
        <NavLink
          to="/plaza"
          className={({ isActive }) => `nav-icon${isActive ? ' active' : ''}`}
        >
          <FontAwesomeIcon icon={faUsers} />
        </NavLink>
      </div>

      <div className="nav-item my-3">
        <span className="dot"></span>
        <NavLink
          to="/calendar"
          className={({ isActive }) => `nav-icon${isActive ? ' active' : ''}`}
        >
          <FontAwesomeIcon icon={faCalendarAlt} />
        </NavLink>
      </div>

      <div className="nav-item my-3">
        <span className="dot"></span>
        <NavLink
          to="/settings"
          className={({ isActive }) => `nav-icon${isActive ? ' active' : ''}`}
        >
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
