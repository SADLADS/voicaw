import React, { useContext, useState } from 'react';
import { ConfigContext } from '../../contexts';
import { guildInitials } from '../../utils/guildDisplay';

// A guild's picture: its icon if it has one, otherwise its initials (like Discord).
export default function GuildIcon({ guild, className = '' }) {
  const { s3Endpoint } = useContext(ConfigContext);
  const [failed, setFailed] = useState(null);
  const src = guild.icon_version > 0 && s3Endpoint
    ? `${s3Endpoint}/guild-icons/${guild.id}?v=${guild.icon_version}`
    : null;

  if (src && failed !== src) {
    return <img className={`guild-icon ${className}`} src={src} alt={guild.name} draggable={false} onError={() => setFailed(src)} />;
  }
  return (
    <span className={`guild-icon guild-initials ${className}`} aria-label={guild.name}>
      {guildInitials(guild.name)}
    </span>
  );
}
