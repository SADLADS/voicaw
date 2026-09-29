import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import EmojiPicker from './EmojiPicker';
import MessageList from './MessageList';
import Composer from './Composer';
import MessageActionSheet from './MessageActionSheet';
import { ConfigContext, InteractionContext } from '../contexts';
import { getKeyboardHeight, watchKeyboardHeight } from '../utils/keyboardHeight';
import { useReactions } from '../hooks/useReactions';
import { summarizeAttachments } from '../utils/attachmentMarkup';
import { reactionPickerPosition } from '../utils/reactionPickerPosition';

// The body of a chat, shared by DMs (Dm) and guild channels (GuildChannel): the messages, the
// composer, reactions (the floating or docked picker) and the mobile action sheet, plus the
// state they share: reply target, the message being edited, the composer's error line and
// which emoji picker is open (never both).
//
// `conversation` is useConversation's or useChannel's result. `saveReaction` /
// `deleteReaction` / `reactionsReady` go to useReactions. `chatId` identifies the chat (things
// reset when it changes), `chatName` is who or what the composer writes to (null while not
// ready to send). `canModerate` lets you delete other people's messages too; `canSend` and
// `canAddReactions` false (a guild channel's permissions) take away the composer (showing
// `cantSendText`) and reacting. `nameColors` ({ userId: '#rrggbb' }) colours names.
export default function ChatPane({
  chatId,
  chatName,
  user,
  conversation,
  reactionsReady,
  saveReaction,
  deleteReaction,
  reactionNames,
  canModerate = false,
  canSend = true,
  cantSendText = "You don't have permission to send messages here.",
  canAddReactions = true,
  nameColors,
  emptyText = 'No messages yet. Start the conversation!',
}) {
  const { s3Endpoint, maxPlaintextLength } = useContext(ConfigContext);
  const { isMobile } = useContext(InteractionContext);
  const { messages } = conversation;

  const inputRef = useRef(null);
  const editRef = useRef(null);
  const [hoveredMsgId, setHoveredMsgId] = useState(null);
  const [replyTo, setReplyTo] = useState(null);
  const cancelReply = useCallback(() => setReplyTo(null), []);
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editingMessageContent, setEditingMessageContent] = useState('');
  // Shown above the message box: problems sending, attaching or reacting.
  const [composerError, setComposerError] = useState(null);
  // The composer's emoji picker. It and the reaction picker are never open together.
  const [showEmojiPicker, setShowEmojiPickerState] = useState(false);
  // Mobile: the message whose action sheet (long press) is open.
  const [actionsForId, setActionsForId] = useState(null);
  const closeActions = useCallback(() => setActionsForId(null), []);

  const reactions = useReactions({
    chatId,
    user,
    ready: reactionsReady,
    saveReaction,
    deleteReaction,
    messagesRef: conversation.messagesRef,
    setMessageReactions: conversation.setMessageReactions,
    onError: setComposerError,
  });

  const setShowEmojiPicker = (open) => {
    if (open) reactions.closePicker();
    setShowEmojiPickerState(open);
  };

  function openReactionPicker(msg, anchor) {
    setShowEmojiPickerState(false);
    if (isMobile) inputRef.current?.blur(); // the panel takes the keyboard's place
    reactions.openPicker(msg, anchor);
  }

  function openActions(msg) {
    inputRef.current?.blur(); // the keyboard would cover the sheet
    setShowEmojiPickerState(false);
    reactions.closePicker();
    setActionsForId(msg.id);
  }

  // Copies what the message says; attachments become their names (their links carry the
  // decryption key, which shouldn't end up pasted elsewhere).
  async function copyMessage(msg) {
    try {
      await navigator.clipboard.writeText(summarizeAttachments(msg.plaintext));
    } catch (err) {
      console.error('Copy failed', err);
      setComposerError("Couldn't copy the message.");
    }
  }

  // A new chat starts with nothing open.
  useEffect(() => {
    setActionsForId(null);
    setShowEmojiPickerState(false);
    setComposerError(null);
    setReplyTo(null);
    setEditingMessageId(null);
  }, [chatId]);

  // Remember the keyboard's height (mobile), so the emoji panel can match it.
  useEffect(() => (isMobile ? watchKeyboardHeight() : undefined), [isMobile]);

  // The inline editor opens focused, with the cursor at the end.
  function handleEdit(msg) {
    setEditingMessageId(msg.id);
    setEditingMessageContent(msg.plaintext);
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

  const { reactingTo } = reactions;
  const actionsFor = actionsForId != null ? messages.find((m) => m.id === actionsForId) : null;

  return (
    <>
      <div className="dm-message-wrapper">
        {conversation.isLoading ? (
          <p></p>
        ) : conversation.error ? (
          <p className="error-text">Error: {conversation.error}</p>
        ) : messages.length === 0 ? (
          <p className="chat-empty">{emptyText}</p>
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
            onOpenActions={openActions}
            canModerate={canModerate}
            canAddReactions={canAddReactions}
            nameColors={nameColors}
            // While reacting to a message (or its mobile menu is open), it stays
            // highlighted and the others don't react to hovering.
            focusedMsgId={reactingTo?.msgId ?? actionsForId}
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

      {!canSend ? (
        <div className="composer-locked" role="status">{cantSendText}</div>
      ) : <Composer
        chatId={chatId}
        chatName={chatName}
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
      />}

      {actionsFor && (
        <MessageActionSheet
          msg={actionsFor}
          isOwn={actionsFor.sender_id === user.id}
          canDelete={actionsFor.sender_id === user.id || canModerate}
          canReact={canAddReactions}
          myReactions={new Set((actionsFor.reactions ?? []).filter((r) => r.user_id === user.id).map((r) => r.emoji))}
          onReact={(emoji) => reactions.toggleReaction(actionsFor, emoji)}
          onMoreReactions={() => openReactionPicker(actionsFor, null)}
          onReply={() => handleReply(actionsFor)}
          onEdit={() => handleEdit(actionsFor)}
          onCopy={() => copyMessage(actionsFor)}
          onDelete={() => handleDelete(actionsFor)}
          onClose={closeActions}
        />
      )}

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
  );
}
