import React from 'react';
import { Icon } from '../Icon';
import { faArrowRight, faArrowLeft } from '@fortawesome/free-solid-svg-icons';
import { Trans } from 'react-i18next';
import { displayName, useProfiles } from '../../utils/profiles';
import { formatDateTime, formatTime, useDateFormat } from '../../utils/dateFormat';

// A join log row (server/joinLog.js, system 'member_join' / 'member_leave'): who joined or left
// the guild, and when. The name opens their profile card.
export default function JoinLogNotice({ msg, onOpenProfile }) {
  useProfiles();
  useDateFormat();
  const joined = msg.system === 'member_join';
  const open = (e) => onOpenProfile?.({ id: msg.sender_id, username: msg.sender_username }, e.currentTarget.getBoundingClientRect());
  return (
    <div className={`join-log${joined ? '' : ' left'}`} data-msg-id={msg.id}>
      <Icon icon={joined ? faArrowRight : faArrowLeft} className="join-log-icon" />
      <span>
        <Trans
          i18nKey={joined ? 'guilds.joinLog.joined' : 'guilds.joinLog.left'}
          values={{ name: displayName(msg.sender_id, msg.sender_username) }}
          components={{
            b: <strong
              className="join-log-name"
              role="button"
              tabIndex={0}
              data-user-id={msg.sender_id}
              onClick={(e) => { e.stopPropagation(); open(e); }}
              onKeyDown={(e) => { if (e.key === 'Enter') open(e); }}
            />,
          }}
        />
      </span>
      <time className="join-log-time" title={formatDateTime(msg.timestamp * 1000, { seconds: true })}>
        {formatTime(msg.timestamp * 1000)}
      </time>
    </div>
  );
}
