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

  const handleSendMessage = e => {
    e.preventDefault();
    if (!inputValue.trim()) return;
    // Sending message to backend not implemented yet
    setInputValue('');
  };

  return (
    <div className="dm-container" style={{ display: 'flex', height: '100vh' }}>
      <DmSidebar users={users} />
      <div
        id="dm-main"
        data-current-user-id={user?.id}
        data-other-user-id={chatUser?.id}
        style={{ flex: 1, padding: '1rem', display: 'flex', flexDirection: 'column', height: '100vh' }}
      >
        {errorUsers && <p style={{ color: 'red' }}>Error loading users: {errorUsers}</p>}
        {users.length === 0 && !errorUsers && <p>No recent conversations found.</p>}

        {id ? (
          <>
            <h4>Chat with {chatUser?.username || 'User'}</h4>

            <ul
              id="dm-messages"
              className="list-group flex-grow-1"
              style={{ overflowY: 'auto', flexGrow: 1, marginBottom: '1rem', padding: 0, listStyle: 'none' }}
            >
              {errorMessages && <li style={{ color: 'red' }}>Error loading messages: {errorMessages}</li>}
              {!errorMessages && messages.length === 0 && (
                <li
                  style={{
                    color: '#ccc',
                    fontStyle: 'italic',
                    marginTop: 'auto',
                    marginBottom: 'auto',
                  }}
                >
                  No messages yet.
                </li>
              )}
              {messages.map(msg => (
                <li
                  key={msg.id}
                  className={`dm-message ${msg.sender_id === user.id ? 'sent' : 'received'}`}
                  style={{
                    backgroundColor: msg.sender_id === user.id ? '#005f73' : '#0a9396',
                    color: 'white',
                    padding: '0.5rem 1rem',
                    borderRadius: '10px',
                    marginBottom: '0.5rem',
                    alignSelf: msg.sender_id === user.id ? 'flex-end' : 'flex-start',
                    maxWidth: '70%',
                    wordBreak: 'break-word',
                  }}
                >
                  <strong>{msg.sender_id === user.id ? user.username : chatUser?.username}</strong>{' '}
                  <small style={{ fontSize: '0.75rem', opacity: 0.7 }}>
                    {new Date(msg.timestamp * 1000).toLocaleString()}
                  </small>
                  <br />
                  <span>{msg.content}</span>
                </li>
              ))}
            </ul>

            <form id="dm-chat-form" className="d-flex" onSubmit={handleSendMessage}>
              <input
                id="dm-input"
                type="text"
                className="form-control me-2"
                placeholder="Type a message..."
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                autoComplete="off"
                style={{ flexGrow: 1 }}
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
