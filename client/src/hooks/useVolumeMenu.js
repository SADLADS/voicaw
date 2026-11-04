import { useCallback, useState } from 'react';
import { useVoice } from './useVoice';
import { useLongPress } from './useLongPress';
import { t } from '../i18n';

// Opens the volume popover (voice/UserVolumeMenu.jsx) for someone you can hear: a click (or
// Enter) on them, a right click there or a long press; `inRoom`: you're connected to the voice
// channel or call they're shown in (everyone there but you can be adjusted). Returns the
// open menu ({ userId, name, anchor } or null), `close`, and `triggerProps(userId, name)` to
// spread on whatever shows the person (nothing for anyone else).
//
// `triggerProps(userId, name, action)`, with `action` ({ activate, label, pressed }, see
// useCameraFocus.js), is for a camera: a click or Enter does `activate` instead (yours too), so
// the volume is only on the right click or long press. The second click of a double click does
// nothing: double clicks are full screen.
export function useVolumeMenu(inRoom) {
  const { identity } = useVoice();
  const [menu, setMenu] = useState(null);
  const close = useCallback(() => setMenu(null), []);
  const longPress = useLongPress((target) => {
    const person = target?.closest?.('[data-volume-user]');
    if (!person) return;
    setMenu({ userId: person.dataset.volumeUser, name: person.dataset.volumeName, anchor: person.getBoundingClientRect() });
  });

  function triggerProps(userId, name, action) {
    if (!inRoom || identity == null) return {};
    const own = String(userId) === identity;
    if (own && !action) return {};
    const open = (anchor) => setMenu({ userId, name, anchor });
    const run = (anchor) => (action ? action.activate() : open(anchor));
    return {
      role: 'button',
      tabIndex: 0,
      title: action ? action.label : t('voice.userVolume.dialogLabel', { name }),
      ...(action ? { 'aria-pressed': Boolean(action.pressed) } : { 'aria-haspopup': 'dialog' }),
      ...(own ? {} : {
        ...longPress,
        'data-volume-trigger': '',
        'data-volume-user': userId,
        'data-volume-name': name,
        onContextMenu: (e) => {
          e.preventDefault();
          e.stopPropagation();
          open({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY });
        },
      }),
      onClick: (e) => {
        e.stopPropagation();
        if (e.detail > 1) return;
        run(e.currentTarget.getBoundingClientRect());
      },
      onKeyDown: (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        run(e.currentTarget.getBoundingClientRect());
      },
    };
  }

  return { menu: inRoom ? menu : null, close, triggerProps };
}
