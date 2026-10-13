import React, { useCallback, useContext, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { InteractionContext } from '../../contexts';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowLeft, faCrown } from '@fortawesome/free-solid-svg-icons';
import { memberColor } from '../../utils/permissions';
import { groupMembers } from '../../utils/guildDisplay';
import StatusIcon from '../StatusIcon';
import ActivityLine from '../ActivityLine';
import { usePresence } from '../../hooks/usePresence';
import { nameOf, useProfiles } from '../../utils/profiles';
import Avatar from '../Avatar';
import { useLongPress } from '../../hooks/useLongPress';
import { useSwipeToClose } from '../../hooks/useSwipeToClose';
import { useFloatingCard } from '../../hooks/useFloatingCard';
import { openPersonMenu } from '../../utils/personMenu';
import { openUserProfile } from '../../utils/userProfile';
import MemberCard from './MemberCard';
import { levelBadge, levelName, levelOf, levelsOn } from '../../utils/levels';
import { t } from '../../i18n';

// The guild's members down the right (like Discord), names in their role colour. Clicking one
// opens their MemberCard floating over the chat (hooks/useFloatingCard.js); on a phone, their
// full profile instead (UserProfile).
// Message, the friend item, Make Owner / Kick / Ban, Block and Report are in the person's menu
// (utils/personMenu.js): right-clicking a row, or holding it on a phone.
// `userApps` and `onRunUserApp` are passed to the card. With levels on (utils/levels.js), each
// member's level shows under their name (unless the guild hides it there, or it's 0) and on
// their card.
// `onClose` (phones): the list is full screen, with a back arrow, and a swipe to the right
// closes it (useSwipeToClose).

export default function MemberList({ guild, members: memberList, user, onClose, userApps = [], onRunUserApp }) {
  useProfiles();
  const presenceOf = usePresence();
  const members = memberList.map((m) => ({ ...m, ...presenceOf(m) }));
  const { isMobile } = useContext(InteractionContext);
  const [selectedId, setSelectedId] = useState(null);
  const cardRef = useRef(null);
  const rootRef = useRef(null);
  useSwipeToClose(rootRef, { enabled: Boolean(onClose), onClose });

  const selected = members.find((m) => m.id === selectedId) ?? null;

  const closeCard = useCallback(() => setSelectedId(null), []);
  const cardStyle = useFloatingCard(selectedId, { listRef: rootRef, cardRef, rowSelector: '.member-row', onClose: closeCard });

  // Phone: holding a row opens the person's menu as a sheet (the tap that ends it isn't a click).
  const longPress = useLongPress((target) => {
    const row = target?.closest?.('[data-user-id]');
    if (row) openPersonMenu(row.dataset.userId);
  }, { enabled: isMobile });

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
          onClick={() => (isMobile ? openUserProfile(member.id) : setSelectedId(isSelected ? null : member.id))}
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
      {selected && createPortal(
        <div className="profile-popover member-card" ref={cardRef} style={cardStyle} role="dialog" aria-label={nameOf(selected)}>
          <MemberCard key={selected.id} guild={guild} member={selected} members={members} user={user} userApps={userApps} onRunUserApp={onRunUserApp} />
        </div>,
        document.body
      )}
    </aside>
  );
}
