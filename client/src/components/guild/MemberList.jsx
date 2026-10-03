import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCrown, faPlus, faRobot, faXmark } from '@fortawesome/free-solid-svg-icons';
import { banMember, kickMember, setMemberRoles, transferGuild } from '../../services/guildService';
import { PERMISSIONS, colorToHex, has, memberColor, memberRank, memberRoles } from '../../utils/permissions';
import { errorMessage, groupMembers } from '../../utils/guildDisplay';
import ConfirmDialog from './ConfirmDialog';
import StatusIcon from '../StatusIcon';
import { usePresence } from '../../hooks/usePresence';
import { formatDate } from '../../utils/dateFormat';
import { displayName, getProfile, nameOf, useProfiles } from '../../utils/profiles';
import { interactionError } from '../../utils/commandOptions';
import ProfileCard from '../ProfileCard';
import Avatar from '../Avatar';
import { t } from '../../i18n';

// The guild's members down the right (like Discord), names in their role colour. Clicking one
// opens a card: their roles (added and removed there by people who manage roles, for roles
// below their own), Message, and, as permissions and rank allow, Make owner / Kick / Ban.
// `userApps` (the channel's bots' user commands) show as Apps on the card, run with
// `onRunUserApp(command, userId)`.
export default function MemberList({ guild, members: memberList, user, onClose, userApps = [], onRunUserApp }) {
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
    // A bot's own role (server/bots.js) stays with its bot: never given or taken here.
    const assignable = (guild.roles ?? []).filter((r) => !r.is_everyone && !r.bot_id && r.position < myRank && !member.role_ids?.includes(r.id));
    const isOwnerViewing = guild.owner === user.id;
    return (
      <div className="member-card" ref={cardRef} role="dialog" aria-label={nameOf(member)}>
        <ProfileCard user={member} color={memberColor(guild.roles, member.role_ids) ?? undefined} />
        <div className="vc-hint">{t('guilds.memberList.memberSince', { date: formatDate(member.joined_at * 1000) })}</div>

        {(roles.length > 0 || editsRoles) && (
          <div className="member-card-roles">
            <div className="member-card-label">{roles.length ? t('guilds.memberList.roles') : t('guilds.memberList.noRoles')}</div>
            <ul className="role-chips">
              {roles.map((role) => (
                <li key={role.id} className="role-chip">
                  <span className="role-dot" style={{ backgroundColor: role.color != null ? colorToHex(role.color) : undefined }} />
                  {role.name}
                  {editsRoles && role.position < myRank && !role.bot_id && (
                    <button
                      type="button"
                      className="role-chip-remove"
                      aria-label={t('guilds.memberList.removeRole', { name: role.name })}
                      onClick={() => changeRoles(member, member.role_ids.filter((id) => id !== role.id))}
                    >
                      <FontAwesomeIcon icon={faXmark} />
                    </button>
                  )}
                </li>
              ))}
              {editsRoles && assignable.length > 0 && (
                <li>
                  <button type="button" className="role-chip role-chip-add" aria-label={t('guilds.memberList.addRole')} onClick={() => setAddingRole((open) => !open)}>
                    <FontAwesomeIcon icon={faPlus} />
                  </button>
                </li>
              )}
            </ul>
            {addingRole && (
              <ul className="role-picker" aria-label={t('guilds.memberList.rolesToAdd')}>
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
          {/* Bots can't be in DMs (they're end-to-end encrypted) or own a guild. */}
          {member.id !== user.id && !member.bot && (
            <button type="button" className="btn btn-primary btn-sm vc-button" onClick={() => navigate(`/dm/${member.id}`)}>
              {t('guilds.memberList.message')}
            </button>
          )}
          {isOwnerViewing && member.id !== user.id && !member.bot && (
            <button
              type="button"
              className="btn btn-outline-secondary btn-sm"
              onClick={() => setConfirm({
                title: t('guilds.memberList.transfer.title', { name: nameOf(member) }),
                message: t('guilds.memberList.transfer.message', { name: nameOf(member), guild: guild.name }),
                confirmLabel: t('guilds.memberList.transfer.confirm'),
                onConfirm: () => transferGuild(guild.id, member.id),
              })}
            >
              {t('guilds.memberList.makeOwner')}
            </button>
          )}
          {can(PERMISSIONS.KICK_MEMBERS) && member.id !== user.id && outranks(member) && (
            <button
              type="button"
              className="btn btn-outline-danger btn-sm"
              onClick={() => setConfirm({
                title: t('guilds.memberList.kick.title', { name: nameOf(member) }),
                message: t('guilds.memberList.kick.message', { name: nameOf(member), guild: guild.name }),
                confirmLabel: t('guilds.memberList.kick.button'),
                onConfirm: () => kickMember(guild.id, member.id),
              })}
            >
              {t('guilds.memberList.kick.button')}
            </button>
          )}
          {can(PERMISSIONS.BAN_MEMBERS) && member.id !== user.id && outranks(member) && (
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => setConfirm({
                title: t('guilds.memberList.ban.title', { name: nameOf(member) }),
                message: t('guilds.memberList.ban.message', { name: nameOf(member), guild: guild.name }),
                confirmLabel: t('guilds.memberList.ban.button'),
                onConfirm: () => banMember(guild.id, member.id),
              })}
            >
              {t('guilds.memberList.ban.button')}
            </button>
          )}
        </div>
        {userApps.length > 0 && onRunUserApp && (
          <div className="member-card-apps" role="group" aria-label={t('commands.apps.label')}>
            <div className="member-card-label">{t('commands.apps.label')}</div>
            {userApps.map((command) => (
              <button
                key={command.id}
                type="button"
                className="btn btn-outline-secondary btn-sm member-card-app"
                title={displayName(command.bot?.id, command.bot?.name)}
                onClick={async () => {
                  setError(null);
                  try {
                    await onRunUserApp(command, member.id);
                  } catch (err) {
                    setError(interactionError(err));
                  }
                }}
              >
                <FontAwesomeIcon icon={faRobot} /> {command.name}
              </button>
            ))}
          </div>
        )}
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
            <span className="member-name" style={{ color: color ?? undefined }}>
              {nameOf(member)}
              {member.bot ? <span className="app-tag" title={t('chat.message.botTitle')}>{t('chat.message.botTag')}</span> : null}
            </span>
            {getProfile(member.id)?.custom_status && <span className="member-custom-status">{getProfile(member.id).custom_status}</span>}
          </span>
          {member.id === guild.owner && <FontAwesomeIcon icon={faCrown} className="member-owner" title={t('guilds.memberList.owner')} />}
        </button>
        {isSelected && selected && renderCard(selected)}
      </li>
    );
  }

  return (
    <aside className="member-list" aria-label={t('common.members')}>
      {onClose && (
        <div className="member-list-top">
          <span>{t('common.members')}</span>
          <button type="button" className="vc-dialog-close" aria-label={t('guilds.memberList.close')} onClick={onClose}>×</button>
        </div>
      )}
      {groupMembers(members, guild.roles).map((group) => (
        <section key={group.key} aria-label={group.title}>
          <h6 className="member-group">{t('guilds.memberList.groupHeading', { title: group.title, count: group.members.length })}</h6>
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
