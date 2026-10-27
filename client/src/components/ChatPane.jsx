import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import EmojiPicker from './EmojiPicker';
import MessageList from './MessageList';
import Composer from './Composer';
import TypingIndicator from './TypingIndicator';
import MessageActionSheet from './MessageActionSheet';
import MessageMenu from './MessageMenu';
import ConfirmDialog from './guild/ConfirmDialog';
import PinnedMessages from './PinnedMessages';
import PollDialog from './PollDialog';
import EditHistoryDialog from './EditHistoryDialog';
import ForwardDialog from './ForwardDialog';
import { forwardSource, isForward, parseForward } from '../utils/forwardMarkup';
import { hasEditHistory } from '../utils/editHistory';
import { ChannelMentionContext, ConfigContext, InteractionContext, ThreadContext } from '../contexts';
import { getKeyboardHeight, watchKeyboardHeight } from '../utils/keyboardHeight';
import { useReactions } from '../hooks/useReactions';
import { useNewDivider } from '../hooks/useNewDivider';
import { useUnsentMessages } from '../hooks/useUnsentMessages';
import { isVoiceMessage, summarizeAttachments } from '../utils/attachmentMarkup';
import { customEmojiToText } from '../emoji/customEmoji';
import { useEmojiIndex } from '../emoji/emojiContext';
import { recordReactionUse } from '../emoji/quickReactions';
import { mentionsToText } from '../utils/mentions';
import { hideSpoilers } from '../utils/remarkDiscord';
import { reactionPickerPosition } from '../utils/reactionPickerPosition';
import { displayName } from '../utils/profiles';
import { useChannelCommands } from '../hooks/useChannelCommands';
import { handleInteractionResult, runCommand } from '../services/interactionService';
import { interactionError } from '../utils/commandOptions';
import { t } from '../i18n';
import { flashRow } from '../utils/flashRow';
import { drawnByApp, linksIn, SUPPRESS_EMBEDS } from '../utils/linkPreviews';
import { clearTyping } from '../utils/typing';
import { endPoll, parsePoll, pollEnded, pollMarkup, pollWithAnswers } from '../utils/pollMarkup';
import { endPollOnServer, registerPollTimer, removeGuildPollAnswer } from '../services/pollService';
import ReportDialog from './ReportDialog';
import ReactionsDialog from './ReactionsDialog';
import { groupReactions } from '../utils/reactions';

// The body of a chat, shared by DMs (Dm) and guild channels (GuildChannel): the messages, the
// composer, reactions (the floating or docked picker), the desktop right-click menu and the
// mobile action sheet, plus the
// state they share: reply target, the message being edited, the composer's error line and
// which emoji picker is open (never both).
//
// `conversation` is useConversation's or useChannel's result. `saveReaction` /
// `deleteReaction` / `reactionsReady` go to useReactions. `chatId` identifies the chat (things
// reset when it changes), `chatName` is who or what the composer writes to (null while not
// ready to send); `chatTexts` replaces what the composer says about it (see Composer).
// `canModerate` lets you delete other people's messages too; `canSend` and
// `canAddReactions` false (a guild channel's permissions) take away the composer (showing
// `cantSendText`) and reacting. `nameColors` ({ userId: '#rrggbb' }) colours names.
// `reactionNames` ({ userId: username }) names who reacted and who's mentioned; `people`
// ([{ id, username }]) are who can be mentioned ("@name" suggestions). In a guild,
// `mentionRoles` ({ roleId: { name, color } }) draws role mentions, `myRoleIds` are yours,
// `suggestRoles` ([{ id, name, color }]) the roles you may mention, and `canMentionEveryone`
// adds @everyone and @here; `channels` ([{ id, name, type, private, category }]) are the
// channels "#name" suggests. `canPin` lets you pin and unpin (always in DMs and groups; Pin
// Messages in a channel). `pinsAnchor` (the header pin button's rect, or null) opens the
// pinned messages list; `onClosePins` closes it, `onShowPins` opens it (from a "pinned a
// message" row). `pollKind` ('dm', 'group' or 'guild') is
// the chat's kind for the server's poll timers (pollService). `jumpTo` ({ messageId }, a new object each
// time) scrolls to that message once the chat is loaded, then calls `onJumped`.
// `focusOnOpen` false keeps the composer from taking the focus when the chat opens.
// `textOnly` (a bot DM) leaves only text: no files, polls or replies (see Composer).
// `listHead` is drawn above the first message, scrolling with them (a thread's start); with
// one, an empty chat shows it instead of `emptyText`. `conversation.firstUnread` places the
// "New" divider (useNewDivider).
const noHover = () => {};

export default function ChatPane({
  chatId,
  chatName,
  chatTexts,
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
  onShowPins,
  jumpTo = null,
  onJumped,
  focusOnOpen = true,
  nameColors,
  encrypted = true,
  textOnly = false,
  pollKind,
  emptyText = t('chat.pane.empty'),
  listHead = null,
}) {
  const { s3Endpoint, maxPlaintextLength } = useContext(ConfigContext);
  // Shown from the offline copy (services/offlineCopy.js): read-only, only Copy is left.
  const readOnly = Boolean(conversation.offlineCopy);
  if (readOnly) {
    canSend = false;
    cantSendText = t('app.offline.chatNotice');
    canAddReactions = false;
    canPin = false;
    canModerate = false;
  }
  const { isMobile } = useContext(InteractionContext);
  const mentionChannels = useContext(ChannelMentionContext)?.channels;
  // In a guild text channel you may start threads in: Create Thread on messages that have none.
  const threads = useContext(ThreadContext);
  const threadFrom = (msg) => (threads?.createThread && !msg.thread && !msg.system && Number.isInteger(msg.id)
    ? () => threads.createThread(msg)
    : undefined);
  // Messages that couldn't be sent stay at the end, with Retry and Delete (useUnsentMessages).
  const { rows: unsentRows, send: sendKeepingUnsent, retry: retryUnsent, discard: discardUnsentId } = useUnsentMessages({
    chatId, user, sendMessage: conversation.sendMessage, messages: conversation.messages,
  });
  const messages = useMemo(
    () => (unsentRows.length ? [...conversation.messages, ...unsentRows] : conversation.messages),
    [conversation.messages, unsentRows]
  );
  const newFrom = useNewDivider({ chatId, firstUnread: conversation.firstUnread, isLoading: conversation.isLoading, messages, userId: user?.id });
  // A guild channel or thread (not encrypted, chat id "channel-<id>"): its bots' commands, for
  // the "/" list (Composer) and the message menus' Apps.
  const commandChannelId = !encrypted ? Number(/^channel-(\d+)$/.exec(chatId ?? '')?.[1]) || null : null;
  const { commands, refresh: refreshCommands } = useChannelCommands(commandChannelId, { enabled: commandChannelId != null });
  const messageApps = commands.filter((c) => c.type === 3);

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
  // The message whose reactions the menu's View Reactions is showing (ReactionsDialog).
  const [reactionsForId, setReactionsForId] = useState(null);
  const closeReactions = useCallback(() => setReactionsForId(null), []);
  // The message the "Delete message?" dialog is asking about.
  const [confirmingDelete, setConfirmingDelete] = useState(null);
  // The message whose previews the "Remove previews?" dialog is asking about (the X on one).
  const [confirmingRemovePreviews, setConfirmingRemovePreviews] = useState(null);
  // The message being reported (ReportDialog): anyone else's real message, sent.
  const [reporting, setReporting] = useState(null);
  const reportable = (msg) => Boolean(pollKind) && msg.sender_id !== user.id && !msg.system && !msg.ephemeral &&
    msg.status !== 'pending' && msg.status !== 'failed';
  // The message whose edit history is open (EditHistoryDialog), from its "edited".
  const [editsFor, setEditsFor] = useState(null);
  const showEditsFor = (msg) => (conversation.loadEdits && hasEditHistory(msg) ? () => setEditsFor(msg) : undefined);
  // A poll being edited: { msg, poll } (polls are edited in PollDialog, not inline).
  const [editingPoll, setEditingPoll] = useState(null);
  // What Forward is sending (ForwardDialog picks where): forwardSource's { content, at }.
  const [forwarding, setForwarding] = useState(null);
  const forwardFor = (msg) => {
    const source = readOnly ? null : forwardSource(msg);
    return source ? () => setForwarding(source) : undefined;
  };
  const openForward = useCallback((msg) => {
    const source = forwardSource(msg);
    if (source) setForwarding(source);
  }, []);
  // A closed poll, a voice message and a forward can't be edited.
  const editable = (msg) => !isClosedPoll(msg) && !isVoiceMessage(msg.plaintext) && !isForward(msg.plaintext);

  // For jumping to a message, which waits for older pages: always the newest conversation.
  const latestConversation = useRef(conversation);
  latestConversation.current = conversation;

  const reactions = useReactions({
    chatId,
    user,
    ready: reactionsReady,
    saveReaction,
    deleteReaction,
    // In a guild the server removes added poll answers (moderators may too).
    removePollAnswer: pollKind === 'guild' ? (msg, optionId) => removeGuildPollAnswer(msg.id, optionId) : undefined,
    messagesRef: conversation.messagesRef,
    setMessageReactions: conversation.setMessageReactions,
    onError: setComposerError,
  });
  const emojiIndex = useEmojiIndex();

  // A reaction added from the quick reactions or by clicking someone's counts as using that
  // emoji, so the quick reactions become the ones you use (the picker counts its own).
  const toggleReaction = (msg, emoji) => {
    const current = conversation.messagesRef.current.find((m) => m.id === msg.id) ?? msg;
    if (!(current.reactions ?? []).some((r) => r.user_id === user.id && r.emoji === emoji)) recordReactionUse(emoji, emojiIndex);
    reactions.toggleReaction(msg, emoji);
  };

  const setShowEmojiPicker = (open) => {
    if (open) reactions.closePicker();
    setShowEmojiPickerState(open);
  };

  function openReactionPicker(msg, anchor) {
    setShowEmojiPickerState(false);
    if (isMobile) inputRef.current?.blur(); // the panel takes the keyboard's place
    reactions.openPicker(msg, anchor);
  }

  // A message command (Apps) on `msg`; what the bot says comes by socket, a form opens.
  async function runMessageApp(command, msg) {
    setComposerError(null);
    try {
      handleInteractionResult(await runCommand(commandChannelId, { commandId: command.id, targetId: msg.id }));
    } catch (err) {
      setComposerError(interactionError(err));
    }
  }
  // Only messages saved in the channel (not ephemeral, pending or failed ones).
  const appsFor = (msg) => (commandChannelId != null && Number.isInteger(msg.id) && !msg.ephemeral && msg.id < 2 ** 52 ? messageApps : []);

  function openActions(msg) {
    if (commandChannelId != null) refreshCommands();
    inputRef.current?.blur(); // the keyboard would cover the sheet
    setShowEmojiPickerState(false);
    reactions.closePicker();
    setActionsForId(msg.id);
  }

  function openMenu(msg, anchor) {
    if (commandChannelId != null) refreshCommands();
    reactions.closePicker();
    setMenuFor({ id: msg.id, anchor });
  }

  // Copies what the message says (a forward: what it forwards); attachments become their names
  // (their links carry the decryption key, which shouldn't end up pasted elsewhere), custom
  // emoji `:name:`, mentions `@name`. copyText throws if it couldn't (the menu shows that);
  // copyMessage says so above the message box.
  function copyText(msg) {
    const text = parseForward(msg.plaintext)?.content ?? msg.plaintext;
    return navigator.clipboard.writeText(mentionsToText(customEmojiToText(summarizeAttachments(text)), reactionNames, mentionRoles, mentionChannels));
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
    setEditsFor(null);
    setForwarding(null);
  }, [chatId]);

  // Someone's message arriving means they've stopped typing (it can beat their typing timeout).
  const newest = messages[messages.length - 1];
  useEffect(() => {
    if (newest?.sender_id != null) clearTyping(chatId, newest.sender_id);
  }, [chatId, newest?.id, newest?.sender_id]);

  // Remember the keyboard's height (mobile), so the emoji panel can match it.
  useEffect(() => (isMobile ? watchKeyboardHeight() : undefined), [isMobile]);

  // The inline editor opens focused, with the cursor at the end (on a phone the message box
  // takes the message instead, see Composer's `editing`). A poll opens its dialog.
  function handleEdit(msg) {
    const poll = parsePoll(msg.plaintext);
    if (poll) {
      if (isClosedPoll(msg)) setComposerError(t('chat.pane.pollClosedEdit'));
      else setEditingPoll({ msg, poll });
      return;
    }
    setReplyTo(null);
    setEditingMessageId(msg.id);
    setEditingMessageContent(msg.plaintext);
  }

  // Phone: the message box saving the message it's editing. Throws if it couldn't (Composer
  // shows it and keeps the text).
  async function saveEditFromComposer(text) {
    await conversation.editMessage(editingMessageId, text);
    setEditingMessageId(null);
  }
  const stopEditing = useCallback(() => setEditingMessageId(null), []);

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
    // Also after a retry (it's kept if it can't be sent).
    await sendKeepingUnsent({ text, replyTo }, {
      onSent: async (saved) => {
        try {
          await registerPollTimer(pollKind, saved.id, poll.duration);
        } catch (err) {
          console.error('Failed to register the poll', err);
          setComposerError(t('chat.pane.pollTimerFailed'));
        }
      },
    });
  }

  // A message that couldn't be sent (useUnsentMessages): Retry sends it again, Delete forgets it.
  const isUnsent = (msg) => msg.status === 'failed';
  const retrySend = useCallback(async (msg) => {
    setComposerError(null);
    try {
      await retryUnsent(msg.id);
    } catch (err) {
      setComposerError(t('chat.composer.sendFailed', { error: err.message }));
    }
  }, [retryUnsent]);
  const discardUnsent = useCallback((msg) => discardUnsentId(msg.id), [discardUnsentId]);

  // The author ends their poll now: an edit that stamps the time (see pollMarkup's endPoll),
  // so it's closed for everyone at once, then the server posts its "poll ended" row.
  async function endPollNow(msg) {
    const poll = parsePoll(msg.plaintext);
    if (!poll || isClosedPoll(msg)) return;
    await conversation.editMessage(msg.id, pollMarkup(endPoll(poll)));
    await endPollOnServer(pollKind, msg.id);
  }

  async function handleDelete(msg) {
    if (isUnsent(msg)) {
      discardUnsent(msg);
      return;
    }
    try {
      await conversation.deleteMessage(msg.id);
    } catch (err) {
      console.error('Failed to delete message', err);
    }
  }

  // The hover and right-click menus' delete: asks first (with the message shown), unless Shift is held. (The
  // mobile action sheet asks in its own way.)
  function requestDelete(msg, event) {
    // Nothing on the server to lose: no question.
    if (event?.shiftKey || isUnsent(msg)) handleDelete(msg);
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

  // "Remove previews" on a guild message (useChannel), for its author or a moderator, while it
  // has some: the server's, a bot's, or the app's own (YouTube players, invite cards).
  function canRemovePreviews(msg) {
    if (!conversation.suppressEmbeds || msg.flags & SUPPRESS_EMBEDS) return false;
    if (msg.sender_id !== user.id && !canModerate) return false;
    return Boolean(msg.link_embeds?.length || msg.embeds?.length || linksIn(msg.plaintext ?? '').some((link) => drawnByApp(link)));
  }

  async function removePreviews(msg) {
    try {
      await conversation.suppressEmbeds(msg);
    } catch (err) {
      console.error('Failed to remove previews', err);
      setComposerError(err.response?.data?.error || t('chat.pane.removePreviewsFailed'));
    }
  }

  // The menus' "Remove previews" (asked for already, so no question).
  const removePreviewsFor = (msg) => (canRemovePreviews(msg) ? () => removePreviews(msg) : undefined);

  // The X beside a preview (MessageList): asks first, unless Shift is held, as Discord does.
  function requestRemovePreviews(msg, event) {
    if (event?.shiftKey) removePreviews(msg);
    else setConfirmingRemovePreviews(msg);
  }

  // Scrolls the chat to message `id` (loading older history until it's there) and flashes it.
  async function jumpToMessage(id) {
    if (isMobile) onClosePins?.();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const row = document.querySelector(`.message-scroller [data-msg-id="${id}"]`);
      if (row) {
        row.scrollIntoView({ block: 'center' });
        flashRow(row, 'jump-highlight');
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
    if (isMobile) setEditingMessageId(null); // the message box does one or the other
    setReplyTo(msg);
    inputRef.current?.focus();
  }

  const { reactingTo } = reactions;
  const actionsFor = actionsForId != null ? messages.find((m) => m.id === actionsForId) : null;
  // Gone if the message was deleted meanwhile.
  const menuMsg = menuFor ? messages.find((m) => m.id === menuFor.id) : null;
  const reactionsMsg = reactionsForId != null ? messages.find((m) => m.id === reactionsForId) : null;
  // Phone: the message the message box is editing (gone if it was deleted meanwhile).
  const editingMsg = isMobile && editingMessageId != null ? messages.find((m) => m.id === editingMessageId) ?? null : null;

  return (
    <>
      <div className="dm-message-wrapper">
        {conversation.isLoading ? (
          <p></p>
        ) : conversation.error ? (
          <p className="error-text">{t('chat.pane.error', { error: conversation.error })}</p>
        ) : messages.length === 0 && !listHead ? (
          <p className="chat-empty">{emptyText}</p>
        ) : (
          <MessageList
            messages={messages}
            user={user}
            hasMore={conversation.hasMore}
            head={listHead}
            newFrom={newFrom}
            loadMoreMessages={conversation.loadMoreMessages}
            s3Endpoint={s3Endpoint}
            hoveredMsgId={hoveredMsgId}
            setHoveredMsgId={readOnly ? noHover : setHoveredMsgId}
            handleEdit={handleEdit}
            handleDelete={requestDelete}
            handleReply={handleReply}
            onForward={readOnly ? undefined : openForward}
            onRetrySend={readOnly ? undefined : retrySend}
            editingMessageId={isMobile ? null : editingMessageId}
            editingMessageContent={editingMessageContent}
            setEditingMessageContent={setEditingMessageContent}
            setEditingMessageId={setEditingMessageId}
            handleSaveEdit={handleSaveEdit}
            isMobile={isMobile}
            editRef={editRef}
            maxPlaintextLength={maxPlaintextLength}
            onToggleReaction={toggleReaction}
            onOpenReactionPicker={openReactionPicker}
            onVote={reactions.vote}
            onAddPollAnswer={reactions.addAnswer}
            onRemovePollAnswer={reactions.removeAnswer}
            onEndPoll={endPollNow}
            onJumpToMessage={jumpToMessage}
            onShowPins={readOnly ? undefined : onShowPins}
            reactionNames={reactionNames}
            onOpenActions={openActions}
            onOpenMenu={openMenu}
            canModerate={canModerate}
            canAddReactions={canAddReactions}
            canPin={canPin}
            onTogglePin={togglePin}
            onShowEdits={conversation.loadEdits ? setEditsFor : undefined}
            canRemovePreviews={isMobile ? undefined : canRemovePreviews}
            onRemovePreviews={requestRemovePreviews}
            nameColors={nameColors}
            mentionRoles={mentionRoles}
            myRoleIds={myRoleIds}
            encrypted={encrypted}
            canReply={canSend && !textOnly}
            // While reacting to a message (or its menu is open), it stays highlighted and
            // the others don't react to hovering.
            focusedMsgId={reactingTo?.msgId ?? actionsForId ?? menuMsg?.id ?? editingMsg?.id}
            // The message being replied to stays highlighted until the reply is sent or cancelled.
            replyingToId={replyTo?.id}
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
        chatTexts={chatTexts}
        isMobile={isMobile}
        maxPlaintextLength={maxPlaintextLength}
        s3Endpoint={s3Endpoint}
        inputRef={inputRef}
        replyTo={replyTo}
        onCancelReply={cancelReply}
        editing={editingMsg}
        onSaveEdit={saveEditFromComposer}
        onCancelEdit={stopEditing}
        error={composerError}
        setError={setComposerError}
        showEmojiPicker={showEmojiPicker}
        setShowEmojiPicker={setShowEmojiPicker}
        onInputFocus={reactions.closePicker}
        onSend={sendKeepingUnsent}
        onSendPoll={sendPoll}
        onStartThread={threads?.startThread ?? null}
        people={people}
        roles={suggestRoles}
        roleInfo={mentionRoles}
        canMentionEveryone={canMentionEveryone}
        channels={channels}
        commandChannelId={commandChannelId}
        textOnly={textOnly}
        focusOnOpen={focusOnOpen}
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

      {confirmingRemovePreviews && (
        <ConfirmDialog
          title={t('chat.removePreviews.title')}
          message={t('chat.removePreviews.confirm')}
          confirmLabel={t('common.remove')}
          focusConfirm
          onConfirm={() => conversation.suppressEmbeds(confirmingRemovePreviews)}
          onClose={() => setConfirmingRemovePreviews(null)}
        >
          <p className="vc-hint">{t('chat.removePreviews.shiftTip')}</p>
        </ConfirmDialog>
      )}

      {reporting && (
        <ReportDialog
          target={{
            kind: 'message',
            place: pollKind,
            msg: reporting,
            ...(pollKind === 'group' ? { groupId: chatId.replace(/^group-/, '') } : {}),
          }}
          name={reporting.webhook_id ? reporting.webhook_name : displayName(reporting.sender_id, reporting.sender_username)}
          onClose={() => setReporting(null)}
        />
      )}

      {editingPoll && (
        <PollDialog
          poll={editingPoll.poll}
          addedAnswers={pollWithAnswers(editingPoll.poll, editingPoll.msg.reactions, editingPoll.msg.sender_id)
            .options.filter((o) => o.addedBy).length}
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
          isOwn={!readOnly && actionsFor.sender_id === user.id}
          canDelete={actionsFor.sender_id === user.id || canModerate}
          canReact={canAddReactions}
          myReactions={new Set((actionsFor.reactions ?? []).filter((r) => r.user_id === user.id).map((r) => r.emoji))}
          onReact={(emoji) => toggleReaction(actionsFor, emoji)}
          onMoreReactions={() => openReactionPicker(actionsFor, null)}
          onViewReactions={() => setReactionsForId(actionsFor.id)}
          onReply={textOnly || readOnly ? undefined : () => handleReply(actionsFor)}
          onForward={forwardFor(actionsFor)}
          onEdit={editable(actionsFor) ? () => handleEdit(actionsFor) : undefined}
          onTogglePin={canPin ? () => togglePin(actionsFor) : undefined}
          onCreateThread={readOnly ? undefined : threadFrom(actionsFor)}
          onCopy={() => copyMessage(actionsFor)}
          onShowEdits={readOnly ? undefined : showEditsFor(actionsFor)}
          onRemovePreviews={readOnly ? undefined : removePreviewsFor(actionsFor)}
          apps={appsFor(actionsFor)}
          onRunApp={(command) => runMessageApp(command, actionsFor)}
          onDelete={() => handleDelete(actionsFor)}
          onReport={!readOnly && reportable(actionsFor) ? () => setReporting(actionsFor) : undefined}
          onClose={closeActions}
        />
      )}

      {menuMsg && (
        <MessageMenu
          msg={menuMsg}
          anchor={menuFor.anchor}
          isOwn={!readOnly && menuMsg.sender_id === user.id}
          canDelete={menuMsg.sender_id === user.id || canModerate}
          canReact={canAddReactions}
          myReactions={new Set((menuMsg.reactions ?? []).filter((r) => r.user_id === user.id).map((r) => r.emoji))}
          onReact={(emoji) => toggleReaction(menuMsg, emoji)}
          onMoreReactions={(rect) => openReactionPicker(menuMsg, { getBoundingClientRect: () => rect })}
          onViewReactions={() => setReactionsForId(menuMsg.id)}
          onReply={textOnly || readOnly ? undefined : () => handleReply(menuMsg)}
          onForward={forwardFor(menuMsg)}
          onEdit={editable(menuMsg) ? () => handleEdit(menuMsg) : undefined}
          onTogglePin={canPin ? () => togglePin(menuMsg) : undefined}
          onCreateThread={readOnly ? undefined : threadFrom(menuMsg)}
          onCopy={() => copyText(menuMsg)}
          onShowEdits={readOnly ? undefined : showEditsFor(menuMsg)}
          onRemovePreviews={readOnly ? undefined : removePreviewsFor(menuMsg)}
          apps={appsFor(menuMsg)}
          onRunApp={(command) => runMessageApp(command, menuMsg)}
          onDelete={(event) => requestDelete(menuMsg, event)}
          onReport={!readOnly && reportable(menuMsg) ? () => setReporting(menuMsg) : undefined}
          onClose={closeMenu}
        />
      )}

      {reactionsMsg && (
        <ReactionsDialog
          groups={groupReactions(reactionsMsg.reactions)}
          names={reactionNames}
          userId={user.id}
          initialEmoji={groupReactions(reactionsMsg.reactions)[0]?.emoji}
          onRemove={(emoji) => toggleReaction(reactionsMsg, emoji)}
          onClose={closeReactions}
        />
      )}

      {forwarding && (
        <ForwardDialog user={user} source={forwarding} encrypted={encrypted} onClose={() => setForwarding(null)} />
      )}

      {editsFor && (
        <EditHistoryDialog
          // The message as it is now (an edit while it's open shows at once).
          msg={messages.find((m) => m.id === editsFor.id) ?? editsFor}
          loadEdits={conversation.loadEdits}
          onClose={() => setEditsFor(null)}
          user={user}
          s3Endpoint={s3Endpoint}
          reactionNames={reactionNames}
          mentionRoles={mentionRoles}
          myRoleIds={myRoleIds}
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
