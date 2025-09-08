import React, { useEffect, useRef, useState, useContext, useLayoutEffect } from 'react';
import { useParams } from 'react-router-dom';
import '../assets/css/dms.css';
import { onNewDm, onDeleteDm, onEditDm } from '../utils/ws-client';
import { LayoutContext } from './Layout';
import { fetchMessagesForUser, sendMessageToUser, markMessagesRead } from '../services/dmService';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkEmoji from 'remark-emoji';
import rehypeHighlight from 'rehype-highlight';
import { Virtuoso } from 'react-virtuoso';
import { encryptMessage, decryptMessage, deriveSharedKey } from '../services/encryptionService';
import { ConfigContext } from '../App';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus } from '@fortawesome/free-solid-svg-icons';
import defaultpfp from '../assets/images/default.png';
import { InteractionContext } from "../App";
import { faEdit, faTrash, faReply } from '@fortawesome/free-solid-svg-icons';
import api from '../utils/api';


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
          frameBorder="0"
          allowFullScreen
        ></iframe>
      </div>
    );
  }
}



function VirtuosoMessageList({ messages, user, hasMore, loadMoreMessages, s3Endpoint, firstItemIndex, hoveredMsgId, setHoveredMsgId, handleEdit, handleDelete, handleReply, editingMessageId, editingMessageContent, setEditingMessageContent, setEditingMessageId, handleSaveEdit, isMobile }) {
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
                        onChange={(e) => setEditingMessageContent(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setEditingMessageId(null);
                          if (!isMobile && e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleSendMessage(e);
                          }
                        }}
                        className="form-control auto-resize-textarea"
                        rows={1}
                        style={{ width: '100%' }}
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
                    remarkPlugins={[remarkGfm, remarkBreaks, remarkEmoji]}
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

export default function Dm({ user }) {
  const { s3Endpoint } = useContext(ConfigContext);
  const { isMobile } = useContext(InteractionContext);


  const INITIAL_INDEX = 100000;

  const [firstItemIndex, setFirstItemIndex] = useState(INITIAL_INDEX);

  const { unreadDms, users, errorUsers, fetchUnreadMessages } = useContext(LayoutContext);
  const { id } = useParams();

  const [messages, setMessages] = useState([]);
  const [errorMessages, setErrorMessages] = useState(null);
  const [inputValue, setInputValue] = useState('');
  const [hasMore, setHasMore] = useState(true);

  const inputRef = useRef(null);
  const initialLoad = useRef(true);

  const [sharedKey, setSharedKey] = useState(null);

  const chatUser = users.find((u) => u.id.toString() === id);

  const [isLoading, setIsLoading] = useState(true);

  const [hoveredMsgId, setHoveredMsgId] = useState(null);

  const [messageToReply, setMessageToReply] = useState(null);

  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editingMessageContent, setEditingMessageContent] = useState('');


  function handleEdit(msg) {
    setEditingMessageId(msg.id);
    setEditingMessageContent(msg.plaintext);
    setTimeout(() => {
      const textarea = document.getElementById(`edit-input-${msg.id}`);
      textarea?.focus();
      textarea?.select();
    }, 0);
  }

  async function handleSaveEdit(id) {
    try {
      const plaintextEditingContent = await encryptMessage(editingMessageContent, sharedKey);
      await api.put(`/update-message/${id}`, { content: plaintextEditingContent });

      // Update the message locally
      setMessages(prev =>
        prev.map(msg =>
          msg.id === id ? { ...msg, plaintext: editingMessageContent } : msg
        )
      );

      // Exit edit mode
      setEditingMessageId(null);
    } catch (err) {
      console.error('Failed to edit message', err);
    }
  }



  async function handleDelete(msg) {
    try {
      await api.delete(`/messages/${msg.id}`);
      // Remove message from local state
      setMessages(prev => prev.filter(m => m.id !== msg.id));
    } catch (err) {
      console.error('Failed to delete message', err);
    }
  }

  function handleReply(msg) {
    setMessageToReply(msg);
    inputRef.current?.focus();
  }

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === "Escape") {
        setMessageToReply(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (!id || !chatUser?.public_key) {
      setMessages([]);
      setIsLoading(false);
      return;
    }

    const loadChatData = async () => {
      setIsLoading(true);
      setMessages([]);
      setFirstItemIndex(INITIAL_INDEX);
      setHasMore(true);
      setErrorMessages(null);

      try {
        // derive the shared key
        const privatePEM = localStorage.getItem('privateKey');
        if (!privatePEM) throw new Error("No private key found.");

        const key = await deriveSharedKey(privatePEM, chatUser.public_key);
        setSharedKey(key);

        // Fetch initial messages with the new key
        const initialMessages = await fetchMessagesForUser(id);

        // decrypt the messages
        const decryptedMessages = await decryptMessagesBatch(initialMessages, key);

        // set the state
        setMessages(decryptedMessages);
        setHasMore(initialMessages.length > 0);

      } catch (e) {
        console.error("Failed to load chat data:", e);
        setErrorMessages(e.message);
        setMessages([]); // clear messages on error
      } finally {
        setIsLoading(false); // stop loading
      }
    };

    loadChatData();

  }, [id, chatUser]);


  useEffect(() => {
    setFirstItemIndex(INITIAL_INDEX);
    setMessages([]);
    setHasMore(true);
    if (!id) return;
  }, [id, chatUser]);

  useEffect(() => {
    async function deriveKey() {
      if (!chatUser?.public_key) {
        setSharedKey(null);
        return;
      }

      try {
        const privatePEM = localStorage.getItem('privateKey');
        if (!privatePEM) throw new Error("No private key found for decryption.");
        const key = await deriveSharedKey(privatePEM, chatUser.public_key);
        setSharedKey(key);
        console.log("set shared key!", key);
      } catch (e) {
        console.error("Failed to derive shared key:", e);
        setSharedKey(null);
      }
    }

    // reset UI state when switching chats
    setMessages([]);
    setHasMore(true);
    setFirstItemIndex(INITIAL_INDEX);

    deriveKey();
  }, [chatUser?.public_key]);


  useEffect(() => {
    if (!chatUser?.id) return;
    markRead();
    const dot = document.getElementById(`user-dot-${chatUser?.id}`);
    if (dot) {
      dot.classList.remove('active');
    }
  }, [chatUser?.id]);


  useEffect(() => {
    if (!user?.id || !chatUser?.id || !sharedKey) return;

    const unsubscribe = onNewDm(async (message) => {
      console.log("new dm!", message);
      // If there's already plaintext on the message, use it.
      if (message.plaintext) {
        handleIncomingMessage(message, true);
        return;
      }

      if (!sharedKey) {
        console.warn("Received DM but sharedKey not ready. Skipping decrypt for message:", message.id);
        return;
      }

      try {
        const plaintext = await decryptMessage(message.content, sharedKey);
        let parent_plaintext = "";
        if (message.parent_message_id && message.parent_content) {
          try {
            parent_plaintext = await decryptMessage(message.parent_content, sharedKey);
          } catch (e) {
            console.warn("Failed to decrypt parent message", message.parent_message_id, e);
          }
        }
        const decryptedNewMessage = { ...message, plaintext, parent_plaintext };

        handleIncomingMessage(decryptedNewMessage);
      } catch (err) {
        console.warn("Failed to decrypt incoming DM", message.id, err);
        // Do null plaintext so UI won't crash
        const fallback = { ...message, plaintext: null };
        handleIncomingMessage(fallback);
      }
    });

    return () => unsubscribe();
  }, [chatUser?.id, user?.id, sharedKey]);


  useEffect(() => {
    const unsubscribeDelete = onDeleteDm(({ messageId, sender_id }) => {
      const currentChatUserId = chatUser?.id?.toString();
      if (!currentChatUserId) return;

      setMessages(prev =>
        prev.filter(msg =>
          msg.id !== messageId &&
          (msg.sender_id?.toString() === currentChatUserId || msg.recipient_id?.toString() === currentChatUserId)
        )
      );
    });

    return () => unsubscribeDelete();
  }, [chatUser?.id]);


  useEffect(() => {
    const unsubscribeEdit = onEditDm(({ messageId, content, sender_id }) => {
      const updateMessage = async () => {
        try {
          const plaintextEdit = await decryptMessage(content, sharedKey);
          const currentChatUserId = chatUser?.id?.toString();
          if (!currentChatUserId) return;

          setMessages(prev =>
            prev.map(msg =>
              msg.id === messageId &&
                (msg.sender_id?.toString() === currentChatUserId || msg.recipient_id?.toString() === currentChatUserId)
                ? { ...msg, plaintext: plaintextEdit, edited: 1 }
                : msg
            )
          );
        } catch (err) {
          console.error("Failed to decrypt edited message", err);
        }
      };

      updateMessage();
    });

    return () => unsubscribeEdit();
  }, [chatUser?.id, sharedKey]);


  useEffect(() => {
    const textarea = inputRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, [inputValue]);


  useEffect(() => {
    if (sharedKey) {
      fetchMessages();
    }
  }, [sharedKey]);


  function handleIncomingMessage(message, alreadyPlain = false) {
    const decryptedNewMessage = alreadyPlain ? message : { ...message };

    setMessages(prev => {
      // check if message exists by id
      const byId = prev.findIndex(m => m.id === decryptedNewMessage.id);
      if (byId !== -1) return prev; // duplicate, skip

      // check if temp message exists (by matching sender, recipient, content)
      const tempIndex = prev.findIndex(
        m =>
          m.status === 'pending' &&
          m.sender_id === decryptedNewMessage.sender_id &&
          m.recipient_id === decryptedNewMessage.recipient_id &&
          m.plaintext === decryptedNewMessage.plaintext
      );

      if (tempIndex !== -1) {
        // replace temp message with real message
        const updated = [...prev];
        updated[tempIndex] = decryptedNewMessage;
        return updated;
      }

      // add new message normally
      const fromId = decryptedNewMessage.sender_id.toString();
      const currentChatUserId = chatUser.id.toString();
      const currentUserId = user.id.toString();

      const isIncomingFromCurrentChatUser = fromId === currentChatUserId;
      const isOutgoingFromSelf =
        fromId === currentUserId && decryptedNewMessage.recipient_id?.toString() === currentChatUserId;

      if (isIncomingFromCurrentChatUser || isOutgoingFromSelf) {
        if (isIncomingFromCurrentChatUser) markRead();
        return [...prev, decryptedNewMessage];
      } else {
        const dot = document.getElementById(`user-dot-${fromId}`);
        if (dot) dot.classList.add('active');
        return prev;
      }
    });
  }




  async function decryptMessagesBatch(messages, key) {
    return Promise.all(messages.map(async msg => {
      let plaintext = null;
      let parentPlaintext = null;

      try {
        plaintext = await decryptMessage(msg.content, key);
      } catch (e) {
        console.warn("Failed to decrypt message", msg.id, e);
      }

      if (msg.parent_message_id && msg.parent_content) {
        try {
          parentPlaintext = await decryptMessage(msg.parent_content, key);
        } catch (e) {
          console.warn("Failed to decrypt parent message", msg.parent_message_id, e);
        }
      }

      return { ...msg, plaintext, parent_plaintext: parentPlaintext };
    }));
  }




  async function fetchMessages(beforeId = null) {
    console.log("fetch messages!")
    try {
      const data = await fetchMessagesForUser(id, { before: beforeId });
      const privatePEM = localStorage.getItem('privateKey');
      if (!privatePEM) throw new Error("No private key found for decryption.");
      const decryptedNewMessages = await decryptMessagesBatch(data, sharedKey)
      if (beforeId) {
        setMessages((prev) => [...decryptedNewMessages, ...prev]);
      } else {
        setMessages(decryptedNewMessages);
      }
      setHasMore(data.length > 0);
      setErrorMessages(null);
    } catch (e) {
      setErrorMessages(e.message);
    }
  }





  const loadMoreMessages = async () => {
    console.log("load more!")
    const oldest = messages[0];
    if (!oldest) return;

    try {
      const newMessages = await fetchMessagesForUser(id, { before: oldest.id });

      const privatePEM = localStorage.getItem('privateKey');
      if (!privatePEM) throw new Error("No private key found for decryption.");
      if (!chatUser) throw new Error("Chat user not loaded for decryption.");

      const decryptedNewMessages = await decryptMessagesBatch(newMessages, sharedKey)

      if (decryptedNewMessages.length > 0) {
        setMessages((prev) => [...decryptedNewMessages, ...prev]);
        setFirstItemIndex((prev) => prev - decryptedNewMessages.length);
      }

      setHasMore(decryptedNewMessages.length > 0);
    } catch (e) {
      setErrorMessages(e.message);
    }
  };


  const markRead = async () => {
    try {
      if (!chatUser) return;
      await markMessagesRead(chatUser.id);
      fetchUnreadMessages?.();
    } catch (err) {
      console.warn('Failed to mark messages as read', err);
    }
  };


  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!inputValue.trim() || !chatUser) return;

    const messageText = inputValue.trim();
    setInputValue('');
    const tempId = `temp-${Date.now()}`;

    const pm_id = messageToReply?.id || null;
    const pm_plaintext = messageToReply?.plaintext || null;

    const tempMessage = {
      id: tempId,
      sender_id: user.id,
      recipient_id: chatUser.id,
      plaintext: messageText,
      status: 'pending',
      timestamp: Math.floor(Date.now() / 1000),
      sender_username: user.username,
      parent_message_id: pm_id,
      parent_plaintext: pm_plaintext,
    };

    setMessageToReply(null)

    // Add temp message
    setMessages(prev => [...prev, tempMessage]);

    try {
      const encryptedMessage = await encryptMessage(messageText, sharedKey);
      const savedMessage = await sendMessageToUser(chatUser.id, encryptedMessage, pm_id);

      // Replace temp message
      setMessages(prev =>
        prev.map(msg =>
          msg.id === tempId
            ? {
              ...savedMessage,
              plaintext: messageText,
              status: 'sent',
              timestamp: savedMessage.timestamp || tempMessage.timestamp,
              parent_plaintext: pm_plaintext,
            }
            : msg
        )
      );

      setErrorMessages(null);
    } catch (error) {
      console.error('Error sending message:', error);

      // Mark temp message as failed
      setMessages(prev =>
        prev.map(msg =>
          msg.id === tempId ? { ...msg, status: 'failed' } : msg
        )
      );

      setErrorMessages(error.message);
    }
  };


  return (
    <div
      id="dm-main"
      data-current-user-id={user?.id}
      data-other-user-id={chatUser?.id}
    >
      {errorUsers && <p className="error-text">Error loading users: {errorUsers}</p>}
      {users.length === 0 && !errorUsers && !id && <p>No recent conversations found.</p>}

      {id && (
        <>
          <h4 className="chat-recipient-header">{chatUser?.username || 'User'}</h4>

          <div className="dm-message-wrapper">
            {isLoading ? (
              <p></p>
            ) : errorMessages ? (
              <p className="error-text">Error: {errorMessages}</p>
            ) : messages.length === 0 ? (
              <p>No messages yet. Start the conversation!</p>
            ) : (
              <VirtuosoMessageList
                key={id}
                messages={messages}
                user={user}
                hasMore={hasMore}
                loadMoreMessages={loadMoreMessages}
                firstItemIndex={firstItemIndex}
                s3Endpoint={s3Endpoint}
                initialTopMostItemIndex={firstItemIndex + messages.length - 1}
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
              />
            )}
          </div>

          <div className="dm-chat-wrapper">
            {messageToReply && (
              <div className="reply-bar">
                <span>
                  Replying to <strong>{messageToReply?.sender_username}</strong>
                </span>
                <button
                  className="reply-close"
                  onClick={() => setMessageToReply(null)}
                  type="button"
                >
                  ×
                </button>
              </div>
            )}

            <form
              id="dm-chat-form"
              className="d-flex flex-grow-1"
              onSubmit={handleSendMessage}
            ><div className="attach-wrapper">
                <button className="attach-button">
                  <FontAwesomeIcon icon={faPlus} />
                </button>
              </div>
              <textarea
                id="dm-input"
                className="form-control auto-resize-textarea"
                placeholder={`Message ${chatUser?.username || 'User'}...`}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (!isMobile && e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSendMessage(e);
                  }
                }}
                autoComplete="off"
                ref={inputRef}
                rows={2}
              />
              <div className="chat-buttons">
                <button className="emoji-button">
                  😎
                </button>
                <button className="send-button" type="submit">
                  Send
                </button>
              </div>
            </form>
          </div>
        </>
      )}
    </div>
  );
}