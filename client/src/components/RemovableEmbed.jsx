import React from 'react';
import { Icon } from './Icon';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { t } from '../i18n';

// A link preview with Discord's X beside it, showing while it's hovered (desktop; on a phone
// the action sheet's "Remove previews" does it). `onRemove(event)` removes all the message's
// previews (ChatPane asks first, unless Shift is held). Without `onRemove`, just the preview.
export default function RemovableEmbed({ onRemove, children }) {
  if (!onRemove) return children;
  return (
    <div className="removable-embed">
      {children}
      <button
        type="button"
        className="remove-embed-button"
        onClick={onRemove}
        aria-label={t('chat.message.removePreviewsButton')}
        title={t('chat.message.removePreviewsButton')}
      >
        <Icon icon={faXmark} />
      </button>
    </div>
  );
}
