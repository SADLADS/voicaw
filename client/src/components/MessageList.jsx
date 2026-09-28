import React, { createContext, useContext } from 'react';
import { Virtuoso } from 'react-virtuoso';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkEmoji from 'remark-emoji';
import rehypeHighlight from 'rehype-highlight';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faEdit, faTrash, faReply } from '@fortawesome/free-solid-svg-icons';
import defaultpfp from '../assets/images/default.png';
import Attachment from './Attachment';
import { placeholderIdFromUrl, summarizeAttachments } from '../utils/attachmentMarkup';

// react-markdown's `components` must keep a stable identity: a new function each render
// is a new component type to React, which remounts (and reloads) every attachment on any
// re-render. The per-message local drafts come in through context instead.
const LocalAttachmentsContext = createContext(null);

function MarkdownImage({ src, alt }) {
  const localAttachments = useContext(LocalAttachmentsContext);
  return <Attachment src={src} alt={alt} localAttachments={localAttachments} />;
}

const markdownComponents = { img: MarkdownImage };

// react-markdown blanks URLs with unknown schemes; let draft placeholders through so
// pending messages can show their attachments while uploading.
function urlTransform(url) {
  return placeholderIdFromUrl(url) !== null ? url : defaultUrlTransform(url);
}

function extractUrls(text) {
  if (!text) return [];
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.match(urlRegex) || [];
}

function UrlPreview({ url }) {
  let embedUrl = url;

  // Simple YouTube embed conversion
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    const videoId = url.includes('youtu.be')
      ? url.split('/').pop()
      : new URL(url).searchParams.get('v');

    embedUrl = `https://www.youtube.com/embed/${videoId}`;
    return (
      <div className="youtube-wrapper">
        <iframe
          src={embedUrl}
          title="YouTube video"
          allowFullScreen
        ></iframe>
      </div>
    );
  }
  return null;
}

export default function MessageList({
  messages,
  user,
  hasMore,
  loadMoreMessages,
  s3Endpoint,
  firstItemIndex,
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
}) {
  return (
    <Virtuoso
      style={{ height: '100%', width: '100%' }}
      data={messages}
      firstItemIndex={firstItemIndex}
      initialTopMostItemIndex={messages.length - 1}
      startReached={hasMore ? loadMoreMessages : undefined}
      itemContent={(index, msg) => {
        const imgSrc = s3Endpoint
          ? `${s3Endpoint}/profile-pics/${msg.sender_id}`
          : defaultpfp;

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

            {hoveredMsgId === msg.id && (
              <div className="message-menu">
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
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  objectFit: 'cover',
                  flexShrink: 0,
                  display: 'inline',
                }}
              />
              <strong> {msg.sender_username}</strong>{' '}

              <small>
                {new Date(msg.timestamp * 1000).toLocaleString()}
                {msg.edited ? <em style={{ marginLeft: '6px' }}>edited</em> : null}
              </small>

              <div className="dm-message-content">
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
                      rehypePlugins={[rehypeHighlight]}
                      urlTransform={urlTransform}
                      components={markdownComponents}
                    >
                      {msg.plaintext}
                    </ReactMarkdown>
                  </LocalAttachmentsContext.Provider>
                )}


                {extractUrls(msg.plaintext).map((url, idx) => (
                  <UrlPreview key={idx} url={url} />
                ))}
              </div>

            </div>
          </div>
        );
      }}
      // Key rows by message, not position: a deleted message must not shift every later
      // row onto a different message. `clientKey` survives the temp id -> real id swap.
      computeItemKey={(index, msg) => msg.clientKey ?? msg.id}
      followOutput="auto"
      // Render (and so measure) well above the viewport, so older messages have their real
      // height before they scroll into view instead of being corrected on screen.
      increaseViewportBy={{ top: 800, bottom: 300 }}
    />
  );
}