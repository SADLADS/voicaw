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

function VirtuosoMessageList({ messages, user, hasMore, loadMoreMessages, firstItemIndex }) {
  return (
    <Virtuoso
      style={{ height: '100%', width: '100%' }}
      data={messages}
      firstItemIndex={firstItemIndex}
      initialTopMostItemIndex={messages.length - 1}
      startReached={hasMore ? loadMoreMessages : undefined}
      itemContent={(index, msg) => (
        <div className={`dm-message ${msg.sender_id === user.id ? 'sent' : 'received'}`}>
          <strong>{msg.sender_username}</strong>{' '}
          <small>{new Date(msg.timestamp * 1000).toLocaleString()}</small>
          <br />
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks, remarkEmoji]}
            rehypePlugins={[rehypeHighlight]}
          >
            {msg.content}
          </ReactMarkdown>
        </div>
      )}
      followOutput="auto"
      increaseViewportBy={300}
    />
  );
}



export default function Dm({ user }) {
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

  const chatUser = users.find((u) => u.id.toString() === id);

  useEffect(() => {
    setFirstItemIndex(INITIAL_INDEX);
    setMessages([]);
    setHasMore(true);
    if (!id) return;
    fetchMessages();
  }, [id]);


  useEffect(() => {
    if (!chatUser?.id) return;
    markRead();
    const dot = document.getElementById(`user-dot-${chatUser?.id}`);
    if (dot) {
      dot.classList.remove('active');
    }
  }, [chatUser?.id]);

  useEffect(() => {
    if (!user?.id || !chatUser?.id) return;

    const unsubscribe = onNewDm((message) => {
      const fromId = message.sender_id.toString();
      const currentChatUserId = chatUser.id.toString();
      const currentUserId = user.id.toString();

      const isIncomingFromCurrentChatUser = fromId === currentChatUserId;
      const isOutgoingFromSelf =
        fromId === currentUserId && message.recipient_id.toString() === currentChatUserId;

      if (isIncomingFromCurrentChatUser || isOutgoingFromSelf) {
        setMessages((prev) => [...prev, message]);
        if (isIncomingFromCurrentChatUser) {
          markRead();
        }
      } else {
        const dot = document.getElementById(`user-dot-${fromId}`);
        if (dot) {
          dot.classList.add('active');
        }
      }
    });

    return () => unsubscribe();
  }, [chatUser?.id, user?.id]);

  useEffect(() => {
    const textarea = inputRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, [inputValue]);

  async function fetchMessages(beforeId = null) {
    try {
      const data = await fetchMessagesForUser(id, { before: beforeId });
      if (beforeId) {
        setMessages((prev) => [...data, ...prev]);
      } else {
        setMessages(data);
      }
      setHasMore(data.length > 0);
      setErrorMessages(null);
    } catch (e) {
      setErrorMessages(e.message);
    }
  }

  const loadMoreMessages = async () => {
    const prevLength = messages.length;
    const oldest = messages[0];
    if (!oldest) return;

    const newMessages = await fetchMessagesForUser(id, { before: oldest.id });

    if (newMessages.length > 0) {
      setMessages((prev) => [...newMessages, ...prev]);
      setFirstItemIndex((prev) => prev - newMessages.length);
    }

    setHasMore(newMessages.length > 0);
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

    try {
      // encrypt
      // console.log("pubkey", chatUser.public_key)
      // const message = inputValue.trim();
      // const pubKeyBuffer = base64ToArrayBuffer(chatUser.public_key);
      // console.log("pubKeyBuffer", pubKeyBuffer);
      // const privateKey = localStorage.getItem('privateKey')
      // console.log("privateKey", privateKey);
      // const privateKeyBuffer = base64ToArrayBuffer(privateKey);
      // const signatureBytes = await signMessage(privateKeyBuffer, message);

      // const encoder = new TextEncoder();
      // console.log("signatureBytes", signatureBytes);
      // const payload = JSON.stringify({
      //   message,
      //   signature: btoa(String.fromCharCode(...signatureBytes))
      // });
      // console.log("payload", payload);

      // const encrypted = await encryptMessage(pubKeyBuffer, encoder.encode(payload));
      // console.log("encrypted", encrypted);

      await sendMessageToUser(chatUser.id, message);
      
      setInputValue('');
      setErrorMessages(null);
      await fetchMessages();
    } catch (error) {
      console.error("Error sending message:", error);
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
            <VirtuosoMessageList
              key={id}
              messages={messages}
              user={user}
              hasMore={hasMore}
              loadMoreMessages={loadMoreMessages}
              firstItemIndex={firstItemIndex}
              initialTopMostItemIndex={firstItemIndex + messages.length - 1}
            />
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
                  if (e.key === 'Enter' && !e.shiftKey) {
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
