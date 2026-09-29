import React, { useEffect, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus } from '@fortawesome/free-solid-svg-icons';
import EmojiPicker from './EmojiPicker';
import EmojiSuggestions from './EmojiSuggestions';
import AttachmentTray from './AttachmentTray';
import { useEmojiIndex } from '../emoji/emojiContext';
import { getSkinTone, recordEmojiUse, skinFor } from '../emoji/emojiUsage';
import { getKeyboardHeight } from '../utils/keyboardHeight';
import { findPlaceholderIds, removePlaceholder, replacePlaceholders } from '../utils/attachmentMarkup';
import { seedAttachmentCache } from '../services/attachmentCache';
import { useAttachmentDrafts } from '../hooks/useAttachmentDrafts';

// ":smi" right after a space/bracket or at the start (so not "12:30" or "https://").
const EMOJI_QUERY = /(?:^|[\s([{])(:[a-z0-9_+-]{2,})$/i;
// A complete ":shortcode:" just typed.
const EMOJI_SHORTCODE = /(?:^|[\s([{]):([a-z0-9_+-]+):$/i;

// The message box under a conversation, with attachments (added as placeholders, uploaded on
// send), emoji (picker, ":smi" suggestions, ":shortcode:" conversion) and the reply bar.
//
// `onSend({ text, replyTo, localAttachments, resolveText })` sends (see useConversation's
// sendMessage). `error` is shown above the box (Dm reports its own errors there too). On
// mobile the emoji panel (`showEmojiPicker`) takes the keyboard's place; `onInputFocus`
// runs when the keyboard is about to come up.
export default function Composer({
  chatId,
  chatUser,
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
}) {
  const emojiIndex = useEmojiIndex();
  const [inputValue, setInputValue] = useState('');
  // Where the caret is (it drives ":smi" suggestions).
  const [caret, setCaret] = useState(0);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [dismissedEmojiQuery, setDismissedEmojiQuery] = useState(null);

  // Replaces inputValue[start, end) with `text` and puts the caret after it. `focus` also
  // focuses the textarea (skipped for the emoji picker on mobile: it'd open the keyboard).
  // `clamp` keeps the text within the length limit (not for attachment placeholders, which
  // mustn't be cut; the length is checked on send).
  function replaceInput(start, end, text, { focus = true, clamp = true } = {}) {
    const textarea = inputRef.current;
    setInputValue((prev) => {
      const next = prev.slice(0, start) + text + prev.slice(end);
      return clamp ? next.slice(0, maxPlaintextLength) : next;
    });
    const cursor = start + text.length;
    setCaret(cursor);
    setTimeout(() => {
      if (focus) textarea?.focus();
      textarea?.setSelectionRange(cursor, cursor);
    }, 0);
  }

  function insertAtCursor(text, options) {
    const textarea = inputRef.current;
    const start = textarea?.selectionStart ?? inputValue.length;
    const end = textarea?.selectionEnd ?? start;
    replaceInput(start, end, text, options);
  }

  const attachments = useAttachmentDrafts({
    chatId,
    s3Endpoint,
    insertText: (markup) => insertAtCursor(markup, { clamp: false }),
    onError: setError,
    onDiscard: (dropped) => {
      setInputValue((prev) => dropped.reduce((text, d) => removePlaceholder(text, d.id), prev));
      setError(null);
    },
  });

  function removeDraft(id) {
    attachments.removeDraft(id);
    setInputValue((prev) => removePlaceholder(prev, id));
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

  const emojiQuery = emojiIndex ? EMOJI_QUERY.exec(inputValue.slice(0, caret))?.[1] ?? null : null;
  const emojiSuggestions = emojiQuery && emojiQuery !== dismissedEmojiQuery
    ? emojiIndex.search(emojiQuery.slice(1), 8)
    : [];
  const activeSuggestion = Math.min(suggestionIndex, Math.max(emojiSuggestions.length - 1, 0));

  function pickSuggestion(emoji) {
    recordEmojiUse(emoji.id);
    replaceInput(caret - emojiQuery.length, caret, `${skinFor(emoji, getSkinTone()).native} `);
    setSuggestionIndex(0);
  }

  function handleInputChange(e) {
    let value = e.target.value;
    let cursor = e.target.selectionStart ?? value.length;

    // Typing the closing colon of a known :shortcode: turns it into the emoji (like Discord).
    const typed = emojiIndex && EMOJI_SHORTCODE.exec(value.slice(0, cursor));
    const emoji = typed && emojiIndex.byShortcode.get(typed[1].toLowerCase());
    if (emoji) {
      const native = skinFor(emoji, getSkinTone()).native;
      const start = cursor - typed[1].length - 2;
      value = value.slice(0, start) + native + value.slice(cursor);
      cursor = start + native.length;
      recordEmojiUse(emoji.id);
      setTimeout(() => inputRef.current?.setSelectionRange(cursor, cursor), 0);
    }

    setInputValue(value.slice(0, maxPlaintextLength));
    setCaret(cursor);
    setSuggestionIndex(0);
  }

  function handleInputKeyDown(e) {
    if (emojiSuggestions.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setSuggestionIndex((activeSuggestion + step + emojiSuggestions.length) % emojiSuggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickSuggestion(emojiSuggestions[activeSuggestion]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissedEmojiQuery(emojiQuery);
        return;
      }
    }
    if (!isMobile && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!inputValue.trim() || !chatUser) return;

    const text = inputValue.trim();
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

    setInputValue('');
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

  // The message box grows with its text.
  useEffect(() => {
    const textarea = inputRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, [inputValue, inputRef]);

  // The tray only shows drafts still referenced from the text; unreferenced ones are kept
  // until send so that undoing a deletion brings them back.
  const referencedDraftIds = findPlaceholderIds(inputValue);
  const visibleDrafts = attachments.drafts.filter((d) => referencedDraftIds.has(d.id));

  return (
    <>
      <div className={`dm-chat-wrapper${attachments.isDragOver ? ' drag-over' : ''}`} {...attachments.dropHandlers}>
        {showEmojiPicker && !isMobile && (
          <EmojiPicker onSelect={insertAtCursor} onClose={() => setShowEmojiPicker(false)} />
        )}

        {emojiSuggestions.length > 0 && (
          <EmojiSuggestions
            query={emojiQuery}
            emojis={emojiSuggestions}
            activeIndex={activeSuggestion}
            onPick={pickSuggestion}
            onHover={setSuggestionIndex}
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

          <textarea
            id="dm-input"
            className="form-control auto-resize-textarea"
            placeholder={`Message ${chatUser?.username || 'User'}...`}
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleInputKeyDown}
            onSelect={(e) => setCaret(e.target.selectionStart)}
            // Mobile: the keyboard is coming up, so the emoji panel gives way.
            onFocus={() => {
              if (!isMobile) return;
              setShowEmojiPicker(false);
              onInputFocus?.();
            }}
            onPaste={attachments.handlePaste}
            autoComplete="off"
            ref={inputRef}
            rows={1}
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
          onSelect={(native) => insertAtCursor(native, { focus: false })}
          onClose={() => setShowEmojiPicker(false)}
        />
      )}
    </>
  );
}
