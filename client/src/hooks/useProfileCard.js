import { useCallback, useContext, useState } from 'react';
import { InteractionContext } from '../contexts';
import { openUserProfile } from '../utils/userProfile';
import { t } from '../i18n';

// Someone's picture in voice (the channel list's voice members, a voice channel's tiles, a call)
// opens their profile card (ProfilePopover) beside it, as a name or picture in chat does; on a
// phone, their full profile (UserProfile). The rest of the row or tile keeps what it does
// (useVolumeMenu: the volume, or focusing a camera): the picture's click doesn't reach it, nor
// does the second click of a double click (full screen). A right click or long press still
// bubbles up to the volume. Returns the open card ({ user, anchor } or null), `close`, and
// `pictureProps({ id, username })` to spread on the picture.
export function useProfileCard() {
  const { isMobile } = useContext(InteractionContext);
  const [card, setCard] = useState(null);
  const close = useCallback(() => setCard(null), []);

  function pictureProps(user) {
    const open = (target) => {
      if (isMobile) openUserProfile(user.id);
      else setCard({ user, anchor: target.getBoundingClientRect() });
    };
    return {
      role: 'button',
      tabIndex: 0,
      'aria-label': t('app.profile.profileOf', { name: user.username }),
      onClick: (e) => {
        e.stopPropagation();
        if (e.detail > 1) return;
        open(e.currentTarget);
      },
      onDoubleClick: (e) => e.stopPropagation(),
      onKeyDown: (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        open(e.currentTarget);
      },
    };
  }

  return { card, close, pictureProps };
}
