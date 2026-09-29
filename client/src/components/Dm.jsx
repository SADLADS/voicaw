import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import '../assets/css/dms.css';
import NotificationPrompt from './NotificationPrompt';
import { LayoutContext } from '../contexts';
import ContactKeyWarning from './ContactKeyWarning';
import SafetyNumberDialog from './SafetyNumberDialog';
import EmojiPicker from './EmojiPicker';
import MessageList from './MessageList';
import Composer from './Composer';
import { ConfigContext, InteractionContext } from '../contexts';
import { getKeyboardHeight, watchKeyboardHeight } from '../utils/keyboardHeight';
import { useConversation } from '../hooks/useConversation';
import { useReactions } from '../hooks/useReactions';

// Where the floating reaction picker goes (desktop): by the button that opened it, lined up
// with its right edge, above it if there's room and otherwise below. The picker sits against
// a zero-size fixed box at that point (see `.reaction-picker-anchor` in dms.css).
const REACTION_PICKER_WIDTH = 360;
const REACTION_PICKER_HEIGHT = 420;
function reactionPickerPosition(rect) {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const pickerHeight = Math.min(REACTION_PICKER_HEIGHT, height * 0.6);
  const left = Math.min(Math.max(rect.right, REACTION_PICKER_WIDTH + 12), width - 12);
  const below = rect.top - pickerHeight - 16 < 0;
  const top = below ? Math.min(rect.bottom, height - pickerHeight - 16) : rect.top;
  return { below, style: { left: `${left}px`, top: `${top}px` } };
}

// A DM conversation: header (with the contact's key status), the messages, and the composer.
// The conversation itself (loading, sending, live updates) is useConversation; reacting is
// useReactions; the message box is Composer.
export default function Dm({ user }) {
  const { s3Endpoint, maxPlaintextLength } = useContext(ConfigContext);
  const { isMobile } = useContext(InteractionContext);
  const { users, errorUsers, fetchUnreadMessages } = useContext(LayoutContext);
  const { id } = useParams();
  const chatUser = users.find((u) => u.id.toString() === id);

  const conversation = useConversation({ id, user, chatUser, onRead: fetchUnreadMessages });
  const { messages, keyStatus } = conversation;

  const inputRef = useRef(null);
  const editRef = useRef(null);
  const [showSafetyNumber, setShowSafetyNumber] = useState(false);
  const [hoveredMsgId, setHoveredMsgId] = useState(null);
  const [replyTo, setReplyTo] = useState(null);
  const cancelReply = useCallback(() => setReplyTo(null), []);
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editingMessageContent, setEditingMessageContent] = useState('');
  // Shown above the message box: problems sending, attaching or reacting.
  const [composerError, setComposerError] = useState(null);
  // The composer's emoji picker. It and the reaction picker are never open together.
  const [showEmojiPicker, setShowEmojiPickerState] = useState(false);

  const reactions = useReactions({
    chatId: id,
    user,
    sharedKey: conversation.sharedKey,
    messagesRef: conversation.messagesRef,
    setMessageReactions: conversation.setMessageReactions,
    onError: setComposerError,
  });
  const reactionNames = { [user?.id]: user?.username, [chatUser?.id]: chatUser?.username };

  const setShowEmojiPicker = (open) => {
    if (open) reactions.closePicker();
    setShowEmojiPickerState(open);
  };

  function openReactionPicker(msg, anchor) {
    setShowEmojiPickerState(false);
    if (isMobile) inputRef.current?.blur(); // the panel takes the keyboard's place
    reactions.openPicker(msg, anchor);
  }

  // A new conversation starts with nothing open.
  useEffect(() => {
    setShowSafetyNumber(false);
    setShowEmojiPickerState(false);
    setComposerError(null);
  }, [id]);

  // Remember the keyboard's height (mobile), so the emoji panel can match it.
  useEffect(() => (isMobile ? watchKeyboardHeight() : undefined), [isMobile]);

  function handleEdit(msg) {
    setEditingMessageId(msg.id);
    setEditingMessageContent(msg.plaintext);
    setTimeout(() => {
      const textarea = document.getElementById(`edit-input-${msg.id}`);
      if (textarea) {
        textarea.focus();
        const length = textarea.value.length;
        textarea.setSelectionRange(length, length); // cursor at end
      }
    }, 0);
  }

  async function handleSaveEdit(messageId) {
    try {
      await conversation.editMessage(messageId, editingMessageContent);
      setEditingMessageId(null);
    } catch (err) {
      console.error('Failed to edit message', err);
    }
  }

  async function handleDelete(msg) {
    try {
      await conversation.deleteMessage(msg.id);
    } catch (err) {
      console.error('Failed to delete message', err);
    }
  }

  function handleReply(msg) {
    setReplyTo(msg);
    inputRef.current?.focus();
  }

  // A changed or invalid contact key blocks the conversation until resolved.
  const keyBlocked = keyStatus === 'changed' || keyStatus === 'invalid';
  const { reactingTo } = reactions;

  return (
    <div id="dm-main" data-current-user-id={user?.id} data-other-user-id={chatUser?.id}>
      <NotificationPrompt />
      {errorUsers && <p className="error-text">Error loading users: {errorUsers}</p>}
      {users.length === 0 && !errorUsers && !id && <p>No recent conversations found.</p>}

      {id && (
        <>
          <h4 className="chat-recipient-header">
            {chatUser?.username || 'User'}
            {(keyStatus === 'trusted' || keyStatus === 'verified') && (
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
            <>
              <div className="dm-message-wrapper">
                {conversation.isLoading ? (
                  <p></p>
                ) : conversation.error ? (
                  <p className="error-text">Error: {conversation.error}</p>
                ) : messages.length === 0 ? (
                  <p>No messages yet. Start the conversation!</p>
                ) : (
                  <MessageList
                    messages={messages}
                    user={user}
                    hasMore={conversation.hasMore}
                    loadMoreMessages={conversation.loadMoreMessages}
                    s3Endpoint={s3Endpoint}
                    hoveredMsgId={hoveredMsgId}
                    setHoveredMsgId={setHoveredMsgId}
                    handleEdit={handleEdit}
                    handleDelete={handleDelete}
                    handleReply={handleReply}
                    editingMessageId={editingMessageId}
                    editingMessageContent={editingMessageContent}
                    setEditingMessageContent={setEditingMessageContent}
                    setEditingMessageId={setEditingMessageId}
                    handleSaveEdit={handleSaveEdit}
                    isMobile={isMobile}
                    editRef={editRef}
                    maxPlaintextLength={maxPlaintextLength}
                    onToggleReaction={reactions.toggleReaction}
                    onOpenReactionPicker={openReactionPicker}
                    reactionNames={reactionNames}
                  />
                )}
              </div>

              {reactingTo?.rect && !isMobile && (() => {
                const { below, style } = reactionPickerPosition(reactingTo.rect);
                return (
                  <div className={`reaction-picker-anchor${below ? ' below' : ''}`} style={style}>
                    <EmojiPicker onSelect={reactions.pickReaction} onClose={reactions.closePicker} />
                  </div>
                );
              })()}

              <Composer
                chatId={id}
                chatUser={chatUser}
                isMobile={isMobile}
                maxPlaintextLength={maxPlaintextLength}
                s3Endpoint={s3Endpoint}
                inputRef={inputRef}
                replyTo={replyTo}
                onCancelReply={cancelReply}
                error={composerError}
                setError={setComposerError}
                showEmojiPicker={showEmojiPicker}
                setShowEmojiPicker={setShowEmojiPicker}
                onInputFocus={reactions.closePicker}
                onSend={conversation.sendMessage}
              />

              {reactingTo && isMobile && (
                // Reacting: the same panel as the composer's emoji, closed by the pick.
                <EmojiPicker
                  docked
                  height={getKeyboardHeight()}
                  onSelect={(native) => { reactions.pickReaction(native); reactions.closePicker(); }}
                  onClose={reactions.closePicker}
                />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
