import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { faPhone, faThumbtack } from '@fortawesome/free-solid-svg-icons';
import { useParams } from 'react-router-dom';
import '../assets/css/dms.css';
import '../assets/css/voice.css';
import NotificationPrompt from './NotificationPrompt';
import RecoveryPrompt from './RecoveryPrompt';
import { ConfigContext, InteractionContext, LayoutContext } from '../contexts';
import PaneBackButton from './PaneBackButton';
import CallPanel from './call/CallPanel';
import { useCall } from '../hooks/useCall';
import { startCall } from '../voice/callClient';
import Avatar from './Avatar';
import StatusIcon from './StatusIcon';
import ContactKeyWarning from './ContactKeyWarning';
import SafetyNumberDialog from './SafetyNumberDialog';
import ChatPane from './ChatPane';
import ChatSearch from './ChatSearch';
import { useConversation } from '../hooks/useConversation';
import { addReaction, removeReaction } from '../services/dmService';
import { encryptReaction, reactionContext } from '../services/encryptionService';
import { usePresence } from '../hooks/usePresence';
import { lastSeenText, statusLabel } from '../utils/presence';
import { isDeleted, nameOf, useProfiles } from '../utils/profiles';
import { unblockUser, useBlocked } from '../utils/blocks';
import { usePrivacyPrefs } from '../utils/privacy';
import { t } from '../i18n';

// A DM conversation: header (with the contact's status and the call button), the call with
// them if there is one (CallPanel), then the chat itself (ChatPane).
// The conversation (loading, sending, live updates) is useConversation.
export default function Dm({ user }) {
  const { users, errorUsers, fetchUnreadMessages } = useContext(LayoutContext);
  const { voiceEnabled } = useContext(ConfigContext);
  const { isMobile } = useContext(InteractionContext);
  const call = useCall();
  const { id } = useParams();
  const chatUser = users.find((u) => u.id.toString() === id);
  const presenceOf = usePresence();
  const presence = chatUser ? presenceOf(chatUser) : null;

  const conversation = useConversation({ id, user, chatUser, onRead: fetchUnreadMessages });
  const { keyStatus, sharedKey } = conversation;
  const [showSafetyNumber, setShowSafetyNumber] = useState(false);
  const { safetyNumbers: safetyNumbersOn } = usePrivacyPrefs();

  // The pinned messages list, under its header button (null: closed).
  const [pinsAnchor, setPinsAnchor] = useState(null);
  const closePins = useCallback(() => setPinsAnchor(null), []);
  // A search result to scroll to ({ messageId }; ChatPane's jumpTo).
  const [jumpTarget, setJumpTarget] = useState(null);
  const clearJump = useCallback(() => setJumpTarget(null), []);
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
    setJumpTarget(null);
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
            <PaneBackButton />
            {chatUser && (
              <span className="chat-recipient-avatar status-avatar">
                <Avatar userId={chatUser.id} alt="" className="chat-recipient-avatar-img" />
                {presence && <StatusIcon status={presence.status} />}
              </span>
            )}
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
                <Icon icon={faPhone} />
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
              <Icon icon={faThumbtack} />
            </button>
            )}
            {chatUser && sharedKey && !keyBlocked && (
              <ChatSearch
                scopeId={id}
                chatName={chatName}
                conversation={conversation}
                people={people}
                user={user}
                isMobile={isMobile}
                onJump={(msg) => setJumpTarget({ messageId: msg.id })}
                reactionNames={reactionNames}
              />
            )}
            {/* The "Verified / Not verified" badge, opening the safety number: only with Settings →
                Privacy's Show safety numbers (off by default; the keys are pinned either way). */}
            {safetyNumbersOn && (keyStatus === 'trusted' || keyStatus === 'verified') && (
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

          {safetyNumbersOn && showSafetyNumber && (
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
              jumpTo={jumpTarget}
              onJumped={clearJump}
              canSend={!deleted && !blockedThem}
              cantSendText={deleted ? t('chat.dm.accountDeleted') : t('chat.blocked.youBlocked', { name: chatName })}
            />
          )}
        </>
      )}
    </div>
  );
}
