import React, { useState } from 'react';
import { Icon } from '../Icon';
import { faPlus, faRobot, faXmark } from '@fortawesome/free-solid-svg-icons';
import { setMemberRoles } from '../../services/guildService';
import { PERMISSIONS, colorToHex, has, memberColor, memberRank, memberRoles } from '../../utils/permissions';
import { errorMessage } from '../../utils/guildDisplay';
import { formatDate } from '../../utils/dateFormat';
import { displayName } from '../../utils/profiles';
import { interactionError } from '../../utils/commandOptions';
import ProfileCard from '../ProfileCard';
import MemberLevel from './MemberLevel';
import { levelsOn } from '../../utils/levels';
import { t } from '../../i18n';

// A guild member's card, inside a floating box (the member list's, or ProfilePopover's from a
// name or picture in a guild's chat): their profile, when they joined, their level (levels on),
// their roles (added and removed by people who manage roles, for roles below their own; + opens
// the roles to add with a search box, focused, Enter adding the first) and the channel's bots'
// user commands as Apps (`userApps`, run with `onRunUserApp(command, userId)`). `members` (the
// guild's) gives your own rank. Give it a `key` per member, so the role picker starts closed.
export default function MemberCard({ guild, member, members, user, userApps = [], onRunUserApp }) {
  const [addingRole, setAddingRole] = useState(false);
  const [roleQuery, setRoleQuery] = useState('');
  const [error, setError] = useState(null);
  const me = members.find((m) => m.id === user.id);
  const myRank = memberRank(guild, user.id, me?.role_ids);
  const can = (bit) => has(guild.my_permissions, bit);
  // Whether you outrank `member` (or it's you, for roles).
  const outranks = (other) => other.id !== guild.owner && myRank > memberRank(guild, other.id, other.role_ids);

  async function changeRoles(roleIds) {
    setError(null);
    try {
      await setMemberRoles(guild.id, member.id, roleIds);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const roles = memberRoles(guild.roles, member.role_ids);
  const editsRoles = can(PERMISSIONS.MANAGE_ROLES) && (member.id === user.id || outranks(member));
  // A bot's own role (server/bots.js) stays with its bot: never given or taken here.
  const assignable = (guild.roles ?? []).filter((r) => !r.is_everyone && !r.bot_id && r.position < myRank && !member.role_ids?.includes(r.id));
  const query = roleQuery.trim().toLowerCase();
  const matching = query ? assignable.filter((r) => r.name.toLowerCase().includes(query)) : assignable;
  return (
    <>
      <ProfileCard user={member} color={memberColor(guild.roles, member.role_ids) ?? undefined} />
      <div className="vc-hint">{t('guilds.memberList.memberSince', { date: formatDate(member.joined_at * 1000) })}</div>
      {levelsOn(guild) && <MemberLevel guild={guild} member={member} canEdit={can(PERMISSIONS.MANAGE_LEVELS)} />}

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
                    onClick={() => changeRoles(member.role_ids.filter((id) => id !== role.id))}
                  >
                    <Icon icon={faXmark} />
                  </button>
                )}
              </li>
            ))}
            {editsRoles && assignable.length > 0 && (
              <li>
                <button
                  type="button"
                  className="role-chip role-chip-add"
                  aria-label={t('guilds.memberList.addRole')}
                  aria-expanded={addingRole}
                  onClick={() => {
                    setRoleQuery('');
                    setAddingRole((open) => !open);
                  }}
                >
                  <Icon icon={faPlus} />
                </button>
              </li>
            )}
          </ul>
          {addingRole && (
            <div className="role-picker">
              <input
                type="search"
                className="form-control form-control-sm role-picker-search"
                aria-label={t('guilds.memberList.searchRoles')}
                placeholder={t('guilds.memberList.searchRoles')}
                value={roleQuery}
                autoFocus
                onChange={(e) => setRoleQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && matching[0]) {
                    e.preventDefault();
                    setAddingRole(false);
                    changeRoles([...(member.role_ids ?? []), matching[0].id]);
                  } else if (e.key === 'Escape') {
                    e.stopPropagation();
                    setAddingRole(false);
                  }
                }}
              />
              <ul aria-label={t('guilds.memberList.rolesToAdd')}>
                {matching.map((role) => (
                  <li key={role.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setAddingRole(false);
                        changeRoles([...(member.role_ids ?? []), role.id]);
                      }}
                    >
                      <span className="role-dot" style={{ backgroundColor: role.color != null ? colorToHex(role.color) : undefined }} />
                      {role.name}
                    </button>
                  </li>
                ))}
              </ul>
              {matching.length === 0 && <p className="vc-hint role-picker-empty">{t('guilds.memberList.noRolesMatch')}</p>}
            </div>
          )}
        </div>
      )}

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
              <Icon icon={faRobot} /> {command.name}
            </button>
          ))}
        </div>
      )}
      {error && <p className="error-msg" role="alert">{error}</p>}
    </>
  );
}
