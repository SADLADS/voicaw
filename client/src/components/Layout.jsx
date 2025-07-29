import { useEffect, useState, createContext } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import Sidebar from './Sidebar';
import { Outlet } from 'react-router-dom';
import { connectWebSocket, onNewDm } from '../utils/ws-client';

export const LayoutContext = createContext();

// ask the user for consent to show notifications
export function requestNotificationPermission() {
  Notification.requestPermission().then(permission => {
    if (permission === 'granted') {
      console.log('Notifications enabled');
    }
  });
}

export default function Layout({ user, onLogout }) {
  const [hasUnreadDms, setHasUnreadDms] = useState(false);

  async function fetchUnreadMessages() {
    try {
      const res = await fetch(`/api/dm-get-unread/`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch messages');
      const data = await res.json();
      console.log(data);
      setHasUnreadDms(data.length > 0);
    } catch (e) {
      console.log(e.message);
    }
  }

  useEffect(() => {
    if (user?.id) {
      requestNotificationPermission();
      fetchUnreadMessages();
    }
  }, [user?.id]);

  useEffect(() => {
    if (user?.id) {
      connectWebSocket(user.id);

      const unsubscribe = onNewDm((message) => {
        fetchUnreadMessages();

        const dmMatch = location.pathname.match(/^\/dm\/(\d+)/);
        const currentDmId = dmMatch ? dmMatch[1] : null;

        if (currentDmId && currentDmId === message.sender_id.toString()) return;

        if (Notification.permission === 'granted') {
          const notif = new Notification(`${message.sender_name || 'User'}`, {
            body: message.content,
            icon: '/logo.svg',
          });

          notif.onclick = () => {
            window.focus();
            window.location.href = `/dm/${message.sender_id}`;
          };
        }
      });

      return () => unsubscribe();
    }
  }, [user?.id, location]);

  return (
    <LayoutContext.Provider value={{ fetchUnreadMessages }}>
      <div className="d-flex">
        <Sidebar user={user} onLogout={onLogout} hasUnreadDms={hasUnreadDms} />
        <div style={{ flex: 1 }}>
          <Outlet />
        </div>
      </div>
    </LayoutContext.Provider>
  );
}