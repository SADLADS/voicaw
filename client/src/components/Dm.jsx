import React, { useEffect, useRef, useState, useContext } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DmSidebar from './DmSidebar';
import '../assets/css/dms.css';
import { onNewDm } from '../utils/ws-client';
import { LayoutContext } from './Layout';
import { fetchUsersList, fetchMessagesForUser, sendMessageToUser, markMessagesRead, } from '../services/dmService';

export default function Dm({ user }) {
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

  const initialLoad = useRef(true);
  useEffect(() => {
    if (initialLoad.current) {
      scrollToBottom();         // Always scroll on first message load
      initialLoad.current = false;
      return;
    }

    if (!userHasScrolledUp) {
      scrollToBottom('smooth'); // Scroll only if user hasn't scrolled up
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
  }, [chatUser?.id]);

  useEffect(() => {
    if (!user?.id || !chatUser?.id) return;
    const unsubscribe = onNewDm((message) => {
      const fromId = message.sender_id.toString();
      const toId = message.recipient_id?.toString?.();
      const currentChatUserId = chatUser.id.toString();

      if (fromId === currentChatUserId || toId === currentChatUserId) {
        const shouldScroll = isScrolledToBottom();

        setMessages(prev => [...prev, message]);

        if (shouldScroll) {
          requestAnimationFrame(() => scrollToBottom('smooth'));
        }

        markRead();
      }
    });


    return () => unsubscribe();
  }, [chatUser?.id, user?.id]);


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

      setTimeout(() => scrollToBottom('smooth'), 0);
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
                  <strong>{msg.sender_id === user.id ? user.username : chatUser?.username}</strong>{' '}
                  <small>{new Date(msg.timestamp * 1000).toLocaleString()}</small>
                  <br />
                  <span>{msg.content}</span>
                </li>
              ))}
              <div ref={messagesEndRef} />
            </ul>

            <form id="dm-chat-form" className="d-flex" onSubmit={handleSendMessage}>
              <input
                id="dm-input"
                type="text"
                className="form-control"
                placeholder="Type a message..."
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                autoComplete="off"
              />
              <button className="btn btn-primary" type="submit">
                Send
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
