import React from 'react';
import { Virtuoso } from 'react-virtuoso';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkEmoji from 'remark-emoji';
import rehypeHighlight from 'rehype-highlight';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faEdit, faTrash, faReply } from '@fortawesome/free-solid-svg-icons';
import defaultpfp from '../assets/images/default.png';

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
                  {parent.plaintext?.slice(0, 80) || "…"}
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
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkEmoji]}
                    rehypePlugins={[rehypeHighlight]}
                  >
                    {msg.plaintext}
                  </ReactMarkdown>
                )}


                {extractUrls(msg.plaintext).map((url, idx) => (
                  <UrlPreview key={idx} url={url} />
                ))}
              </div>

            </div>
          </div>
        );
      }}
      followOutput="auto"
      increaseViewportBy={300}
    />
  );
}