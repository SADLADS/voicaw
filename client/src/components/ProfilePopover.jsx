import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ProfileCard from './ProfileCard';
import { t } from '../i18n';

const MARGIN = 8;

// Someone's ProfileCard floating by what was clicked (a name or avatar in chat), kept on
// screen; closes on a click elsewhere or Escape. `anchor` is the clicked element's rect. What
// can be done to them (Message, friends, Block, Report...) is in their right-click menu
// (utils/personMenu.js); dialogs don't count as elsewhere.
export default function ProfilePopover({ user, anchor, onClose }) {
  const ref = useRef(null);
  const [position, setPosition] = useState({ left: anchor.right + MARGIN, top: anchor.top, visibility: 'hidden' });

  // Beside what was clicked (below it if there's no room), within the window.
  useLayoutEffect(() => {
    const box = ref.current.getBoundingClientRect();
    let left = anchor.right + MARGIN;
    let top = anchor.top;
    if (left + box.width > window.innerWidth - MARGIN) {
      left = Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - box.width - MARGIN));
      top = anchor.bottom + MARGIN;
    }
    top = Math.max(MARGIN, Math.min(top, window.innerHeight - box.height - MARGIN));
    setPosition({ left, top });
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
    <div className="profile-popover" ref={ref} style={position} role="dialog" aria-label={t('app.profile.profileOf', { name: user.username })}>
      <ProfileCard user={user} />
    </div>,
    document.body
  );
}
