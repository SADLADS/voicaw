import React, { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { InteractionContext } from '../../contexts';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowLeft, faCrown, faPlus, faRobot, faXmark } from '@fortawesome/free-solid-svg-icons';
import { setMemberRoles } from '../../services/guildService';
import { PERMISSIONS, colorToHex, has, memberColor, memberRank, memberRoles } from '../../utils/permissions';
import { errorMessage, groupMembers } from '../../utils/guildDisplay';
import StatusIcon from '../StatusIcon';
import ActivityLine from '../ActivityLine';
import { usePresence } from '../../hooks/usePresence';
import { formatDate } from '../../utils/dateFormat';
import { displayName, nameOf, useProfiles } from '../../utils/profiles';
import { interactionError } from '../../utils/commandOptions';
import ProfileCard from '../ProfileCard';
import Avatar from '../Avatar';
import { useLongPress } from '../../hooks/useLongPress';
import { useSwipeToClose } from '../../hooks/useSwipeToClose';
import { openPersonMenu } from '../../utils/personMenu';
import MemberLevel from './MemberLevel';
import { levelBadge, levelName, levelOf, levelsOn } from '../../utils/levels';
import { t } from '../../i18n';

// The guild's members down the right (like Discord), names in their role colour. Clicking one
// opens a card floating over the chat, beside the list at the row's height (on phones, where the
// list fills the screen, below the row), closed by a click elsewhere or Escape: their roles (added and removed there by people who manage roles, for roles
// below their own; + opens the roles to add with a search box, focused, Enter adding the first).
// Message, the friend item, Make Owner / Kick / Ban, Block and Report are in the person's menu
// (utils/personMenu.js): right-clicking a row, or holding it on a phone.
// `userApps` (the channel's bots' user commands) show as Apps on the card, run with
// `onRunUserApp(command, userId)`. With levels on (utils/levels.js), each member's level shows
// under their name (unless the guild hides it there, or it's 0) and on their card.
// `onClose` (phones): the list is full screen, with a back arrow, and a swipe to the right
// closes it (useSwipeToClose).
const CARD_MARGIN = 8;

export default function MemberList({ guild, members: memberList, user, onClose, userApps = [], onRunUserApp }) {
  useProfiles();
  const presenceOf = usePresence();
  const members = memberList.map((m) => ({ ...m, ...presenceOf(m) }));
  const { isMobile } = useContext(InteractionContext);
  const [selectedId, setSelectedId] = useState(null);
  const [addingRole, setAddingRole] = useState(false);
  const [roleQuery, setRoleQuery] = useState('');
  const [error, setError] = useState(null);
  const [cardPosition, setCardPosition] = useState(null);
  const cardRef = useRef(null);
  const rootRef = useRef(null);
  useSwipeToClose(rootRef, { enabled: Boolean(onClose), onClose });

  const me = members.find((m) => m.id === user.id);
  const myRank = memberRank(guild, user.id, me?.role_ids);
  const can = (bit) => has(guild.my_permissions, bit);
  const selected = members.find((m) => m.id === selectedId) ?? null;

  useEffect(() => {
    setAddingRole(false);
    setError(null);
    if (selectedId == null) return undefined;
    const close = (e) => {
      if (!cardRef.current?.contains(e.target) && !e.target.closest?.('.member-row, .vc-dialog-backdrop')) setSelectedId(null);
    };
    const onKey = (e) => { if (e.key === 'Escape') setSelectedId(null); };
    document.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [selectedId]);

  // The card beside the list, its top at the row's (left of the list, over the chat); without
  // room there (phones) centred below the row. Kept in the window, and placed again when it
  // grows (the role picker) or the window changes.
  useLayoutEffect(() => {
    setCardPosition(null);
    if (selectedId == null) return undefined;
    const place = () => {
      const card = cardRef.current;
      const row = rootRef.current?.querySelector(`.member-row[data-user-id="${selectedId}"]`);
      if (!card || !row) return;
      const box = card.getBoundingClientRect();
      const list = rootRef.current.getBoundingClientRect();
      const anchor = row.getBoundingClientRect();
      let left = list.left - box.width - CARD_MARGIN;
      let top = anchor.top;
      if (left < CARD_MARGIN) {
        left = Math.max(CARD_MARGIN, (window.innerWidth - box.width) / 2);
        top = anchor.bottom + CARD_MARGIN;
      }
      top = Math.max(CARD_MARGIN, Math.min(top, window.innerHeight - box.height - CARD_MARGIN));
      setCardPosition({ left, top });
    };
    place();
    window.addEventListener('resize', place);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (cardRef.current) observer?.observe(cardRef.current);
    return () => {
      window.removeEventListener('resize', place);
      observer?.disconnect();
    };
  }, [selectedId]);

  // Whether you outrank `member` (or it's you, for roles).
  const outranks = (member) => member.id !== guild.owner && myRank > memberRank(guild, member.id, member.role_ids);

  // Phone: holding a row opens the person's menu as a sheet (the tap that ends it isn't a click).
  const longPress = useLongPress((target) => {
    const row = target?.closest?.('[data-user-id]');
    if (row) openPersonMenu(row.dataset.userId);
  }, { enabled: isMobile });

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
    const query = roleQuery.trim().toLowerCase();
    const matching = query ? assignable.filter((r) => r.name.toLowerCase().includes(query)) : assignable;
    return (
      <div
        className="profile-popover member-card"
        ref={cardRef}
        style={cardPosition ?? { left: 0, top: 0, visibility: 'hidden' }}
        role="dialog"
        aria-label={nameOf(member)}
      >
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
                      onClick={() => changeRoles(member, member.role_ids.filter((id) => id !== role.id))}
                    >
                      <FontAwesomeIcon icon={faXmark} />
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
                    <FontAwesomeIcon icon={faPlus} />
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
                      changeRoles(member, [...(member.role_ids ?? []), matching[0].id]);
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
                          changeRoles(member, [...(member.role_ids ?? []), role.id]);
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
    const level = levelsOn(guild) && guild.levels.showInMemberList ? levelOf(member.xp, guild.levels) : 0;
    return (
      <li key={member.id} className="member-item">
        <button
          type="button"
          className={`member-row${member.status === 'offline' ? ' offline' : ''}${isSelected ? ' selected' : ''}`}
          data-user-id={member.id}
          onClick={() => setSelectedId(isSelected ? null : member.id)}
        >
          <span className="member-avatar status-avatar">
            <Avatar userId={member.id} />
            <StatusIcon status={member.status} />
          </span>
          {/* No custom status here (the rows are busy enough): their card shows it. What
              they're playing does show, as in Discord. */}
          <span className="member-text">
            <span className="member-name" style={{ color: color ?? undefined }}>
              {nameOf(member)}
              {member.bot ? <span className="app-tag" title={t('chat.message.botTitle')}>{t('chat.message.botTag')}</span> : null}
            </span>
            {member.status !== 'offline' && <ActivityLine userId={member.id} className="member-activity" />}
            {level > 0 && (
              <span className="member-level" title={t('levels.card.level', { name: levelName(guild.levels), level })}>
                {levelBadge(level, guild.levels)}
              </span>
            )}
          </span>
          {member.id === guild.owner && <FontAwesomeIcon icon={faCrown} className="member-owner" title={t('guilds.memberList.owner')} />}
        </button>
      </li>
    );
  }

  return (
    <aside ref={rootRef} className="member-list" aria-label={t('common.members')} {...longPress}>
      {onClose && (
        <div className="member-list-top">
          <button type="button" className="member-list-back" aria-label={t('guilds.memberList.close')} title={t('guilds.memberList.close')} onClick={onClose}>
            <FontAwesomeIcon icon={faArrowLeft} />
          </button>
          <span>{t('common.members')}</span>
        </div>
      )}
      {groupMembers(members, guild.roles).map((group) => (
        <section key={group.key} aria-label={group.title}>
          <h6 className="member-group">{t('guilds.memberList.groupHeading', { title: group.title, count: group.members.length })}</h6>
          <ul>{group.members.map(renderMember)}</ul>
        </section>
      ))}
      {selected && createPortal(renderCard(selected), document.body)}
    </aside>
  );
}
