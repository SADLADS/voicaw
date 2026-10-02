import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPhone } from '@fortawesome/free-solid-svg-icons';
import { callLogText, parseCallLog } from '../utils/callLog';
import { displayName, useProfiles } from '../utils/profiles';
import { formatDateTime, useDateFormat } from '../utils/dateFormat';

// A call in a DM or group's history (utils/callLog.js): how long it lasted, or that it was
// missed, as seen by `meId`. Nothing for a row this app doesn't understand.
export default function CallLogNotice({ msg, meId }) {
  useProfiles();
  useDateFormat();
  const log = parseCallLog(msg);
  if (!log) return null;
  const { missed, text } = callLogText(log, {
    meId,
    callerId: msg.sender_id,
    caller: displayName(msg.sender_id, msg.sender_username),
    callee: msg.recipient_id != null ? displayName(msg.recipient_id) : '',
    group: msg.group_id != null,
  });
  return (
    <div className={`call-log${missed ? ' missed' : ''}`} data-msg-id={msg.id} title={formatDateTime(msg.timestamp * 1000, { seconds: true })}>
      <FontAwesomeIcon icon={faPhone} className="call-log-icon" />
      <span>{text}</span>
    </div>
  );
}
