import React from 'react';
import { Trans } from 'react-i18next';
import { Icon } from './Icon';
import { faThumbtack } from '@fortawesome/free-solid-svg-icons';
import { displayName, useProfiles } from '../utils/profiles';
import { formatDateTime, formatTime, useDateFormat } from '../utils/dateFormat';
import { t } from '../i18n';

// A "pinned a message" row (server pins.js, system 'pin'), as Discord's: who pinned which
// message. "a message" jumps to it (`onJump(id)`), "See all pinned messages" opens the list
// (`onShowPins`, when the chat has one to open).
export default function PinNotice({ msg, onJump, onShowPins }) {
  useProfiles();
  useDateFormat();
  const jump = () => onJump?.(msg.parent_message_id);
  return (
    <div className="pin-notice" data-msg-id={msg.id}>
      <Icon icon={faThumbtack} className="pin-notice-icon" />
      <span>
        <Trans
          i18nKey="chat.pinNotice.pinned"
          values={{ name: displayName(msg.sender_id, msg.sender_username) }}
          components={{
            b: <strong className="pin-notice-name" />,
            message: onJump ? <button type="button" className="pin-notice-link" onClick={jump} /> : <span />,
          }}
        />
        {onShowPins && (
          <>
            {' '}
            <button type="button" className="pin-notice-link" onClick={onShowPins}>{t('chat.pinNotice.seeAll')}</button>
          </>
        )}
      </span>
      <time className="pin-notice-time" title={formatDateTime(msg.timestamp * 1000, { seconds: true })}>
        {formatTime(msg.timestamp * 1000)}
      </time>
    </div>
  );
}
