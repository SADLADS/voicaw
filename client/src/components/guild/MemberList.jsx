import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCrown, faPlus, faXmark } from '@fortawesome/free-solid-svg-icons';
import { banMember, kickMember, setMemberRoles, transferGuild } from '../../services/guildService';
import { PERMISSIONS, colorToHex, has, memberColor, memberRank, memberRoles } from '../../utils/permissions';
import { errorMessage, groupMembers } from '../../utils/guildDisplay';
import ConfirmDialog from './ConfirmDialog';
import StatusIcon from '../StatusIcon';
import { usePresence } from '../../hooks/usePresence';
import { formatDate } from '../../utils/dateFormat';
import { getProfile, nameOf, useProfiles } from '../../utils/profiles';
import ProfileCard from '../ProfileCard';
import Avatar from '../Avatar';

// The guild's members down the right (like Discord), names in their role colour. Clicking one
// opens a card: their roles (added and removed there by people who manage roles, for roles
// below their own), Message, and, as permissions and rank allow, Make owner / Kick / Ban.
export default function MemberList({ guild, members: memberList, user, onClose }) {
  useProfiles();
  const presenceOf = usePresence();
  const members = memberList.map((m) => ({ ...m, ...presenceOf(m) }));
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [addingRole, setAddingRole] = useState(false);
  const [error, setError] = useState(null);
  const cardRef = useRef(null);

  const me = members.find((m) => m.id === user.id);
  const myRank = memberRank(guild, user.id, me?.role_ids);
  const can = (bit) => has(guild.my_permissions, bit);
  const selected = members.find((m) => m.id === selectedId) ?? null;

  useEffect(() => {
    setAddingRole(false);
    setError(null);
    if (selectedId == null) return undefined;
    const close = (e) => {
      if (!cardRef.current?.contains(e.target) && !e.target.closest?.('.member-row')) setSelectedId(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [selectedId]);

  // Whether you outrank `member` (or it's you, for roles).
  const outranks = (member) => member.id !== guild.owner && myRank > memberRank(guild, member.id, member.role_ids);

  async function changeRoles(member, roleIds) {
    setError(null);
    try {
      await setMemberRoles(guild.id, member.id, roleIds);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function renderCard(member) {
    const roles = memberRoles(guild.roles, member.role_ids);
    const editsRoles = can(PERMISSIONS.MANAGE_ROLES) && (member.id === user.id || outranks(member));
    const assignable = (guild.roles ?? []).filter((r) => !r.is_everyone && r.position < myRank && !member.role_ids?.includes(r.id));
    const isOwnerViewing = guild.owner === user.id;
    return (
      <div className="member-card" ref={cardRef} role="dialog" aria-label={nameOf(member)}>
        <ProfileCard user={member} color={memberColor(guild.roles, member.role_ids) ?? undefined} />
        <div className="vc-hint">Member since {formatDate(member.joined_at * 1000)}</div>

        {(roles.length > 0 || editsRoles) && (
          <div className="member-card-roles">
            <div className="member-card-label">{roles.length ? 'Roles' : 'No roles'}</div>
            <ul className="role-chips">
              {roles.map((role) => (
                <li key={role.id} className="role-chip">
                  <span className="role-dot" style={{ backgroundColor: role.color != null ? colorToHex(role.color) : undefined }} />
                  {role.name}
                  {editsRoles && role.position < myRank && (
                    <button
                      type="button"
                      className="role-chip-remove"
                      aria-label={`Remove ${role.name}`}
                      onClick={() => changeRoles(member, member.role_ids.filter((id) => id !== role.id))}
                    >
                      <FontAwesomeIcon icon={faXmark} />
                    </button>
                  )}
                </li>
              ))}
              {editsRoles && assignable.length > 0 && (
                <li>
                  <button type="button" className="role-chip role-chip-add" aria-label="Add role" onClick={() => setAddingRole((open) => !open)}>
                    <FontAwesomeIcon icon={faPlus} />
                  </button>
                </li>
              )}
            </ul>
            {addingRole && (
              <ul className="role-picker" aria-label="Roles to add">
                {assignable.map((role) => (
                  <li key={role.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setAddingRole(false);
                        changeRoles(member, [...(member.role_ids ?? []), role.id]);
                      }}
                    >
                      <span className="role-dot" style={{ backgroundColor: role.color != null ? colorToHex(role.color) : undefined }} />
                      {role.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="member-card-actions">
          {member.id !== user.id && (
            <button type="button" className="btn btn-primary btn-sm vc-button" onClick={() => navigate(`/dm/${member.id}`)}>
              Message
            </button>
          )}
          {isOwnerViewing && member.id !== user.id && (
            <button
              type="button"
              className="btn btn-outline-secondary btn-sm"
              onClick={() => setConfirm({
                title: `Transfer ownership to ${nameOf(member)}`,
                message: `${nameOf(member)} will own ${guild.name} and be able to manage everything, including removing you. This can't be undone by you.`,
                confirmLabel: 'Transfer ownership',
                onConfirm: () => transferGuild(guild.id, member.id),
              })}
            >
              Make owner
            </button>
          )}
          {can(PERMISSIONS.KICK_MEMBERS) && member.id !== user.id && outranks(member) && (
            <button
              type="button"
              className="btn btn-outline-danger btn-sm"
              onClick={() => setConfirm({
                title: `Kick ${nameOf(member)}`,
                message: `${nameOf(member)} will be removed from ${guild.name}. They can rejoin with a new invite.`,
                confirmLabel: 'Kick',
                onConfirm: () => kickMember(guild.id, member.id),
              })}
            >
              Kick
            </button>
          )}
          {can(PERMISSIONS.BAN_MEMBERS) && member.id !== user.id && outranks(member) && (
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => setConfirm({
                title: `Ban ${nameOf(member)}`,
                message: `${nameOf(member)} will be removed from ${guild.name} and can't rejoin until unbanned (Guild Settings).`,
                confirmLabel: 'Ban',
                onConfirm: () => banMember(guild.id, member.id),
              })}
            >
              Ban
            </button>
          )}
        </div>
        {error && <p className="error-msg" role="alert">{error}</p>}
      </div>
    );
  }

  function renderMember(member) {
    const isSelected = selectedId === member.id;
    const color = memberColor(guild.roles, member.role_ids);
    return (
      <li key={member.id} className="member-item">
        <button
          type="button"
          className={`member-row${member.status === 'offline' ? ' offline' : ''}${isSelected ? ' selected' : ''}`}
          onClick={() => setSelectedId(isSelected ? null : member.id)}
        >
          <span className="member-avatar status-avatar">
            <Avatar userId={member.id} />
            <StatusIcon status={member.status} />
          </span>
          <span className="member-name-block">
            <span className="member-name" style={{ color: color ?? undefined }}>{nameOf(member)}</span>
            {getProfile(member.id)?.custom_status && <span className="member-custom-status">{getProfile(member.id).custom_status}</span>}
          </span>
          {member.id === guild.owner && <FontAwesomeIcon icon={faCrown} className="member-owner" title="Guild owner" />}
        </button>
        {isSelected && selected && renderCard(selected)}
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
      {groupMembers(members, guild.roles).map((group) => (
        <section key={group.key} aria-label={group.title}>
          <h6 className="member-group">{group.title} — {group.members.length}</h6>
          <ul>{group.members.map(renderMember)}</ul>
        </section>
      ))}

      {confirm && (
        <ConfirmDialog
          {...confirm}
          onConfirm={async () => {
            await confirm.onConfirm();
            setSelectedId(null);
          }}
          onClose={() => setConfirm(null)}
        />
      )}
    </aside>
  );
}
