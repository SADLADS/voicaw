import React, { useEffect, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus, faSquarePollHorizontal, faUpload } from '@fortawesome/free-solid-svg-icons';
import EmojiPicker from './EmojiPicker';
import EmojiSuggestions from './EmojiSuggestions';
import MentionSuggestions from './MentionSuggestions';
import CommandSuggestions from './CommandSuggestions';
import CommandComposer from './CommandComposer';
import { useChannelCommands } from '../hooks/useChannelCommands';
import { commandEntries, searchCommands } from '../utils/commandOptions';
import AttachmentTray from './AttachmentTray';
import '../assets/css/commands.css';
import FileDropOverlay from './FileDropOverlay';
import PollDialog from './PollDialog';
import { useEmojiIndex } from '../emoji/emojiContext';
import { getSkinTone, recordEmojiUse, skinFor } from '../emoji/emojiUsage';
import { getKeyboardHeight } from '../utils/keyboardHeight';
import { findPlaceholderIds, replacePlaceholders } from '../utils/attachmentMarkup';
import { seedAttachmentCache } from '../services/attachmentCache';
import { useAttachmentDrafts } from '../hooks/useAttachmentDrafts';
import { useWindowFileDrop } from '../hooks/useFileDrop';
import MessageEditor from '../editor/MessageEditor';
import {
  customEmojiByName,
  customEmojiUrl,
  customUsageId,
  parseCustomEmoji,
  searchCustomEmoji,
} from '../emoji/customEmoji';
import { useCustomEmoji } from '../emoji/customEmojiContext';
import { searchChannels, searchMentions } from '../utils/mentions';
import { gifMarkup } from '../utils/gifMarkup';
import { displayName, nameOf, useProfiles } from '../utils/profiles';
import { noteTyping, typingDone } from '../services/typingService';
import { getDraft, saveDraft } from '../services/draftStore';
import { t } from '../i18n';

// ":smi" right after a space/bracket or at the start (so not "12:30" or "https://").
const EMOJI_QUERY = /(?:^|[\s([{])(:[a-z0-9_+-]{2,})$/i;
// A complete ":shortcode:" just typed.
const EMOJI_SHORTCODE = /(?:^|[\s([{]):([a-z0-9_+-]+):$/i;
// "@", "@na": a mention being typed (not "a@b").
const MENTION_QUERY = /(?:^|[\s([{])@([^\s@<>]{0,32})$/;
// "#", "#gen": a channel being typed (not "a#b").
const CHANNEL_QUERY = /(?:^|[\s([{])#([^\s#<>]{0,100})$/;
// "/", "/we": a bot command being picked (the whole message so far).
const COMMAND_QUERY = /^\/([^\s/]{0,32})$/;

// The message box under a conversation (MessageEditor: `inputRef` is its handle), writing to
// `chatName` (a person, or "#channel"; null while the chat can't be sent to yet), with
// attachments (chips in the box, uploaded on send; files can be dropped anywhere on the window) and polls (both from the + menu), emoji (picker, ":smi" suggestions,
// ":shortcode:" conversion), mentions ("@na" suggestions from `people`, [{ id, username }];
// in a guild also `roles`, [{ id, name, color }], and @everyone/@here with `canMentionEveryone`;
// `roleInfo` ({ id: { name, color } }) draws role mentions in the box), channel mentions in a
// guild ("#gen" suggestions from `channels`, [{ id, name, type, private, category }]) and the
// reply bar. What's typed is kept per conversation while the app is open (draftStore).
// In a guild channel or thread (`commandChannelId`), "/" at the start lists its bots' commands
// (CommandSuggestions); picking one turns the box into CommandComposer until it's run or left.
//
// `onSend({ text, replyTo, localAttachments, resolveText })` sends (see useConversation's
// sendMessage); `onSendPoll({ poll, replyTo })` sends a poll made in PollDialog (see ChatPane).
// `error` is shown above the box (Dm reports its own errors there too). On
// mobile the emoji panel (`showEmojiPicker`) takes the keyboard's place; `onInputFocus`
// runs when the keyboard is about to come up. Opening a conversation focuses the box on a
// computer (not on a phone: that would open the keyboard), unless `focusOnOpen` is false.
export default function Composer({
  chatId,
  chatName,
  isMobile,
  maxPlaintextLength,
  s3Endpoint,
  inputRef,
  replyTo,
  onCancelReply,
  error,
  setError,
  showEmojiPicker,
  setShowEmojiPicker,
  onInputFocus,
  onSend,
  onSendPoll,
  people,
  roles,
  roleInfo,
  canMentionEveryone = false,
  channels,
  chatTexts,
  commandChannelId = null,
  focusOnOpen = true,
}) {
  // What the box and the file drop overlay say: "Message Alice", or the chat's own wording
  // (`chatTexts`: { label, placeholder, upload }, e.g. a document's replies).
  const name = chatName || t('chat.composer.fallbackName');
  const texts = chatTexts ?? {
    label: t('chat.composer.messageLabel', { name }),
    placeholder: t('chat.composer.messagePlaceholder', { name }),
    upload: t('media.fileDrop.title', { name }),
  };
  const emojiIndex = useEmojiIndex();
  useProfiles();
  const mentionNames = Object.fromEntries((people ?? []).map((p) => [p.id, nameOf(p)]));
  const custom = useCustomEmoji();
  // What the editor needs to show a custom emoji.
  const customNode = (emoji) => ({ id: String(emoji.id), name: emoji.name, url: customEmojiUrl(emoji.id, s3Endpoint) });
  // The message as text (see editor/messageDoc), and its current line up to the cursor
  // (which drives ":smi" suggestions).
  const [inputValue, setInputValue] = useState('');
  const [beforeCaret, setBeforeCaret] = useState('');
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  // The query (":smi" or "@na") whose suggestions Escape closed.
  const [dismissedQuery, setDismissedQuery] = useState(null);
  // The + button's menu (upload a file, create a poll), and the poll dialog.
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [creatingPoll, setCreatingPoll] = useState(false);
  const addMenuRef = useRef(null);
  // The conversation the box's text is saved for, and whether its draft is being put back.
  const draftChatId = useRef(chatId);
  // Bot commands (guild channels only), and the one being filled in (command mode).
  const { commands, refresh: refreshCommands } = useChannelCommands(commandChannelId, { enabled: commandChannelId != null });
  const [commandEntry, setCommandEntry] = useState(null);
  const restoringDraft = useRef(false);

  // Emoji from the picker (Unicode, or `<:name:id>`). On mobile the box isn't focused (that
  // would open the keyboard).
  function insertEmoji(text) {
    const customEmoji = parseCustomEmoji(text);
    if (customEmoji) inputRef.current?.insertCustomEmoji(customNode(customEmoji), { focus: !isMobile });
    else inputRef.current?.insertText(text, { focus: !isMobile });
  }

  const attachments = useAttachmentDrafts({
    chatId,
    s3Endpoint,
    insertAttachments: (drafts) => inputRef.current?.insertAttachments(drafts),
    onError: setError,
    onDiscard: (dropped) => {
      dropped.forEach((d) => inputRef.current?.removeAttachment(d.id));
      setError(null);
    },
  });

  // Files dragged in anywhere on the window are attached (FileDropOverlay while dragging).
  const draggingFiles = useWindowFileDrop({ enabled: !!chatName, onFiles: attachments.addFiles });

  function removeDraft(id) {
    attachments.removeDraft(id);
    inputRef.current?.removeAttachment(id);
  }

  // On mobile the emoji panel and the on-screen keyboard take turns in the same space (like
  // Discord): opening the panel dismisses the keyboard, and the button (then showing a
  // keyboard) or tapping the message box swaps back.
  function toggleEmojiPicker() {
    if (isMobile) {
      if (showEmojiPicker) {
        setShowEmojiPicker(false);
        inputRef.current?.focus(); // inside the tap, so the keyboard opens
      } else {
        inputRef.current?.blur();
        setShowEmojiPicker(true);
      }
      return;
    }
    setShowEmojiPicker(!showEmojiPicker);
  }

  const emojiQuery = emojiIndex ? EMOJI_QUERY.exec(beforeCaret)?.[1] ?? null : null;
  // Custom emoji first, then standard ones (8 in all).
  const emojiSuggestions = emojiQuery && emojiQuery !== dismissedQuery
    ? [...searchCustomEmoji(custom, emojiQuery.slice(1), 8), ...emojiIndex.search(emojiQuery.slice(1), 8)].slice(0, 8)
    : [];
  const mentionQuery = people?.length ? MENTION_QUERY.exec(beforeCaret)?.[1] ?? null : null;
  const mentionSuggestions = mentionQuery != null && `@${mentionQuery}` !== dismissedQuery
    ? searchMentions({ people, roles, everyone: canMentionEveryone }, mentionQuery)
    : [];
  const channelQuery = channels?.length ? CHANNEL_QUERY.exec(beforeCaret)?.[1] ?? null : null;
  const channelSuggestions = channelQuery != null && `#${channelQuery}` !== dismissedQuery
    ? searchChannels(channels, channelQuery)
    : [];
  const commandQuery = commandChannelId != null && inputValue === beforeCaret ? COMMAND_QUERY.exec(beforeCaret)?.[1] ?? null : null;
  const commandSuggestions = commandQuery != null && `/${commandQuery}` !== dismissedQuery
    ? searchCommands(commandEntries(commands), commandQuery, 10)
    : [];
  // Only one kind can match what's before the cursor.
  const suggestions = commandSuggestions.length > 0 ? commandSuggestions
    : emojiSuggestions.length > 0 ? emojiSuggestions
    : mentionSuggestions.length > 0 ? mentionSuggestions : channelSuggestions;
  const activeSuggestion = Math.min(suggestionIndex, Math.max(suggestions.length - 1, 0));

  function pickSuggestion(item) {
    if (commandSuggestions.length > 0) pickCommand(item);
    else if (emojiSuggestions.length > 0) pickEmoji(item);
    else if (item.kind === 'channel') pickChannel(item);
    else pickMention(item);
  }

  // A command picked: the "/…" typed goes, and the box becomes its form.
  function pickCommand(entry) {
    inputRef.current?.clear();
    typingDone(chatId);
    setSuggestionIndex(0);
    setCommandEntry(entry);
  }

  function leaveCommand() {
    setCommandEntry(null);
    queueMicrotask(() => inputRef.current?.focus());
  }

  function pickChannel(item) {
    inputRef.current?.replaceBeforeCaretWithChannelMention(channelQuery.length + 1, { id: item.id, name: item.name });
    setSuggestionIndex(0);
  }

  function pickMention(item) {
    const count = mentionQuery.length + 1;
    const editor = inputRef.current;
    if (item.kind === 'role') editor?.replaceBeforeCaretWithRoleMention(count, { id: item.id, name: item.name, color: roleInfo?.[item.id]?.color });
    else if (item.kind === 'everyone') editor?.replaceBeforeCaret(count, `@${item.name} `);
    else editor?.replaceBeforeCaretWithMention(count, { id: item.id, name: item.name });
    setSuggestionIndex(0);
  }

  function pickEmoji(emoji) {
    if (emoji.guild) {
      recordEmojiUse(customUsageId(emoji.id));
      inputRef.current?.replaceBeforeCaretWithCustomEmoji(emojiQuery.length, customNode(emoji));
    } else {
      recordEmojiUse(emoji.id);
      inputRef.current?.replaceBeforeCaret(emojiQuery.length, `${skinFor(emoji, getSkinTone()).native} `);
    }
    setSuggestionIndex(0);
  }

  function handleEditorChange({ text, beforeCaret: line, docChanged }) {
    setInputValue(text);
    setBeforeCaret(line);
    if (!docChanged) return;
    saveDraft(draftChatId.current, text);
    // Putting a draft back isn't typing.
    if (restoringDraft.current) return;
    if (text.trim()) noteTyping(chatId);
    else typingDone(chatId);
    setSuggestionIndex(0);

    // Typing the closing colon of a known :shortcode: turns it into the emoji (like Discord):
    // a standard one, else a custom emoji of that name.
    const typed = emojiIndex && EMOJI_SHORTCODE.exec(line);
    const emoji = typed && emojiIndex.byShortcode.get(typed[1].toLowerCase());
    const customEmoji = typed && !emoji && customEmojiByName(custom, typed[1]);
    if (customEmoji) {
      recordEmojiUse(customUsageId(customEmoji.id));
      queueMicrotask(() => {
        const editor = inputRef.current;
        if (editor && !editor.isComposing()) {
          editor.replaceBeforeCaretWithCustomEmoji(typed[1].length + 2, customNode(customEmoji), { focus: false });
        }
      });
    }
    if (emoji) {
      recordEmojiUse(emoji.id);
      const native = skinFor(emoji, getSkinTone()).native;
      // After this edit has finished (and not in the middle of a keyboard's composition).
      queueMicrotask(() => {
        const editor = inputRef.current;
        if (editor && !editor.isComposing()) editor.replaceBeforeCaret(typed[1].length + 2, native, { focus: false });
      });
    }
  }

  function handleInputKeyDown(e) {
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setSuggestionIndex((activeSuggestion + step + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickSuggestion(suggestions[activeSuggestion]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissedQuery(commandSuggestions.length > 0 ? `/${commandQuery}` : emojiSuggestions.length > 0 ? emojiQuery
          : mentionSuggestions.length > 0 ? `@${mentionQuery}` : `#${channelQuery}`);
        return;
      }
    }
  }

  async function handleSubmit(e) {
    e?.preventDefault();
    const text = (inputRef.current?.getText() ?? '').trim();
    if (!text || !chatName) return;

    const referencedIds = findPlaceholderIds(text);
    const referenced = attachments.drafts.filter((d) => referencedIds.has(d.id));

    // Placeholders are much shorter than the final attachment URLs, so check the length
    // the message will have once they're swapped in.
    const projectedText = replacePlaceholders(
      text,
      Object.fromEntries(referenced.map((d) => [d.id, attachments.projectedUrl(d)]))
    );
    if (projectedText.length > maxPlaintextLength) {
      setError(t('chat.composer.tooLongWithLinks', { count: projectedText.length - maxPlaintextLength }));
      return;
    }
    setError(null);

    inputRef.current?.clear();
    typingDone(chatId);
    const sending = attachments.takeDrafts(referencedIds);
    onCancelReply();

    try {
      await onSend({
        text,
        replyTo,
        // Lets the pending message show attachments from the local files while they upload.
        localAttachments: Object.fromEntries(
          sending.map((d) => [
            d.id,
            { previewUrl: d.previewUrl, type: d.type, size: d.size, width: d.width, height: d.height, spoiler: !!d.spoiler },
          ])
        ),
        resolveText: sending.length > 0 ? async () => {
          const urls = await attachments.upload(sending);
          sending.forEach((d) => seedAttachmentCache(urls[d.id], d.previewUrl));
          return replacePlaceholders(text, urls);
        } : undefined,
      });
    } catch (err) {
      setError(t('chat.composer.sendFailed', { error: err.message }));
    }
  }

  // A GIF from the picker goes straight out as its own message (like Discord), replying if a
  // reply is set up; whatever is typed in the box stays there.
  async function sendGif(gif) {
    if (!chatName) return;
    setError(null);
    onCancelReply();
    try {
      await onSend({ text: gifMarkup(gif), replyTo });
    } catch (err) {
      setError(t('chat.composer.gifFailed', { error: err.message }));
    }
  }

  // A poll goes out as its own message, replying if a reply is set up (like a GIF). The dialog
  // stays open (showing the error) if it can't be sent.
  async function sendPoll(poll) {
    await onSendPoll({ poll, replyTo });
    onCancelReply();
  }

  // Opening a conversation puts back what was left typed in it (after the previous one's
  // attachments have gone, see useAttachmentDrafts).
  useEffect(() => {
    draftChatId.current = chatId;
    const editor = inputRef.current;
    const draft = getDraft(chatId);
    if (!editor || editor.getText() === draft) return;
    restoringDraft.current = true;
    try {
      editor.setText(draft);
    } finally {
      restoringDraft.current = false;
    }
  }, [chatId, inputRef]);

  // Ready to type in a conversation just opened, unless another text box has the focus (a
  // search left open after jumping to a result).
  useEffect(() => {
    if (isMobile || !focusOnOpen) return;
    const active = document.activeElement;
    const editor = inputRef.current?.element;
    const typing = active && active !== editor && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
    if (!typing) inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  // Opening the "/" list asks for the channel's commands again (they may have changed).
  const commandListOpen = commandQuery != null;
  useEffect(() => {
    if (commandListOpen) refreshCommands({ fresh: true });
  }, [commandListOpen, refreshCommands]);

  // Another conversation: out of command mode.
  useEffect(() => {
    setCommandEntry(null);
  }, [chatId]);

  // The + menu closes on a click outside it or Escape.
  useEffect(() => {
    if (!addMenuOpen) return undefined;
    const onDown = (e) => {
      if (!addMenuRef.current?.contains(e.target)) setAddMenuOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setAddMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [addMenuOpen]);

  // Escape cancels a reply (not while it's closing the poll dialog).
  useEffect(() => {
    if (creatingPoll) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onCancelReply();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancelReply, creatingPoll]);

  // The tray only shows drafts still referenced from the text; unreferenced ones are kept
  // until send so that undoing a deletion brings them back.
  const referencedDraftIds = findPlaceholderIds(inputValue);
  const visibleDrafts = attachments.drafts.filter((d) => referencedDraftIds.has(d.id));

  return (
    <>
      {draggingFiles && <FileDropOverlay title={texts.upload} />}
      <div className="dm-chat-wrapper">
        {showEmojiPicker && !isMobile && (
          <EmojiPicker onSelect={insertEmoji} onGif={sendGif} onClose={() => setShowEmojiPicker(false)} />
        )}

        {commandSuggestions.length > 0 && !commandEntry && (
          <CommandSuggestions
            query={commandQuery}
            entries={commandSuggestions}
            activeIndex={activeSuggestion}
            onPick={pickCommand}
            onHover={setSuggestionIndex}
          />
        )}

        {emojiSuggestions.length > 0 && commandSuggestions.length === 0 && (
          <EmojiSuggestions
            query={emojiQuery}
            emojis={emojiSuggestions}
            activeIndex={activeSuggestion}
            onPick={pickEmoji}
            onHover={setSuggestionIndex}
            s3Endpoint={s3Endpoint}
          />
        )}

        {mentionSuggestions.length > 0 && emojiSuggestions.length === 0 && (
          <MentionSuggestions
            query={mentionQuery}
            items={mentionSuggestions}
            activeIndex={activeSuggestion}
            onPick={pickMention}
            onHover={setSuggestionIndex}
            s3Endpoint={s3Endpoint}
          />
        )}

        {channelSuggestions.length > 0 && mentionSuggestions.length === 0 && emojiSuggestions.length === 0 && (
          <MentionSuggestions
            symbol="#"
            query={channelQuery}
            items={channelSuggestions}
            activeIndex={activeSuggestion}
            onPick={pickChannel}
            onHover={setSuggestionIndex}
          />
        )}

        {replyTo && (
          <div className="reply-bar">
            <span>
              <Trans i18nKey="chat.composer.replyingTo" values={{ name: displayName(replyTo.sender_id, replyTo.sender_username) }} components={{ b: <strong /> }} />
            </span>
            <button className="reply-close" onClick={onCancelReply} type="button">
              ×
            </button>
          </div>
        )}

        {error && (
          <div className="composer-error" role="alert">
            <span>{error}</span>
            <button className="reply-close" onClick={() => setError(null)} type="button">
              ×
            </button>
          </div>
        )}

        <AttachmentTray drafts={visibleDrafts} onRemove={removeDraft} onToggleSpoiler={attachments.toggleSpoiler} />

        {commandEntry && (
          <CommandComposer
            key={commandEntry.key}
            entry={commandEntry}
            channelId={commandChannelId}
            people={people}
            roleInfo={roleInfo}
            channels={channels}
            onClose={leaveCommand}
          />
        )}

        {/* Kept (hidden) in command mode, so what's typed and the editor survive it. */}
        <form id="dm-chat-form" className={commandEntry ? 'd-none' : 'd-flex flex-grow-1'} hidden={Boolean(commandEntry)} onSubmit={handleSubmit}>
          <div className="attach-wrapper" ref={addMenuRef}>
            <button
              className="attach-button"
              type="button"
              aria-label={t('common.add')}
              aria-haspopup="menu"
              aria-expanded={addMenuOpen}
              onClick={() => setAddMenuOpen(!addMenuOpen)}
            >
              <FontAwesomeIcon icon={faPlus} />
            </button>
            {addMenuOpen && (
              <div className="composer-add-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="composer-add-item"
                  onClick={() => { setAddMenuOpen(false); attachments.pickFiles(); }}
                >
                  <FontAwesomeIcon icon={faUpload} fixedWidth /> {t('chat.composer.uploadFile')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="composer-add-item"
                  disabled={!chatName}
                  onClick={() => { setAddMenuOpen(false); setCreatingPoll(true); }}
                >
                  <FontAwesomeIcon icon={faSquarePollHorizontal} fixedWidth /> {t('chat.composer.createPoll')}
                </button>
              </div>
            )}
          </div>

          <MessageEditor
            ref={inputRef}
            id="dm-input"
            className="message-editor-wrapper"
            ariaLabel={texts.label}
            placeholder={texts.placeholder}
            maxLength={maxPlaintextLength}
            // Mobile: Enter is a new line; the Send button sends.
            submitOnEnter={!isMobile}
            onSubmit={handleSubmit}
            onChange={handleEditorChange}
            onKeyDown={handleInputKeyDown}
            onPasteFiles={attachments.addFiles}
            mentionNames={mentionNames}
            mentionRoles={roleInfo}
            // Mobile: the keyboard is coming up, so the emoji panel gives way.
            onFocus={() => {
              if (!isMobile) return;
              setShowEmojiPicker(false);
              onInputFocus?.();
            }}
          />
          <div className="chat-buttons">
            <button
              type="button"
              className="emoji-button"
              aria-label={isMobile && showEmojiPicker ? t('chat.composer.showKeyboard') : t('chat.composer.emoji')}
              aria-expanded={showEmojiPicker}
              // Don't let the picker's outside-click handler close it before this toggles.
              onMouseDown={(e) => e.stopPropagation()}
              onClick={toggleEmojiPicker}
            >
              {isMobile && showEmojiPicker ? '⌨️' : '😎'}
            </button>
            <button
              className="send-button"
              type="submit"
              // The message box keeps focus, so a phone's keyboard stays up for the next message
              // (and doesn't come up if it was down).
              onMouseDown={(e) => e.preventDefault()}
            >
              {t('chat.composer.send')}
            </button>
          </div>
        </form>
      </div>

      {attachments.progress > 0 && (
        <progress value={attachments.progress} max="100" style={{ width: '100%' }} />
      )}

      {creatingPoll && <PollDialog onSubmit={sendPoll} onClose={() => setCreatingPoll(false)} />}

      {showEmojiPicker && isMobile && (
        // Where the keyboard would be, the same height.
        <EmojiPicker
          docked
          height={getKeyboardHeight()}
          onSelect={insertEmoji}
          onGif={sendGif}
          onClose={() => setShowEmojiPicker(false)}
        />
      )}
    </>
  );
}
