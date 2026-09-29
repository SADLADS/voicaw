import React, { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faComments, faPlus } from '@fortawesome/free-solid-svg-icons';
import logo from '../assets/images/logo-no-border.svg';
import GuildIcon from './guild/GuildIcon';
import '../assets/css/guilds.css';
import AddGuildDialog from './guild/AddGuildDialog';

// The server rail down the left (like Discord's): home, DMs, then each guild (a pill on the
// left marks unread messages, a taller one the open guild), then "+" to create or join one.
// `unreadGuildIds` is a Set of guild ids with unread messages.
export default function Sidebar({ hasUnreadDms, guilds = [], unreadGuildIds = new Set() }) {
  const location = useLocation();
  const [adding, setAdding] = useState(false);

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
        <NavLink to="/dm" className="nav-icon" aria-label="Direct Messages" title="Direct Messages">
          <FontAwesomeIcon icon={faComments} />
        </NavLink>
      </div>

      {guilds.length > 0 && <div className="rail-separator" />}

      <nav className="rail-guilds" aria-label="Servers">
        {guilds.map((guild) => (
          <div key={guild.id} className={`nav-item ${isActivePath(`/guild/${guild.id}/`) || location.pathname === `/guild/${guild.id}` ? 'active' : ''}`}>
            <span className={`dot${unreadGuildIds.has(guild.id) ? ' visible' : ''}`}></span>
            <NavLink to={`/guild/${guild.id}`} className="nav-icon rail-guild" aria-label={guild.name} title={guild.name}>
              <GuildIcon guild={guild} />
            </NavLink>
          </div>
        ))}
      </nav>

      <div className="nav-item">
        <button type="button" className="nav-icon rail-add" aria-label="Add a server" title="Add a server" onClick={() => setAdding(true)}>
          <FontAwesomeIcon icon={faPlus} />
        </button>
      </div>

      {/* A calendar is planned; its icon goes here. */}

      {adding && <AddGuildDialog onClose={() => setAdding(false)} />}
    </div>
  );
}
