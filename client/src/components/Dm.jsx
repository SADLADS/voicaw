import React, { useContext, useEffect, useMemo, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPhone } from '@fortawesome/free-solid-svg-icons';
import { useParams } from 'react-router-dom';
import '../assets/css/dms.css';
import '../assets/css/voice.css';
import NotificationPrompt from './NotificationPrompt';
import RecoveryPrompt from './RecoveryPrompt';
import { ConfigContext, LayoutContext } from '../contexts';
import CallPanel from './call/CallPanel';
import { useCall } from '../hooks/useCall';
import { startCall } from '../voice/callClient';
import ContactKeyWarning from './ContactKeyWarning';
import SafetyNumberDialog from './SafetyNumberDialog';
import ChatPane from './ChatPane';
import { useConversation } from '../hooks/useConversation';
import { addReaction, removeReaction } from '../services/dmService';
import { encryptReaction, reactionContext } from '../services/encryptionService';
import { usePresence } from '../hooks/usePresence';
import { lastSeenText, statusLabel } from '../utils/presence';
import { nameOf, useProfiles } from '../utils/profiles';

// The "Verified / Not verified" badge and safety number dialog. Hidden for now: too confusing
// for most people. The keys are still pinned and a changed key still blocks the chat.
const SHOW_SAFETY_NUMBERS = false;

// A DM conversation: header (with the contact's status and the call button), the call with
// them if there is one (CallPanel), then the chat itself (ChatPane).
// The conversation (loading, sending, live updates) is useConversation.
export default function Dm({ user }) {
  const { users, errorUsers, fetchUnreadMessages } = useContext(LayoutContext);
  const { voiceEnabled } = useContext(ConfigContext);
  const call = useCall();
  const { id } = useParams();
  const chatUser = users.find((u) => u.id.toString() === id);
  const presenceOf = usePresence();
  const presence = chatUser ? presenceOf(chatUser) : null;

  const conversation = useConversation({ id, user, chatUser, onRead: fetchUnreadMessages });
  const { keyStatus, sharedKey } = conversation;
  const [showSafetyNumber, setShowSafetyNumber] = useState(false);
  const profilesVersion = useProfiles();
  const chatName = chatUser ? nameOf(chatUser) : null;
  const reactionNames = useMemo(
    () => ({ [user?.id]: nameOf(user), [chatUser?.id]: nameOf(chatUser) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.id, user?.username, chatUser?.id, chatUser?.username, profilesVersion]
  );
  const people = useMemo(() => (chatUser ? [chatUser, user] : []), [chatUser, user]);

  // Reactions are encrypted with the conversation key, bound to the message and the reactor.
  const saveReaction = async (msg, emoji) => {
    const content = await encryptReaction(
      emoji, sharedKey, reactionContext(msg.id, user.id, msg.sender_id, msg.recipient_id)
    );
    return addReaction(msg.id, content);
  };

  useEffect(() => setShowSafetyNumber(false), [id]);

  // A changed or invalid contact key blocks the conversation until resolved.
  const keyBlocked = keyStatus === 'changed' || keyStatus === 'invalid';

  return (
    <div id="dm-main" data-current-user-id={user?.id} data-other-user-id={chatUser?.id}>
      <RecoveryPrompt user={user} />
      <NotificationPrompt />
      {errorUsers && <p className="error-text">Error loading users: {errorUsers}</p>}
      {users.length === 0 && !errorUsers && !id && <p>No recent conversations found.</p>}

      {id && (
        <>
          <h4 className="chat-recipient-header">
            {chatName || 'User'}
            {presence?.status === 'offline' && (
              <span className="chat-recipient-status">
                {lastSeenText(presence.lastOnline) ?? statusLabel('offline')}
              </span>
            )}
            {voiceEnabled && chatUser && sharedKey && !keyBlocked && (
              <button
                type="button"
                className="chat-call-button"
                aria-label={`Call ${chatName}`}
                title={call ? "You're already in a call" : `Start a voice call with ${chatName}`}
                disabled={Boolean(call)}
                onClick={() => startCall(chatUser)}
              >
                <FontAwesomeIcon icon={faPhone} />
              </button>
            )}
            {SHOW_SAFETY_NUMBERS && (keyStatus === 'trusted' || keyStatus === 'verified') && (
              <button
                type="button"
                className={`key-status-badge ${keyStatus}`}
                onClick={() => setShowSafetyNumber(true)}
                title="Compare safety numbers"
              >
                {keyStatus === 'verified' ? '✓ Verified' : 'Not verified'}
              </button>
            )}
          </h4>

          {showSafetyNumber && (
            <SafetyNumberDialog
              me={user}
              contact={chatUser}
              verified={keyStatus === 'verified'}
              onChange={(verified) => conversation.setKeyStatus(verified ? 'verified' : 'trusted')}
              onClose={() => setShowSafetyNumber(false)}
            />
          )}

          {chatUser && <CallPanel user={user} peer={chatUser} />}

          {keyBlocked && (
            <ContactKeyWarning status={keyStatus} username={chatName} onAccept={conversation.acceptChangedKey} />
          )}

          {!keyBlocked && (
            <ChatPane
              chatId={id}
              chatName={chatName}
              user={user}
              conversation={conversation}
              reactionsReady={Boolean(sharedKey)}
              saveReaction={saveReaction}
              deleteReaction={removeReaction}
              reactionNames={reactionNames}
              people={people}
            />
          )}
        </>
      )}
    </div>
  );
}
