import React, { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faComments, faPlus } from '@fortawesome/free-solid-svg-icons';
import logo from '../assets/images/logo-no-border.svg';
import GuildIcon from './guild/GuildIcon';
import '../assets/css/guilds.css';
import AddGuildDialog from './guild/AddGuildDialog';
import { useDragReorder } from '../hooks/useDragReorder';

// The server rail down the left (like Discord's): home, DMs, then each guild (a pill on the
// left marks unread messages, a taller one the open guild), then "+" to create or join one.
// `unreadGuildIds` is a Set of guild ids with unread messages, `guildMentions` ({ guildId:
// count }) how many of them mention you (a red badge on the icon). Guilds can be dragged into a
// new order (hold, then drag, on touch screens); `onReorderGuilds(ids)` saves it.
export default function Sidebar({ hasUnreadDms, guilds = [], unreadGuildIds = new Set(), guildMentions = {}, onReorderGuilds }) {
  const location = useLocation();
  const [adding, setAdding] = useState(false);
  const { drag, itemProps } = useDragReorder(guilds.map((g) => g.id), (ids) => onReorderGuilds?.(ids));
  // While dragging, the others make room where it will land.
  const dragFrom = drag ? guilds.findIndex((g) => g.id === drag.id) : -1;

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

      <nav className={`rail-guilds${drag ? ' reordering' : ''}`} aria-label="Servers">
        {guilds.map((guild, index) => {
          const dragging = drag?.id === guild.id;
          // Items between where it was and where it's going shift by one slot.
          let shift = 0;
          if (drag && !dragging) {
            if (index > dragFrom && index <= drag.targetIndex) shift = -1;
            else if (index < dragFrom && index >= drag.targetIndex) shift = 1;
          }
          return (
            <div
              key={guild.id}
              className={`nav-item${isActivePath(`/guild/${guild.id}/`) || location.pathname === `/guild/${guild.id}` ? ' active' : ''}${dragging ? ' dragging' : ''}`}
              style={dragging ? { transform: `translateY(${drag.dy}px)` } : shift ? { transform: `translateY(${shift * 100}%) translateY(${shift * 16}px)` } : undefined}
              {...itemProps(guild.id)}
            >
              <span className={`dot${unreadGuildIds.has(guild.id) ? ' visible' : ''}`}></span>
              <NavLink to={`/guild/${guild.id}`} className="nav-icon rail-guild" aria-label={guild.name} title={guild.name} draggable={false}>
                <GuildIcon guild={guild} />
              </NavLink>
              {guildMentions[guild.id] > 0 && (
                <span className="mention-badge rail-mention-badge" aria-label={`${guildMentions[guild.id]} mentions`}>
                  {guildMentions[guild.id] > 99 ? '99+' : guildMentions[guild.id]}
                </span>
              )}
            </div>
          );
        })}
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
