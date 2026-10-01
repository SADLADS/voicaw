import React, { useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPhone, faPhoneSlash } from '@fortawesome/free-solid-svg-icons';
import '../../assets/css/voice.css';
import { useCall } from '../../hooks/useCall';
import { acceptCall, declineCall } from '../../voice/callClient';
import UserAvatar from '../voice/UserAvatar';
import { showContent } from '../../utils/mobilePanes';
import { LayoutContext } from '../../contexts';
import { groupTitle } from '../../utils/groupDisplay';
import { displayName, useProfiles } from '../../utils/profiles';

// Someone calling you, over whatever page is open (like a phone's incoming call screen).
// Answering opens your chat with them, where the call is.
export default function IncomingCall({ user }) {
  useProfiles();
  const call = useCall();
  const navigate = useNavigate();
  const { groupList } = useContext(LayoutContext);
  if (!call || call.outgoing || call.state === 'active') return null;
  const answering = call.state === 'connecting';
  const group = call.groupId && (groupList?.groups.find((g) => g.id === call.groupId) ?? { name: call.groupName });
  const title = group ? groupTitle(group, user) : displayName(call.peerId, call.peerName);
  const subtitle = group ? `${call.callerName} started a call` : 'Incoming voice call';
  const avatarId = call.callerId ?? call.peerId ?? null;
  return (
    <div className="incoming-call" role="alertdialog" aria-label={`Incoming call from ${title}`}>
      {avatarId != null && <UserAvatar userId={avatarId} className="incoming-call-avatar" speaking={!answering} />}
      <div className="incoming-call-text">
        <strong>{title}</strong>
        <span>{answering ? 'Connecting…' : subtitle}</span>
      </div>
      <button type="button" className="call-button decline" aria-label="Decline" title="Decline" onClick={declineCall} disabled={answering}>
        <FontAwesomeIcon icon={faPhoneSlash} />
      </button>
      <button type="button" className="call-button accept" aria-label="Accept" title="Accept" onClick={() => {
        acceptCall();
        navigate(call.groupId ? `/dm/g/${call.groupId}` : `/dm/${call.peerId}`);
        showContent();
      }} disabled={answering}>
        <FontAwesomeIcon icon={faPhone} />
      </button>
    </div>
  );
}
