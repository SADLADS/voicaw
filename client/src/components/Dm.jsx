import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPhone, faThumbtack } from '@fortawesome/free-solid-svg-icons';
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
import { isDeleted, nameOf, useProfiles } from '../utils/profiles';
import { unblockUser, useBlocked } from '../utils/blocks';
import { t } from '../i18n';

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

  // The pinned messages list, under its header button (null: closed).
  const [pinsAnchor, setPinsAnchor] = useState(null);
  const closePins = useCallback(() => setPinsAnchor(null), []);
  const togglePins = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setPinsAnchor((open) => (open ? null : rect));
  };
  const profilesVersion = useProfiles();
  const chatName = chatUser ? nameOf(chatUser) : null;
  const deleted = isDeleted(chatUser);
  // You blocked them (utils/blocks.js): no messages or calls until you unblock.
  const blockedThem = useBlocked().has(Number(chatUser?.id));
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

  useEffect(() => {
    setShowSafetyNumber(false);
    setPinsAnchor(null);
  }, [id]);

  // A changed or invalid contact key blocks the conversation until resolved.
  const keyBlocked = keyStatus === 'changed' || keyStatus === 'invalid';

  const prompts = <><RecoveryPrompt user={user} /><NotificationPrompt /></>;

  return (
    <div id="dm-main" data-current-user-id={user?.id} data-other-user-id={chatUser?.id}>
      {/* Banners go under the header (when there is one), so it lines up with the list's. */}
      {!id && prompts}
      {errorUsers && <p className="error-text">{t('chat.dm.loadUsersError', { error: errorUsers })}</p>}
      {users.length === 0 && !errorUsers && !id && <p>{t('chat.dm.noConversations')}</p>}

      {id && (
        <>
          <h4 className="chat-recipient-header">
            {chatName || t('chat.composer.fallbackName')}
            {presence?.status === 'offline' && (
              <span className="chat-recipient-status">
                {lastSeenText(presence.lastOnline) ?? statusLabel('offline')}
              </span>
            )}
            {blockedThem && (
              <button type="button" className="btn btn-sm btn-secondary chat-unblock-button" onClick={() => unblockUser(chatUser.id).catch(() => {})}>
                {t('chat.blocked.unblock')}
              </button>
            )}
            {voiceEnabled && chatUser && sharedKey && !keyBlocked && !deleted && !blockedThem && (
              <button
                type="button"
                className="chat-call-button"
                aria-label={t('chat.dm.call', { name: chatName })}
                title={call ? t('chat.dm.alreadyInCall') : t('chat.dm.startCall', { name: chatName })}
                disabled={Boolean(call)}
                onClick={() => startCall(chatUser)}
              >
                <FontAwesomeIcon icon={faPhone} />
              </button>
            )}
            {chatUser && sharedKey && !keyBlocked && (
              <button
              type="button"
              className={`chat-call-button pins-button${pinsAnchor ? ' active' : ''}`}
              aria-label={t('chat.pins.title')}
              aria-pressed={Boolean(pinsAnchor)}
              title={t('chat.pins.title')}
              onClick={togglePins}
            >
              <FontAwesomeIcon icon={faThumbtack} />
            </button>
            )}
            {SHOW_SAFETY_NUMBERS && (keyStatus === 'trusted' || keyStatus === 'verified') && (
              <button
                type="button"
                className={`key-status-badge ${keyStatus}`}
                onClick={() => setShowSafetyNumber(true)}
                title={t('chat.safetyNumber.compare')}
              >
                {keyStatus === 'verified' ? t('chat.safetyNumber.verified') : t('chat.safetyNumber.notVerified')}
              </button>
            )}
          </h4>
          {prompts}

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
              pollKind="dm"
              chatId={id}
              chatName={chatName}
              user={user}
              conversation={conversation}
              reactionsReady={Boolean(sharedKey)}
              saveReaction={saveReaction}
              deleteReaction={removeReaction}
              reactionNames={reactionNames}
              people={people}
              pinsAnchor={pinsAnchor}
              onClosePins={closePins}
              canSend={!deleted && !blockedThem}
              cantSendText={deleted ? t('chat.dm.accountDeleted') : t('chat.blocked.youBlocked', { name: chatName })}
            />
          )}
        </>
      )}
    </div>
  );
}
