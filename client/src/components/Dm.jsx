import React, { useEffect, useRef, useState, useContext, useLayoutEffect } from 'react';
import { useParams } from 'react-router-dom';
import '../assets/css/dms.css';
import { onNewDm } from '../utils/ws-client';
import { LayoutContext } from './Layout';
import { fetchMessagesForUser, sendMessageToUser, markMessagesRead } from '../services/dmService';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkEmoji from 'remark-emoji';
import rehypeHighlight from 'rehype-highlight';
import { Virtuoso } from 'react-virtuoso';
import { encryptMessage, decryptMessage, deriveSharedKey } from '../services/encryptionService';

function VirtuosoMessageList({ messages, user, hasMore, loadMoreMessages, firstItemIndex }) {
  return (
    <Virtuoso
      style={{ height: '100%', width: '100%' }}
      data={messages}
      firstItemIndex={firstItemIndex}
      initialTopMostItemIndex={messages.length - 1}
      startReached={hasMore ? loadMoreMessages : undefined}
      itemContent={(index, msg) => (
        <div
          className={`
            dm-message
            ${msg.sender_id === user.id ? 'sent' : 'received'}
            ${msg.status === 'pending' ? 'pending' : ''}
            ${msg.status === 'failed' ? 'failed' : ''}
          `}
        >
          <strong>{msg.sender_username}</strong>{' '}
          <small>{new Date(msg.timestamp * 1000).toLocaleString()}</small>
          <br />
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks, remarkEmoji]}
            rehypePlugins={[rehypeHighlight]}
          >
            {msg.plaintext}
          </ReactMarkdown>
        </div>
      )}
      followOutput="auto"
      increaseViewportBy={300}
    />
  );
}

export default function Dm({ user }) {
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

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
        const decryptedNewMessage = { ...message, plaintext };

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

    const fromId = decryptedNewMessage.sender_id.toString();
    const currentChatUserId = chatUser.id.toString();
    const currentUserId = user.id.toString();

    const isIncomingFromCurrentChatUser = fromId === currentChatUserId;
    const isOutgoingFromSelf =
      fromId === currentUserId && decryptedNewMessage.recipient_id?.toString() === currentChatUserId;

    if (isIncomingFromCurrentChatUser || isOutgoingFromSelf) {
      setMessages((prev) => [...prev, decryptedNewMessage]);
      if (isIncomingFromCurrentChatUser) markRead();
    } else {
      const dot = document.getElementById(`user-dot-${fromId}`);
      if (dot) dot.classList.add('active');
    }
  }


  async function decryptMessagesBatch(messages, key) {
    return Promise.all(messages.map(async msg => {
      try {
        const plaintext = await decryptMessage(msg.content, key);
        return { ...msg, plaintext };
      } catch (e) {
        console.warn("Failed to decrypt message", msg.id, e);
        return { ...msg, plaintext: null };
      }
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
    const tempMessage = {
      id: tempId,
      sender_id: user.id,
      recipient_id: chatUser.id,
      plaintext: messageText,
      status: 'pending',
      timestamp: Math.floor(Date.now() / 1000),
      sender_username: user.username,
    };
  
    // Add temp message
    setMessages(prev => [...prev, tempMessage]);
  
    try {
      const encryptedMessage = await encryptMessage(messageText, sharedKey);
      const savedMessage = await sendMessageToUser(chatUser.id, encryptedMessage);
  
      // Replace temp message
      setMessages(prev =>
        prev.map(msg =>
          msg.id === tempId
            ? {
                ...savedMessage,
                plaintext: messageText,
                status: 'sent',
                timestamp: savedMessage.timestamp || tempMessage.timestamp,
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
                initialTopMostItemIndex={firstItemIndex + messages.length - 1}
              />
            )}
          </div>

          <div className="dm-chat-wrapper">
            <form
              id="dm-chat-form"
              className="d-flex flex-grow-1"
              onSubmit={handleSendMessage}
            >
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
                rows={1}
              />
              <button className="btn btn-primary" type="submit">
                Send
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}