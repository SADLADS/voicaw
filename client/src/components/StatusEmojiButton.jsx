import React, { useCallback, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faFaceSmile, faXmark } from '@fortawesome/free-solid-svg-icons';
import EmojiPicker from './EmojiPicker';
import { ReactionEmoji } from './MessageReactions';
import { reactionPickerPosition } from '../utils/reactionPickerPosition';
import { t } from '../i18n';

// The custom status's emoji: a button showing it (a smiley without one) that opens the emoji
// picker by it, and ✕ to remove it (unless `removable` is false). The picker is drawn here, not
// portalled, so a menu around it (UserMenu) counts clicks in it as inside. `onPickerClosed` runs when the picker closes, picked
// or not (UserMenu gives its text box the focus back).
export default function StatusEmojiButton({ emoji, onChange, onPickerClosed, disabled, removable = true }) {
  const [picking, setPicking] = useState(null); // the button's rect while the picker is open
  const closedRef = useRef(onPickerClosed);
  closedRef.current = onPickerClosed;
  const close = useCallback(() => {
    setPicking(null);
    closedRef.current?.();
  }, []);

  function toggle(button) {
    if (picking) return close();
    const { top, bottom, left, right } = button.getBoundingClientRect();
    setPicking({ top, bottom, left, right });
  }

  const picker = picking && reactionPickerPosition(picking);
  return (
    <span className="status-emoji-picker">
      <button
        type="button"
        className={`status-emoji-button${emoji ? '' : ' empty'}`}
        aria-label={emoji ? t('app.userMenu.changeEmoji') : t('app.userMenu.addEmoji')}
        title={emoji ? t('app.userMenu.changeEmoji') : t('app.userMenu.addEmoji')}
        aria-expanded={Boolean(picking)}
        disabled={disabled}
        // Don't let the open picker's outside-click handler close it before this toggles.
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => toggle(e.currentTarget)}
      >
        {emoji ? <ReactionEmoji native={emoji} /> : <FontAwesomeIcon icon={faFaceSmile} />}
      </button>
      {emoji && removable && (
        <button type="button" className="status-emoji-remove" aria-label={t('app.userMenu.removeEmoji')} title={t('app.userMenu.removeEmoji')} disabled={disabled} onClick={() => onChange(null)}>
          <FontAwesomeIcon icon={faXmark} />
        </button>
      )}
      {picker && (
        <div className={`reaction-picker-anchor status-emoji-anchor${picker.below ? ' below' : ''}`} style={picker.style}>
          <EmojiPicker onSelect={onChange} onClose={close} />
        </div>
      )}
    </span>
  );
}
