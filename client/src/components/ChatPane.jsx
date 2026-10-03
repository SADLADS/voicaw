import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import EmojiPicker from './EmojiPicker';
import MessageList from './MessageList';
import Composer from './Composer';
import TypingIndicator from './TypingIndicator';
import MessageActionSheet from './MessageActionSheet';
import MessageMenu from './MessageMenu';
import ConfirmDialog from './guild/ConfirmDialog';
import PinnedMessages from './PinnedMessages';
import PollDialog from './PollDialog';
import { ChannelMentionContext, ConfigContext, InteractionContext, ThreadContext } from '../contexts';
import { getKeyboardHeight, watchKeyboardHeight } from '../utils/keyboardHeight';
import { useReactions } from '../hooks/useReactions';
import { summarizeAttachments } from '../utils/attachmentMarkup';
import { customEmojiToText } from '../emoji/customEmoji';
import { mentionsToText } from '../utils/mentions';
import { hideSpoilers } from '../utils/remarkDiscord';
import { reactionPickerPosition } from '../utils/reactionPickerPosition';
import { displayName } from '../utils/profiles';
import { t } from '../i18n';
import { clearTyping } from '../utils/typing';
import { endPoll, parsePoll, pollEnded, pollMarkup } from '../utils/pollMarkup';
import { endPollOnServer, registerPollTimer } from '../services/pollService';

// The body of a chat, shared by DMs (Dm) and guild channels (GuildChannel): the messages, the
// composer, reactions (the floating or docked picker), the desktop right-click menu and the
// mobile action sheet, plus the
// state they share: reply target, the message being edited, the composer's error line and
// which emoji picker is open (never both).
//
// `conversation` is useConversation's or useChannel's result. `saveReaction` /
// `deleteReaction` / `reactionsReady` go to useReactions. `chatId` identifies the chat (things
// reset when it changes), `chatName` is who or what the composer writes to (null while not
// ready to send). `canModerate` lets you delete other people's messages too; `canSend` and
// `canAddReactions` false (a guild channel's permissions) take away the composer (showing
// `cantSendText`) and reacting. `nameColors` ({ userId: '#rrggbb' }) colours names.
// `reactionNames` ({ userId: username }) names who reacted and who's mentioned; `people`
// ([{ id, username }]) are who can be mentioned ("@name" suggestions). In a guild,
// `mentionRoles` ({ roleId: { name, color } }) draws role mentions, `myRoleIds` are yours,
// `suggestRoles` ([{ id, name, color }]) the roles you may mention, and `canMentionEveryone`
// adds @everyone and @here; `channels` ([{ id, name, type, private, category }]) are the
// channels "#name" suggests. `canPin` lets you pin and unpin (always in DMs and groups; Pin
// Messages in a channel). `pinsAnchor` (the header pin button's rect, or null) opens the
// pinned messages list; `onClosePins` closes it. `pollKind` ('dm', 'group' or 'guild') is
// the chat's kind for the server's poll timers (pollService). `jumpTo` ({ messageId }, a new object each
// time) scrolls to that message once the chat is loaded, then calls `onJumped`.
export default function ChatPane({
  chatId,
  chatName,
  user,
  conversation,
  reactionsReady,
  saveReaction,
  deleteReaction,
  reactionNames,
  people,
  mentionRoles,
  myRoleIds,
  suggestRoles,
  canMentionEveryone = false,
  channels,
  canModerate = false,
  canSend = true,
  cantSendText = t('chat.pane.cantSend'),
  canAddReactions = true,
  canPin = true,
  pinsAnchor = null,
  onClosePins,
  jumpTo = null,
  onJumped,
  nameColors,
  encrypted = true,
  pollKind,
  emptyText = t('chat.pane.empty'),
}) {
  const { s3Endpoint, maxPlaintextLength } = useContext(ConfigContext);
  const { isMobile } = useContext(InteractionContext);
  const mentionChannels = useContext(ChannelMentionContext)?.channels;
  // In a guild text channel you may start threads in: Create Thread on messages that have none.
  const threads = useContext(ThreadContext);
  const threadFrom = (msg) => (threads?.createThread && !msg.thread && !msg.system && Number.isInteger(msg.id)
    ? () => threads.createThread(msg)
    : undefined);
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
  // Desktop: the message whose right-click menu is open, { id, anchor (where it was clicked) }.
  const [menuFor, setMenuFor] = useState(null);
  const closeMenu = useCallback(() => setMenuFor(null), []);
  // The message the "Delete message?" dialog is asking about.
  const [confirmingDelete, setConfirmingDelete] = useState(null);
  // A poll being edited: { msg, poll } (polls are edited in PollDialog, not inline).
  const [editingPoll, setEditingPoll] = useState(null);

  // For jumping to a message, which waits for older pages: always the newest conversation.
  const latestConversation = useRef(conversation);
  latestConversation.current = conversation;

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

  function openMenu(msg, anchor) {
    reactions.closePicker();
    setMenuFor({ id: msg.id, anchor });
  }

  // Copies what the message says; attachments become their names (their links carry the
  // decryption key, which shouldn't end up pasted elsewhere), custom emoji `:name:`, mentions
  // `@name`. copyText throws if it couldn't (the menu shows that); copyMessage says so above
  // the message box.
  function copyText(msg) {
    return navigator.clipboard.writeText(mentionsToText(customEmojiToText(summarizeAttachments(msg.plaintext)), reactionNames, mentionRoles, mentionChannels));
  }

  async function copyMessage(msg) {
    try {
      await copyText(msg);
    } catch (err) {
      console.error('Copy failed', err);
      setComposerError(t('chat.pane.copyFailed'));
    }
  }

  // A new chat starts with nothing open.
  useEffect(() => {
    setActionsForId(null);
    setMenuFor(null);
    setConfirmingDelete(null);
    setShowEmojiPickerState(false);
    setComposerError(null);
    setReplyTo(null);
    setEditingMessageId(null);
    setEditingPoll(null);
  }, [chatId]);

  // Someone's message arriving means they've stopped typing (it can beat their typing timeout).
  const newest = messages[messages.length - 1];
  useEffect(() => {
    if (newest?.sender_id != null) clearTyping(chatId, newest.sender_id);
  }, [chatId, newest?.id, newest?.sender_id]);

  // Remember the keyboard's height (mobile), so the emoji panel can match it.
  useEffect(() => (isMobile ? watchKeyboardHeight() : undefined), [isMobile]);

  // The inline editor opens focused, with the cursor at the end. A poll opens its dialog.
  function handleEdit(msg) {
    const poll = parsePoll(msg.plaintext);
    if (poll) {
      if (isClosedPoll(msg)) setComposerError(t('chat.pane.pollClosedEdit'));
      else setEditingPoll({ msg, poll });
      return;
    }
    setEditingMessageId(msg.id);
    setEditingMessageContent(msg.plaintext);
  }

  async function handleSaveEdit(messageId) {
    // Emptied (or only whitespace left): the same as cancelling.
    if (!editingMessageContent.trim()) {
      setEditingMessageId(null);
      return;
    }
    try {
      await conversation.editMessage(messageId, editingMessageContent);
      setEditingMessageId(null);
    } catch (err) {
      console.error('Failed to edit message', err);
    }
  }

  function isClosedPoll(msg) {
    const poll = parsePoll(msg.plaintext);
    return Boolean(poll && pollEnded(poll, msg.timestamp));
  }

  // Sends a poll, then tells the server when it closes (for its "poll ended" row). If that
  // fails the poll still closes on time, just without the row.
  async function sendPoll({ poll, replyTo }) {
    const text = pollMarkup(poll);
    if (text.length > maxPlaintextLength) throw new Error(t('chat.pane.pollTooLong'));
    const saved = await conversation.sendMessage({ text, replyTo });
    try {
      await registerPollTimer(pollKind, saved.id, poll.duration);
    } catch (err) {
      console.error('Failed to register the poll', err);
      setComposerError(t('chat.pane.pollTimerFailed'));
    }
  }

  // The author ends their poll now: an edit that stamps the time (see pollMarkup's endPoll),
  // so it's closed for everyone at once, then the server posts its "poll ended" row.
  async function endPollNow(msg) {
    const poll = parsePoll(msg.plaintext);
    if (!poll || isClosedPoll(msg)) return;
    await conversation.editMessage(msg.id, pollMarkup(endPoll(poll)));
    await endPollOnServer(pollKind, msg.id);
  }

  async function handleDelete(msg) {
    try {
      await conversation.deleteMessage(msg.id);
    } catch (err) {
      console.error('Failed to delete message', err);
    }
  }

  // The hover and right-click menus' delete: asks first (with the message shown), unless Shift is held. (The
  // mobile action sheet asks in its own way.)
  function requestDelete(msg, event) {
    if (event?.shiftKey) handleDelete(msg);
    else setConfirmingDelete(msg);
  }

  async function togglePin(msg) {
    try {
      await conversation.setPinned(msg, !msg.pinned_at);
    } catch (err) {
      console.error('Failed to pin message', err);
      setComposerError(err.response?.data?.error || (msg.pinned_at ? t('chat.pane.unpinFailed') : t('chat.pane.pinFailed')));
    }
  }

  // Scrolls the chat to message `id` (loading older history until it's there) and flashes it.
  async function jumpToMessage(id) {
    if (isMobile) onClosePins?.();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const row = document.querySelector(`.message-scroller [data-msg-id="${id}"]`);
      if (row) {
        row.scrollIntoView({ block: 'center' });
        row.classList.remove('jump-highlight');
        void row.offsetWidth; // restarts the animation when jumping to the same one again
        row.classList.add('jump-highlight');
        setTimeout(() => row.classList.remove('jump-highlight'), 2000);
        return;
      }
      const current = latestConversation.current;
      if (!current.hasMore) break;
      await current.loadMoreMessages();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    setComposerError(t('chat.pane.jumpFailed'));
  }

  useEffect(() => {
    if (!jumpTo) return;
    jumpToMessage(jumpTo.messageId);
    onJumped?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo]);

  function handleReply(msg) {
    setReplyTo(msg);
    inputRef.current?.focus();
  }

  const { reactingTo } = reactions;
  const actionsFor = actionsForId != null ? messages.find((m) => m.id === actionsForId) : null;
  // Gone if the message was deleted meanwhile.
  const menuMsg = menuFor ? messages.find((m) => m.id === menuFor.id) : null;

  return (
    <>
      <div className="dm-message-wrapper">
        {conversation.isLoading ? (
          <p></p>
        ) : conversation.error ? (
          <p className="error-text">{t('chat.pane.error', { error: conversation.error })}</p>
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
            handleDelete={requestDelete}
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
            onVote={reactions.vote}
            onEndPoll={endPollNow}
            onJumpToMessage={jumpToMessage}
            reactionNames={reactionNames}
            onOpenActions={openActions}
            onOpenMenu={openMenu}
            canModerate={canModerate}
            canAddReactions={canAddReactions}
            canPin={canPin}
            onTogglePin={togglePin}
            nameColors={nameColors}
            mentionRoles={mentionRoles}
            myRoleIds={myRoleIds}
            encrypted={encrypted}
            // While reacting to a message (or its menu is open), it stays highlighted and
            // the others don't react to hovering.
            focusedMsgId={reactingTo?.msgId ?? actionsForId ?? menuMsg?.id}
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

      <TypingIndicator chatId={chatId} names={reactionNames} />

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
        onSendPoll={sendPoll}
        people={people}
        roles={suggestRoles}
        roleInfo={mentionRoles}
        canMentionEveryone={canMentionEveryone}
        channels={channels}
      />}

      {confirmingDelete && (
        <ConfirmDialog
          title={t('chat.deleteMessage.title')}
          message={t('chat.deleteMessage.confirm')}
          confirmLabel={t('common.delete')}
          focusConfirm
          onConfirm={() => conversation.deleteMessage(confirmingDelete.id)}
          onClose={() => setConfirmingDelete(null)}
        >
          <div className="delete-preview">
            <strong style={{ color: nameColors?.[confirmingDelete.sender_id] }}>{displayName(confirmingDelete.sender_id, confirmingDelete.sender_username)}</strong>
            <span>
              {mentionsToText(customEmojiToText(hideSpoilers(summarizeAttachments(confirmingDelete.plaintext ?? ''))), reactionNames, mentionRoles, mentionChannels)}
            </span>
          </div>
          <p className="vc-hint">{t('chat.deleteMessage.shiftTip')}</p>
        </ConfirmDialog>
      )}

      {editingPoll && (
        <PollDialog
          poll={editingPoll.poll}
          onSubmit={async (poll) => {
            const text = pollMarkup(poll);
            if (text.length > maxPlaintextLength) throw new Error(t('chat.pane.pollTooLong'));
            await conversation.editMessage(editingPoll.msg.id, text);
          }}
          onClose={() => setEditingPoll(null)}
        />
      )}

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
          onEdit={isClosedPoll(actionsFor) ? undefined : () => handleEdit(actionsFor)}
          onTogglePin={canPin ? () => togglePin(actionsFor) : undefined}
          onCreateThread={threadFrom(actionsFor)}
          onCopy={() => copyMessage(actionsFor)}
          onDelete={() => handleDelete(actionsFor)}
          onClose={closeActions}
        />
      )}

      {menuMsg && (
        <MessageMenu
          msg={menuMsg}
          anchor={menuFor.anchor}
          isOwn={menuMsg.sender_id === user.id}
          canDelete={menuMsg.sender_id === user.id || canModerate}
          canReact={canAddReactions}
          myReactions={new Set((menuMsg.reactions ?? []).filter((r) => r.user_id === user.id).map((r) => r.emoji))}
          onReact={(emoji) => reactions.toggleReaction(menuMsg, emoji)}
          onMoreReactions={(rect) => openReactionPicker(menuMsg, { getBoundingClientRect: () => rect })}
          onReply={() => handleReply(menuMsg)}
          onEdit={isClosedPoll(menuMsg) ? undefined : () => handleEdit(menuMsg)}
          onTogglePin={canPin ? () => togglePin(menuMsg) : undefined}
          onCreateThread={threadFrom(menuMsg)}
          onCopy={() => copyText(menuMsg)}
          onDelete={(event) => requestDelete(menuMsg, event)}
          onClose={closeMenu}
        />
      )}

      {pinsAnchor && (
        <PinnedMessages
          anchor={pinsAnchor}
          isMobile={isMobile}
          loadPins={conversation.loadPins}
          pinsVersion={conversation.pinsVersion}
          canPin={canPin}
          onUnpin={(msg) => conversation.setPinned(msg, false)}
          onJump={(msg) => jumpToMessage(msg.id)}
          onClose={onClosePins}
          user={user}
          s3Endpoint={s3Endpoint}
          reactionNames={reactionNames}
          mentionRoles={mentionRoles}
          myRoleIds={myRoleIds}
          nameColors={nameColors}
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
