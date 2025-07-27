import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DmSidebar from './DmSidebar';
import '../assets/css/dms.css';
export default function Dm({ user }) {
  const { id } = useParams();
  const navigate = useNavigate();

  // State for users list
  const [users, setUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [errorUsers, setErrorUsers] = useState(null);

  // State for chat messages (example)
  const [messages, setMessages] = useState([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [errorMessages, setErrorMessages] = useState(null);

  // Fetch users once on mount
  useEffect(() => {
    async function fetchUsers() {
      try {
        setLoadingUsers(true);
        const res = await fetch('/api/dms-list', { credentials: 'include' });
        if (!res.ok) throw new Error('Failed to fetch users');
        const data = await res.json();
        setUsers(data);
        if (!id && data.length > 0) {
          navigate(`/dm/${data[0].id}`, { replace: true });
        }
      } catch (e) {
        setErrorUsers(e.message);
      } finally {
        setLoadingUsers(false);
      }
    }
    fetchUsers();
  }, [navigate, id]);

  // Fetch messages when `id` changes
  useEffect(() => {
    if (!id) return;

    async function fetchMessages() {
      try {
        setLoadingMessages(true);
        const res = await fetch(`/api/dm-messages/${id}`, { credentials: 'include' });
        if (!res.ok) throw new Error('Failed to fetch messages');
        const data = await res.json();
        setMessages(data);
        setErrorMessages(null);
      } catch (e) {
        setErrorMessages(e.message);
        setMessages([]);
      } finally {
        setLoadingMessages(false);
      }
    }

    fetchMessages();
  }, [id]);

  // Show sidebar always, pass users (even if loading or error)
  return (
    <div className="dm-container" style={{ display: 'flex', height: '100vh' }}>
      <DmSidebar users={users} />
      <div id="dm-main" style={{ flex: 1, padding: '1rem' }}>
        {loadingUsers && <p>Loading users...</p>}
        {errorUsers && <p>Error loading users: {errorUsers}</p>}
        {!loadingUsers && users.length === 0 && <p>No recent conversations found.</p>}

        {id && (
          <>
            {loadingMessages && <p>Loading messages...</p>}
            {errorMessages && <p>Error loading messages: {errorMessages}</p>}
            {!loadingMessages && !errorMessages && messages.length === 0 && <p>No messages yet.</p>}

            {!loadingMessages && !errorMessages && messages.length > 0 && (
              <div>
                <h4>Chat with {users.find(u => u.id.toString() === id)?.username || 'User'}</h4>
                {/* Render messages */}
                <ul>
                  {messages.map(msg => (
                    <li key={msg.id}>
                      <strong>{msg.sender_username}</strong>: {msg.content}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        {!id && !loadingUsers && <p>Select a user to chat with.</p>}
      </div>
    </div>
  );
}
