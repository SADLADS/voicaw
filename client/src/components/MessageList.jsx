import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkEmoji from 'remark-emoji';
import rehypeHighlight from 'rehype-highlight';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faEdit, faTrash, faReply, faFaceSmile } from '@fortawesome/free-solid-svg-icons';
import defaultpfp from '../assets/images/default.png';
import Attachment from './Attachment';
import MessageReactions from './MessageReactions';
import UrlPreviews from './UrlPreviews';
import { useLongPress } from '../hooks/useLongPress';
import { placeholderIdFromUrl, summarizeAttachments } from '../utils/attachmentMarkup';
import { useEmojiIndex } from '../emoji/emojiContext';
import { isEmojiOnly } from '../emoji/emojiIndex';
import { rehypeTwemoji } from '../emoji/rehypeTwemoji';

// react-markdown's `components` must keep a stable identity: a new function each render
// is a new component type to React, which remounts (and reloads) every attachment on any
// re-render. The per-message local drafts come in through context instead.
const LocalAttachmentsContext = createContext(null);

function MarkdownImage({ src, alt, className, title }) {
  const localAttachments = useContext(LocalAttachmentsContext);
  // Twemoji images from rehypeTwemoji, not attachments.
  if (className === 'emoji') {
    return <img className="emoji" src={src} alt={alt} title={title} draggable={false} />;
  }
  return <Attachment src={src} alt={alt} localAttachments={localAttachments} />;
}

const markdownComponents = { img: MarkdownImage };

// react-markdown blanks URLs with unknown schemes; let draft placeholders through so
// pending messages can show their attachments while uploading.
function urlTransform(url) {
  return placeholderIdFromUrl(url) !== null ? url : defaultUrlTransform(url);
}

// One message (with its reply snippet, hover menu and inline editor).
export function MessageRow({
  msg,
  user,
  s3Endpoint,
  hoveredMsgId,
  setHoveredMsgId,
  handleEdit,
  handleDelete,
  handleReply,
  editingMessageId,
  editingMessageContent,
  setEditingMessageContent,
  setEditingMessageId,
  handleSaveEdit,
  isMobile,
  editRef,
  maxPlaintextLength,
  onToggleReaction,
  onOpenReactionPicker,
  reactionNames,
  onOpenActions,
}) {
  const emojiIndex = useEmojiIndex();
  // Mobile: touch and hold opens the message's action sheet (there's no hover there).
  const longPress = useLongPress(() => onOpenActions(msg), { enabled: isMobile && Boolean(onOpenActions) });
  // Stable per emoji index (a new plugin list every render would re-run markdown needlessly).
  const rehypePlugins = useMemo(
    () => (emojiIndex ? [rehypeHighlight, rehypeTwemoji(emojiIndex)] : [rehypeHighlight]),
    [emojiIndex]
  );

  const imgSrc = s3Endpoint
    ? `${s3Endpoint}/profile-pics/${msg.sender_id}`
    : defaultpfp;

  // Not before the server has the message (it has no id yet).
  const canReact = Boolean(onToggleReaction) && msg.status !== 'pending' && msg.status !== 'failed';

  const parent = msg.parent_message_id
    ? {
      id: msg.parent_message_id,
      plaintext: msg.parent_plaintext,
      sender_username: msg.parent_username,
      sender_id: msg.parent_sender_id,
    }
    : null;

  return (
    <div
      className={`each-dm-message-wrapper ${msg.sender_id === user.id ? 'sent' : 'received'}`}
      data-msg-id={msg.id}
      onMouseEnter={() => setHoveredMsgId(msg.id)}
      onMouseLeave={() => setHoveredMsgId(null)}
      {...longPress}
    >
      {parent && (
        <div className="reply-snippet">
          <img
            src={s3Endpoint ? `${s3Endpoint}/profile-pics/${parent.sender_id}` : defaultpfp}
            alt={parent.sender_username}
            className="reply-avatar"
            onError={(e) => {
              e.currentTarget.onerror = null;
              e.currentTarget.src = defaultpfp;
            }}
          />
          <span className="reply-author">{parent.sender_username}</span>
          <span
            className="reply-preview"
            onClick={() => {
              const el = document.querySelector(
                `[data-msg-id="${msg.parent_message_id}"]`
              );
              if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
          >
            {summarizeAttachments(parent.plaintext)?.slice(0, 80) || "…"}
          </span>
        </div>
      )}

      {hoveredMsgId === msg.id && !isMobile && (
        <div className="message-menu">
          {canReact && (
            <button
              className="icon-button"
              aria-label="Add reaction"
              // Keep an open picker's outside-click handler from closing it before this toggles it.
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => onOpenReactionPicker(msg, e.currentTarget)}
            >
              <FontAwesomeIcon icon={faFaceSmile} title="Add reaction" />
            </button>
          )}
          {msg.sender_id === user.id && (
            <button className="icon-button" onClick={() => handleEdit(msg)}>
              <FontAwesomeIcon icon={faEdit} title="Edit" />
            </button>
          )}
          <button className="icon-button" onClick={() => handleReply(msg)}>
            <FontAwesomeIcon icon={faReply} title="Reply" />
          </button>
          {msg.sender_id === user.id && (
            <button
              className="icon-button trash-button"
              onClick={() => handleDelete(msg)}
            >
              <FontAwesomeIcon icon={faTrash} title="Delete" />
            </button>
          )}
        </div>
      )}

      <div
        className={`
          dm-message message
          ${msg.sender_id === user.id ? 'sent' : 'received'}
          ${msg.status === 'pending' ? 'pending' : ''}
          ${msg.status === 'failed' ? 'failed' : ''}
        `}
      >
        <img
          src={imgSrc}
          alt={msg.sender_username}
          onError={(e) => {
            e.currentTarget.onerror = null;
            e.currentTarget.src = defaultpfp;
          }}
          className="message-avatar"
        />
        <strong> {msg.sender_username}</strong>{' '}

        <small>
          {new Date(msg.timestamp * 1000).toLocaleString()}
          {msg.edited ? <em style={{ marginLeft: '6px' }}>edited</em> : null}
        </small>

        <div className={`dm-message-content${isEmojiOnly(msg.plaintext, emojiIndex) ? ' emoji-only' : ''}`}>
          {editingMessageId === msg.id ? (
            <div className="inline-edit-wrapper">
              <form onSubmit={(e) => e.preventDefault()}>

                <textarea
                  id={`edit-input-${msg.id}`}
                  value={editingMessageContent}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value.length <= maxPlaintextLength) {
                      setEditingMessageContent(value);
                    } else {
                      setEditingMessageContent(value.slice(0, maxPlaintextLength));
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setEditingMessageId(null);
                    if (!isMobile && e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSaveEdit(msg.id);
                    }
                  }}
                  className="form-control auto-resize-textarea"
                  rows={1}
                  style={{ width: '100%' }}
                  ref={(el) => {
                    editRef.current = el;
                    if (el) {
                      el.style.height = 'auto';
                      el.style.height = `${el.scrollHeight}px`;
                      el.focus();
                    }
                  }}
                />
              </form>

              <div className="inline-edit-banner">
                <span>
                  Escape to <a href="#" onClick={(e) => { e.preventDefault(); setEditingMessageId(null); }}>cancel</a> • Enter to <a href="#" onClick={(e) => { e.preventDefault(); handleSaveEdit(msg.id); }}>save</a>
                </span>
              </div>
            </div>
          ) : (
            <LocalAttachmentsContext.Provider value={msg.localAttachments ?? null}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkEmoji]}
                rehypePlugins={rehypePlugins}
                urlTransform={urlTransform}
                components={markdownComponents}
              >
                {msg.plaintext}
              </ReactMarkdown>
            </LocalAttachmentsContext.Provider>
          )}


          <UrlPreviews text={msg.plaintext} />
        </div>

        {canReact && (
          <MessageReactions
            reactions={msg.reactions}
            userId={user.id}
            names={reactionNames}
            onToggle={(emoji) => onToggleReaction(msg, emoji)}
            onAdd={(anchor) => onOpenReactionPicker(msg, anchor)}
          />
        )}

      </div>
    </div>
  );
}

// How close to the top (in viewport heights) to start fetching older history, so it's
// usually in place before the user gets there.
const LOAD_OLDER_WITHIN_VIEWPORTS = 1.5;
// Within this many px of the bottom counts as "at the bottom" (keep following new messages).
const PINNED_TOLERANCE_PX = 4;

const rowKey = (msg) => String(msg.clientKey ?? msg.id);

// Chrome/Firefox keep the visible content still when things above it change size or are
// inserted (CSS scroll anchoring). Safari doesn't, so there we do it ourselves.
const NATIVE_SCROLL_ANCHORING =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('overflow-anchor', 'auto');

// A plain (non-virtualized) scrolling list. Virtualized lists have to guess the height of
// rows they haven't rendered and correct it afterwards, which shows as the content jumping
// while scrolling up; with every row rendered, the browser always knows the real layout.
export default function MessageList({
  messages,
  user,
  hasMore,
  loadMoreMessages,
  s3Endpoint,
  hoveredMsgId,
  setHoveredMsgId,
  handleEdit,
  handleDelete,
  handleReply,
  editingMessageId,
  editingMessageContent,
  setEditingMessageContent,
  setEditingMessageId,
  handleSaveEdit,
  isMobile,
  editRef,
  maxPlaintextLength,
  onToggleReaction,
  onOpenReactionPicker,
  reactionNames,
  onOpenActions,
}) {
  const scrollerRef = useRef(null);
  const contentRef = useRef(null);
  // Following the newest message (true until the user scrolls away from the bottom).
  const pinnedToBottom = useRef(true);
  // The list's own height when last seen, to tell the list resizing apart from user scrolling.
  const lastListHeight = useRef(null);
  // Manual anchoring only: the first visible row and its position within the content.
  // Scrolling doesn't change that position; content changing above the row does, and that
  // difference is exactly how far to scroll to keep the row still.
  const anchor = useRef(null);

  const latest = useRef({ hasMore, loadMoreMessages });
  latest.current = { hasMore, loadMoreMessages };

  const rowProps = {
    user,
    s3Endpoint,
    hoveredMsgId,
    setHoveredMsgId,
    handleEdit,
    handleDelete,
    handleReply,
    editingMessageId,
    editingMessageContent,
    setEditingMessageContent,
    setEditingMessageId,
    handleSaveEdit,
    isMobile,
    editRef,
    maxPlaintextLength,
    onToggleReaction,
    onOpenReactionPicker,
    reactionNames,
    onOpenActions,
  };

  const rememberAnchor = useCallback(() => {
    if (NATIVE_SCROLL_ANCHORING) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    for (const row of contentRef.current.children) {
      if (row.offsetTop + row.offsetHeight > scroller.scrollTop) {
        anchor.current = { key: row.dataset.key, top: row.offsetTop };
        return;
      }
    }
    anchor.current = null;
  }, []);

  // Keep the view where it should be after the content changed: at the bottom if we're
  // following new messages, otherwise (without native anchoring) with the anchor row still.
  const keepAnchorInPlace = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (pinnedToBottom.current) {
      scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    if (NATIVE_SCROLL_ANCHORING) return;
    const saved = anchor.current;
    const row = saved && [...contentRef.current.children].find((el) => el.dataset.key === saved.key);
    if (!row) return;
    const drift = row.offsetTop - saved.top;
    if (Math.abs(drift) >= 1) scroller.scrollTop += drift;
  }, []);

  const maybeLoadOlder = useCallback(() => {
    const scroller = scrollerRef.current;
    const { hasMore: more, loadMoreMessages: load } = latest.current;
    if (!scroller || !more) return;
    if (scroller.scrollTop < scroller.clientHeight * LOAD_OLDER_WITHIN_VIEWPORTS) load();
  }, []);

  const handleScroll = () => {
    const scroller = scrollerRef.current;
    // The list itself just changed height (keyboard / mobile emoji panel). The browser's scroll
    // anchoring may nudge scrollTop, firing this before the ResizeObserver runs: that isn't
    // the user scrolling away, so stay at the bottom if we were there.
    const resized = lastListHeight.current !== null && scroller.clientHeight !== lastListHeight.current;
    lastListHeight.current = scroller.clientHeight;
    if (resized && pinnedToBottom.current) {
      scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    pinnedToBottom.current =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= PINNED_TOLERANCE_PX;
    // Content may have shifted since the anchor was recorded (e.g. an image above loaded in
    // the same frame as this scroll): correct that before recording the new position.
    if (!pinnedToBottom.current) keepAnchorInPlace();
    rememberAnchor();
    maybeLoadOlder();
  };

  // After messages change (older page prepended, new message appended, …), before paint.
  useLayoutEffect(() => {
    keepAnchorInPlace();
    rememberAnchor();
    // Keep fetching until the viewport is filled or history runs out.
    maybeLoadOlder();
  }, [messages, hasMore, keepAnchorInPlace, rememberAnchor, maybeLoadOlder]);

  // Rows changing size (images/videos loading, code highlighting, edits), and the list itself
  // changing height (keyboard or mobile emoji panel opening). ResizeObserver callbacks run
  // after layout but before paint, so the correction is never seen.
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      keepAnchorInPlace();
      rememberAnchor();
      lastListHeight.current = scrollerRef.current?.clientHeight ?? null;
    });
    observer.observe(contentRef.current);
    observer.observe(scrollerRef.current);
    return () => observer.disconnect();
  }, [keepAnchorInPlace, rememberAnchor]);

  return (
    <div className="message-scroller" ref={scrollerRef} onScroll={handleScroll}>
      <div className="message-scroller-content" ref={contentRef}>
        {messages.map((msg) => (
          <div key={rowKey(msg)} data-key={rowKey(msg)}>
            <MessageRow msg={msg} {...rowProps} />
          </div>
        ))}
      </div>
    </div>
  );
}
