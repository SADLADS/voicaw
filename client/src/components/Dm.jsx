import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DmSidebar from './DmSidebar';
import '../assets/css/dms.css';

export default function Dm({ user }) {
  const { id } = useParams();
  const navigate = useNavigate();

  const [users, setUsers] = useState([]);
  const [errorUsers, setErrorUsers] = useState(null);

  const [messages, setMessages] = useState([]);
  const [errorMessages, setErrorMessages] = useState(null);

  const [inputValue, setInputValue] = useState('');

  useEffect(() => {
    async function fetchUsers() {
      try {
        const res = await fetch('/api/dms-list', { credentials: 'include' });
        if (!res.ok) throw new Error('Failed to fetch users');
        const data = await res.json();
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
        const res = await fetch(`/api/dm-messages/${id}`, { credentials: 'include' });
        if (!res.ok) throw new Error('Failed to fetch messages');
        const data = await res.json();
        setMessages(data);
        setErrorMessages(null);
      } catch (e) {
        setErrorMessages(e.message);
        // keep old messages intact on error
      }
    }

    fetchMessages();
  }, [id]);

  const chatUser = users.find(u => u.id.toString() === id);

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!inputValue.trim() || !chatUser) return;

    try {
      const res = await fetch('/api/dm-send', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient_id: chatUser.id,
          content: inputValue.trim(),
        }),
      });

      if (!res.ok) throw new Error('Failed to send message');

      setInputValue(''); // clear input after sending

      // Refresh messages from backend
      const updatedRes = await fetch(`/api/dm-messages/${chatUser.id}`, { credentials: 'include' });
      if (updatedRes.ok) {
        const data = await updatedRes.json();
        setMessages(data);
        setErrorMessages(null);
      }
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

        {id ? (
          <>
            <h4 className="chat-recipient-header">Chat with {chatUser?.username || 'User'}</h4>

            <ul id="dm-messages" className="list-group">
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
        ) : (
          <p>Select a user to chat with.</p>
        )}
      </div>
    </div>
  );
}
