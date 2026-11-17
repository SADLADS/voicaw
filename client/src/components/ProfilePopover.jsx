import React, { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ProfileCard from './ProfileCard';
import MemberCard from './guild/MemberCard';
import WebhookCard from './WebhookCard';
import { ImportedAuthorCard } from './ImportedMessage';
import { GuildMembersContext } from '../contexts';
import { t } from '../i18n';

const MARGIN = 8;

// Someone's card floating by what was clicked (a name or avatar in chat), kept on screen (and
// placed again as it grows); closes on a click elsewhere or Escape. In a guild's chats
// (GuildMembersContext) a member gets the member list's MemberCard (roles, level, Apps);
// elsewhere, or someone who left, the ProfileCard. `anchor` is the clicked element's rect. What
// can be done to them (Message, friends, Block, Report...) is in their right-click menu
// (utils/personMenu.js); dialogs don't count as elsewhere. A webhook's message gives `webhook`
// ({ id, name, avatar }) instead of `user`: its WebhookCard. An unlinked author of imported
// messages gives `imported` ({ name, avatar, imported }): their ImportedAuthorCard.
export default function ProfilePopover({ user, webhook, imported, anchor, onClose }) {
  const ref = useRef(null);
  const guildMembers = useContext(GuildMembersContext);
  const member = user ? guildMembers?.members.find((m) => String(m.id) === String(user.id)) ?? null : null;
  const [position, setPosition] = useState({ left: anchor.right + MARGIN, top: anchor.top, visibility: 'hidden' });

  // Beside what was clicked (below it if there's no room), within the window.
  useLayoutEffect(() => {
    const place = () => {
      if (!ref.current) return;
      const box = ref.current.getBoundingClientRect();
      let left = anchor.right + MARGIN;
      let top = anchor.top;
      if (left + box.width > window.innerWidth - MARGIN) {
        left = Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - box.width - MARGIN));
        top = anchor.bottom + MARGIN;
      }
      top = Math.max(MARGIN, Math.min(top, window.innerHeight - box.height - MARGIN));
      setPosition({ left, top });
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(ref.current);
    return () => observer?.disconnect();
  }, [anchor]);

  useEffect(() => {
    const onDown = (e) => {
      if (!ref.current?.contains(e.target) && !e.target.closest?.('.vc-dialog-backdrop')) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return createPortal(
    <div className="profile-popover member-card" ref={ref} style={position} role="dialog" aria-label={t('app.profile.profileOf', { name: webhook ? webhook.name : imported ? imported.name : user.username })}>
      {webhook ? <WebhookCard webhook={webhook} />
        : imported ? <ImportedAuthorCard author={imported} />
        : member ? <MemberCard key={member.id} {...guildMembers} member={member} />
          : <ProfileCard user={user} />}
    </div>,
    document.body
  );
}
