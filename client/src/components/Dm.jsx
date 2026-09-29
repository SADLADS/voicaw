import React, { useContext, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import '../assets/css/dms.css';
import NotificationPrompt from './NotificationPrompt';
import RecoveryPrompt from './RecoveryPrompt';
import { LayoutContext } from '../contexts';
import ContactKeyWarning from './ContactKeyWarning';
import SafetyNumberDialog from './SafetyNumberDialog';
import ChatPane from './ChatPane';
import { useConversation } from '../hooks/useConversation';
import { addReaction, removeReaction } from '../services/dmService';
import { encryptReaction, reactionContext } from '../services/encryptionService';
import { usePresence } from '../hooks/usePresence';
import { lastSeenText, statusLabel } from '../utils/presence';

// The "Verified / Not verified" badge and safety number dialog. Hidden for now: too confusing
// for most people. The keys are still pinned and a changed key still blocks the chat.
const SHOW_SAFETY_NUMBERS = false;

// A DM conversation: header (with the contact's key status), then the chat itself (ChatPane).
// The conversation (loading, sending, live updates) is useConversation.
export default function Dm({ user }) {
  const { users, errorUsers, fetchUnreadMessages } = useContext(LayoutContext);
  const { id } = useParams();
  const chatUser = users.find((u) => u.id.toString() === id);
  const presenceOf = usePresence();
  const presence = chatUser ? presenceOf(chatUser) : null;

  const conversation = useConversation({ id, user, chatUser, onRead: fetchUnreadMessages });
  const { keyStatus, sharedKey } = conversation;
  const [showSafetyNumber, setShowSafetyNumber] = useState(false);
  const reactionNames = { [user?.id]: user?.username, [chatUser?.id]: chatUser?.username };

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
            {chatUser?.username || 'User'}
            {presence && (
              <span className={`chat-recipient-status ${presence.status}`}>
                {presence.status === 'offline' ? lastSeenText(presence.lastOnline) ?? statusLabel(presence.status) : statusLabel(presence.status)}
              </span>
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

          {keyBlocked && (
            <ContactKeyWarning status={keyStatus} username={chatUser?.username} onAccept={conversation.acceptChangedKey} />
          )}

          {!keyBlocked && (
            <ChatPane
              chatId={id}
              chatName={chatUser?.username}
              user={user}
              conversation={conversation}
              reactionsReady={Boolean(sharedKey)}
              saveReaction={saveReaction}
              deleteReaction={removeReaction}
              reactionNames={reactionNames}
            />
          )}
        </>
      )}
    </div>
  );
}
