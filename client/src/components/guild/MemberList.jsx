import React, { useContext, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCrown } from '@fortawesome/free-solid-svg-icons';
import defaultpfp from '../../assets/images/default.png';
import { ConfigContext } from '../../contexts';
import { banMember, kickMember, transferGuild } from '../../services/guildService';
import ConfirmDialog from './ConfirmDialog';

// The guild's members down the right (like Discord), online first, then offline. Clicking one
// opens a small card: message them, and for the owner, kick / ban / make owner.
export default function MemberList({ guild, members, user, onClose }) {
  const { s3Endpoint } = useContext(ConfigContext);
  const navigate = useNavigate();
  const [selected, setSelected] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const cardRef = useRef(null);
  const isOwner = guild.owner === user.id;

  useEffect(() => {
    if (!selected) return undefined;
    const close = (e) => {
      if (!cardRef.current?.contains(e.target) && !e.target.closest?.('.member-row')) setSelected(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [selected]);

  const online = members.filter((m) => m.online);
  const offline = members.filter((m) => !m.online);

  function renderMember(member) {
    const isSelected = selected?.id === member.id;
    return (
      <li key={member.id} className="member-item">
        <button
          type="button"
          className={`member-row${member.online ? '' : ' offline'}${isSelected ? ' selected' : ''}`}
          onClick={() => setSelected(isSelected ? null : member)}
        >
          <span className="member-avatar">
            <img
              src={s3Endpoint ? `${s3Endpoint}/profile-pics/${member.id}` : defaultpfp}
              alt=""
              onError={(e) => {
                e.currentTarget.onerror = null;
                e.currentTarget.src = defaultpfp;
              }}
            />
            <span className={`member-status${member.online ? ' online' : ''}`} />
          </span>
          <span className="member-name">{member.username}</span>
          {member.id === guild.owner && <FontAwesomeIcon icon={faCrown} className="member-owner" title="Server owner" />}
        </button>

        {isSelected && (
          <div className="member-card" ref={cardRef} role="dialog" aria-label={member.username}>
            <div className="member-card-name">{member.username}</div>
            <div className="vc-hint">Member since {new Date(member.joined_at * 1000).toLocaleDateString()}</div>
            <div className="member-card-actions">
              {member.id !== user.id && (
                <button type="button" className="btn btn-primary btn-sm vc-button" onClick={() => navigate(`/dm/${member.id}`)}>
                  Message
                </button>
              )}
              {isOwner && member.id !== user.id && (
                <>
                  <button
                    type="button"
                    className="btn btn-outline-secondary btn-sm"
                    onClick={() => setConfirm({
                      title: `Transfer ownership to ${member.username}`,
                      message: `${member.username} will own ${guild.name} and be able to manage everything, including removing you. This can't be undone by you.`,
                      confirmLabel: 'Transfer ownership',
                      onConfirm: () => transferGuild(guild.id, member.id),
                    })}
                  >
                    Make owner
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline-danger btn-sm"
                    onClick={() => setConfirm({
                      title: `Kick ${member.username}`,
                      message: `${member.username} will be removed from ${guild.name}. They can rejoin with a new invite.`,
                      confirmLabel: 'Kick',
                      onConfirm: () => kickMember(guild.id, member.id),
                    })}
                  >
                    Kick
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => setConfirm({
                      title: `Ban ${member.username}`,
                      message: `${member.username} will be removed from ${guild.name} and can't rejoin until unbanned (Server Settings).`,
                      confirmLabel: 'Ban',
                      onConfirm: () => banMember(guild.id, member.id),
                    })}
                  >
                    Ban
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </li>
    );
  }

  return (
    <aside className="member-list" aria-label="Members">
      {onClose && (
        <div className="member-list-top">
          <span>Members</span>
          <button type="button" className="vc-dialog-close" aria-label="Close members" onClick={onClose}>×</button>
        </div>
      )}
      {online.length > 0 && <h6 className="member-group">Online — {online.length}</h6>}
      <ul>{online.map(renderMember)}</ul>
      {offline.length > 0 && <h6 className="member-group">Offline — {offline.length}</h6>}
      <ul>{offline.map(renderMember)}</ul>

      {confirm && (
        <ConfirmDialog
          {...confirm}
          onConfirm={async () => {
            await confirm.onConfirm();
            setSelected(null);
          }}
          onClose={() => setConfirm(null)}
        />
      )}
    </aside>
  );
}
