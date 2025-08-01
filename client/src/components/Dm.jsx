import React, { useEffect, useRef, useState, useContext, useLayoutEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DmSidebar from './DmSidebar';
import '../assets/css/dms.css';
import { onNewDm } from '../utils/ws-client';
import { LayoutContext } from './Layout';
import { fetchUsersList, fetchMessagesForUser, sendMessageToUser, markMessagesRead, } from '../services/dmService';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';


export default function Dm({ user }) {
  const { unreadDms } = useContext(LayoutContext);

  const { id } = useParams();
  const navigate = useNavigate();

  const [users, setUsers] = useState([]);
  const [errorUsers, setErrorUsers] = useState(null);

  const [messages, setMessages] = useState([]);
  const [errorMessages, setErrorMessages] = useState(null);

  const [inputValue, setInputValue] = useState('');
  const [userHasScrolledUp, setUserHasScrolledUp] = useState(false);

  const messageListRef = useRef(null);
  const messagesEndRef = useRef(null);

  const inputRef = useRef(null);

  const scrollToBottom = (behavior = 'auto') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  };

  const isScrolledToBottom = () => {
    const el = messageListRef.current;
    if (!el) return false;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    return Math.abs(distance) <= 1;
  };

  // Update scroll state on scroll
  useEffect(() => {
    const el = messageListRef.current;
    if (!el) return;

    const handleScroll = () => {
      const atBottom = isScrolledToBottom();
      setUserHasScrolledUp(!atBottom);
    };

    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    if (!unreadDms) return;

    const frame = requestAnimationFrame(() => {
      unreadDms.forEach(dm => {
        const dot = document.querySelector(`#user-dot-${dm.from_user_id}`);
        console.log(`.user-dot-${dm.from_user_id}`, dot);
        if (dot && dm.from_user_id != chatUser.id) {
          dot.classList.add("active");
        }
      });
    });

    return () => cancelAnimationFrame(frame);
  }, [unreadDms]);


  const initialLoad = useRef(true);
  useLayoutEffect(() => {
    if (initialLoad.current) {
      scrollToBottom("auto");
      initialLoad.current = false;
    } else if (!userHasScrolledUp) { // userHasScrolledUp is broken at the moment
      scrollToBottom();
    }
  }, [messages]);

  useEffect(() => {
    async function fetchUsers() {
      try {
        const data = await fetchUsersList();
        setUsers(data);
        if (!id && data.length > 0) {
          navigate(`/dm/${data[0].id}`, { replace: true });
        }
        setErrorUsers(null);
      } catch (e) {
        setErrorUsers(e.message);
      }
    }
    fetchUsers();
  }, [navigate, id]);

  useEffect(() => {
    if (!id) return;

    async function fetchMessages() {
      try {
        const data = await fetchMessagesForUser(id);
        setMessages(data);
        setErrorMessages(null);
      } catch (e) {
        setErrorMessages(e.message);
      }
    }

    fetchMessages();
  }, [id]);

  const chatUser = users.find(u => u.id.toString() === id);
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
      const isOutgoingFromSelf = fromId === currentUserId;

      // scroll if you just got a message from the selected chat's user, or if you sent a message
      if (isIncomingFromCurrentChatUser || isOutgoingFromSelf) {
        const shouldScroll = isScrolledToBottom();

        setMessages(prev => [...prev, message]);

        if (shouldScroll) {
          requestAnimationFrame(() => scrollToBottom());
        }

        markRead();
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
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, [inputValue]);

  const { fetchUnreadMessages } = useContext(LayoutContext);

  const markRead = async () => {
    try {
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
      await sendMessageToUser(chatUser.id, inputValue.trim());
      setInputValue('');

      const updatedMessages = await fetchMessagesForUser(chatUser.id);
      setMessages(updatedMessages);
      setErrorMessages(null);

      setTimeout(() => scrollToBottom(), 0);
    } catch (error) {
      setErrorMessages(error.message);
    }
  };


  return (
    <div className="dm-container">
      <DmSidebar users={users} />
      <div
        id="dm-main"
        data-current-user-id={user?.id}
        data-other-user-id={chatUser?.id}
      >
        {errorUsers && <p className="error-text">Error loading users: {errorUsers}</p>}
        {users.length === 0 && !errorUsers && <p>No recent conversations found.</p>}

        {id && (
          <>
            <h4 className="chat-recipient-header">{chatUser?.username || 'User'}</h4>

            <ul id="dm-messages" className="list-group" ref={messageListRef}>
              {errorMessages && <li className="error-text">Error loading messages: {errorMessages}</li>}
              {!errorMessages && messages.length === 0 && (
                <li className="no-messages">No messages yet.</li>
              )}
              {messages.map(msg => (
                <li
                  key={msg.id}
                  className={`dm-message ${msg.sender_id === user.id ? 'sent' : 'received'}`}
                >
                  <strong>{msg.sender_username}</strong>{' '}
                  <small>{new Date(msg.timestamp * 1000).toLocaleString()}</small>
                  <br />
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                    {msg.content}
                  </ReactMarkdown>
                </li>
              ))}

              <div ref={messagesEndRef} />
            </ul>
            <div className="dm-chat-wrapper">
              <form
                id="dm-chat-form"
                className="d-flex flex-grow-1"
                onSubmit={e => {
                  e.preventDefault();
                  handleSendMessage(e);
                }}
              >
                <textarea
                  id="dm-input"
                  className="form-control auto-resize-textarea"
                  placeholder="Type a message..."
                  value={inputValue}
                  onChange={e => setInputValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && !e.shiftKey) {
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
    </div>
  );
}
