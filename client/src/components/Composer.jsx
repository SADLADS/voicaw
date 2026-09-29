import React, { useEffect, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus } from '@fortawesome/free-solid-svg-icons';
import EmojiPicker from './EmojiPicker';
import EmojiSuggestions from './EmojiSuggestions';
import MentionSuggestions from './MentionSuggestions';
import AttachmentTray from './AttachmentTray';
import { useEmojiIndex } from '../emoji/emojiContext';
import { getSkinTone, recordEmojiUse, skinFor } from '../emoji/emojiUsage';
import { getKeyboardHeight } from '../utils/keyboardHeight';
import { findPlaceholderIds, replacePlaceholders } from '../utils/attachmentMarkup';
import { seedAttachmentCache } from '../services/attachmentCache';
import { useAttachmentDrafts } from '../hooks/useAttachmentDrafts';
import MessageEditor from '../editor/MessageEditor';
import {
  customEmojiByName,
  customEmojiUrl,
  customUsageId,
  parseCustomEmoji,
  searchCustomEmoji,
} from '../emoji/customEmoji';
import { useCustomEmoji } from '../emoji/customEmojiContext';
import { searchPeople } from '../utils/mentions';

// ":smi" right after a space/bracket or at the start (so not "12:30" or "https://").
const EMOJI_QUERY = /(?:^|[\s([{])(:[a-z0-9_+-]{2,})$/i;
// A complete ":shortcode:" just typed.
const EMOJI_SHORTCODE = /(?:^|[\s([{]):([a-z0-9_+-]+):$/i;
// "@", "@na": a mention being typed (not "a@b").
const MENTION_QUERY = /(?:^|[\s([{])@([^\s@<>]{0,32})$/;

// The message box under a conversation (MessageEditor: `inputRef` is its handle), writing to
// `chatName` (a person, or "#channel"; null while the chat can't be sent to yet), with
// attachments (chips in the box, uploaded on send), emoji (picker, ":smi" suggestions,
// ":shortcode:" conversion), mentions ("@na" suggestions from `people`, [{ id, username }])
// and the reply bar.
//
// `onSend({ text, replyTo, localAttachments, resolveText })` sends (see useConversation's
// sendMessage). `error` is shown above the box (Dm reports its own errors there too). On
// mobile the emoji panel (`showEmojiPicker`) takes the keyboard's place; `onInputFocus`
// runs when the keyboard is about to come up.
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
  people,
}) {
  const emojiIndex = useEmojiIndex();
  const mentionNames = Object.fromEntries((people ?? []).map((p) => [p.id, p.username]));
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
    ? searchPeople(people, mentionQuery, 8)
    : [];
  // Only one kind can match what's before the cursor.
  const suggestions = emojiSuggestions.length > 0 ? emojiSuggestions : mentionSuggestions;
  const activeSuggestion = Math.min(suggestionIndex, Math.max(suggestions.length - 1, 0));

  function pickSuggestion(item) {
    if (emojiSuggestions.length > 0) pickEmoji(item);
    else pickMention(item);
  }

  function pickMention(person) {
    inputRef.current?.replaceBeforeCaretWithMention(mentionQuery.length + 1, { id: person.id, name: person.username });
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
        setDismissedQuery(emojiSuggestions.length > 0 ? emojiQuery : `@${mentionQuery}`);
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
      setError(`Message is ${projectedText.length - maxPlaintextLength} characters too long once attachment links are added.`);
      return;
    }
    setError(null);

    inputRef.current?.clear();
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
            { previewUrl: d.previewUrl, type: d.type, size: d.size, width: d.width, height: d.height },
          ])
        ),
        resolveText: sending.length > 0 ? async () => {
          const urls = await attachments.upload(sending);
          sending.forEach((d) => seedAttachmentCache(urls[d.id], d.previewUrl));
          return replacePlaceholders(text, urls);
        } : undefined,
      });
    } catch (err) {
      setError(`Message failed to send: ${err.message}`);
    }
  }

  // Escape cancels a reply.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onCancelReply();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancelReply]);

  // The tray only shows drafts still referenced from the text; unreferenced ones are kept
  // until send so that undoing a deletion brings them back.
  const referencedDraftIds = findPlaceholderIds(inputValue);
  const visibleDrafts = attachments.drafts.filter((d) => referencedDraftIds.has(d.id));

  return (
    <>
      <div className={`dm-chat-wrapper${attachments.isDragOver ? ' drag-over' : ''}`} {...attachments.dropHandlers}>
        {showEmojiPicker && !isMobile && (
          <EmojiPicker onSelect={insertEmoji} onClose={() => setShowEmojiPicker(false)} />
        )}

        {emojiSuggestions.length > 0 && (
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
            people={mentionSuggestions}
            activeIndex={activeSuggestion}
            onPick={pickMention}
            onHover={setSuggestionIndex}
            s3Endpoint={s3Endpoint}
          />
        )}

        {replyTo && (
          <div className="reply-bar">
            <span>
              Replying to <strong>{replyTo.sender_username}</strong>
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

        <AttachmentTray drafts={visibleDrafts} onRemove={removeDraft} />

        <form id="dm-chat-form" className="d-flex flex-grow-1" onSubmit={handleSubmit}>
          <div className="attach-wrapper">
            <button className="attach-button" type="button" onClick={attachments.pickFiles}>
              <FontAwesomeIcon icon={faPlus} />
            </button>
          </div>

          <MessageEditor
            ref={inputRef}
            id="dm-input"
            className="message-editor-wrapper"
            ariaLabel={`Message ${chatName || 'User'}`}
            placeholder={`Message ${chatName || 'User'}...`}
            maxLength={maxPlaintextLength}
            // Mobile: Enter is a new line; the Send button sends.
            submitOnEnter={!isMobile}
            onSubmit={handleSubmit}
            onChange={handleEditorChange}
            onKeyDown={handleInputKeyDown}
            onPasteFiles={attachments.addFiles}
            mentionNames={mentionNames}
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
              aria-label={isMobile && showEmojiPicker ? 'Show keyboard' : 'Emoji'}
              aria-expanded={showEmojiPicker}
              // Don't let the picker's outside-click handler close it before this toggles.
              onMouseDown={(e) => e.stopPropagation()}
              onClick={toggleEmojiPicker}
            >
              {isMobile && showEmojiPicker ? '⌨️' : '😎'}
            </button>
            <button className="send-button" type="submit">
              Send
            </button>
          </div>
        </form>
      </div>

      {attachments.progress > 0 && (
        <progress value={attachments.progress} max="100" style={{ width: '100%' }} />
      )}

      {showEmojiPicker && isMobile && (
        // Where the keyboard would be, the same height.
        <EmojiPicker
          docked
          height={getKeyboardHeight()}
          onSelect={insertEmoji}
          onClose={() => setShowEmojiPicker(false)}
        />
      )}
    </>
  );
}
