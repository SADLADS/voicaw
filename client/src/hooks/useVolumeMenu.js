import { useCallback, useState } from 'react';
import { useVoice } from './useVoice';
import { t } from '../i18n';

// Opens the volume popover (voice/UserVolumeMenu.jsx) for someone you can hear: a click (or
// Enter) on them, or a right click there; `inRoom`: you're connected to the voice channel or
// call they're shown in (everyone there but you can be adjusted). Returns the
// open menu ({ userId, name, anchor } or null), `close`, and `triggerProps(userId, name)` to
// spread on whatever shows the person (nothing for anyone else).
export function useVolumeMenu(inRoom) {
  const { identity } = useVoice();
  const [menu, setMenu] = useState(null);
  const close = useCallback(() => setMenu(null), []);

  function triggerProps(userId, name) {
    if (!inRoom || identity == null || String(userId) === identity) return {};
    const open = (anchor) => setMenu({ userId, name, anchor });
    return {
      role: 'button',
      tabIndex: 0,
      'aria-haspopup': 'dialog',
      title: t('voice.userVolume.dialogLabel', { name }),
      'data-volume-trigger': '',
      onClick: (e) => {
        e.stopPropagation();
        open(e.currentTarget.getBoundingClientRect());
      },
      onContextMenu: (e) => {
        e.preventDefault();
        e.stopPropagation();
        open({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY });
      },
      onKeyDown: (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        open(e.currentTarget.getBoundingClientRect());
      },
    };
  }

  return { menu: inRoom ? menu : null, close, triggerProps };
}
