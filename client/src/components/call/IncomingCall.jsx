import React from 'react';
import { useNavigate } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPhone, faPhoneSlash } from '@fortawesome/free-solid-svg-icons';
import '../../assets/css/voice.css';
import { useCall } from '../../hooks/useCall';
import { acceptCall, declineCall } from '../../voice/callClient';
import UserAvatar from '../voice/UserAvatar';
import { scrollToRight } from '../../utils/scrollToRight';

// Someone calling you, over whatever page is open (like a phone's incoming call screen).
// Answering opens your chat with them, where the call is.
export default function IncomingCall() {
  const call = useCall();
  const navigate = useNavigate();
  if (!call || call.outgoing || call.state === 'active') return null;
  const answering = call.state === 'connecting';
  return (
    <div className="incoming-call" role="alertdialog" aria-label={`Incoming call from ${call.peerName}`}>
      <UserAvatar userId={call.peerId} className="incoming-call-avatar" speaking={!answering} />
      <div className="incoming-call-text">
        <strong>{call.peerName}</strong>
        <span>{answering ? 'Connecting…' : 'Incoming voice call'}</span>
      </div>
      <button type="button" className="call-button decline" aria-label="Decline" title="Decline" onClick={declineCall} disabled={answering}>
        <FontAwesomeIcon icon={faPhoneSlash} />
      </button>
      <button type="button" className="call-button accept" aria-label="Accept" title="Accept" onClick={() => {
        acceptCall();
        navigate(`/dm/${call.peerId}`);
        scrollToRight();
      }} disabled={answering}>
        <FontAwesomeIcon icon={faPhone} />
      </button>
    </div>
  );
}
