import { useEffect } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import Sidebar from './Sidebar';
import { Outlet } from 'react-router-dom';
import { connectWebSocket, onNewDm } from '../utils/ws-client';

export default function Layout({ user, onLogout }) {
  const location = useLocation();

  useEffect(() => {
    if (user?.id) {
      connectWebSocket(user.id);

      const unsubscribe = onNewDm((message) => {
        console.log("[message]", message)
        const dmMatch = location.pathname.match(/^\/dm\/(\d+)/);
        const currentDmId = dmMatch ? dmMatch[1] : null;

        // Skip notification if user is already on sender's DM page
        if (currentDmId && currentDmId === message.sender_id.toString()) {
          return;
        }

        if (Notification.permission === 'granted') {
          const notif = new Notification(`${message.sender_name || 'User'}`, {
            body: message.content,
            icon: '/logo.svg', // change to profile picture later
          });
          
          notif.onclick = () => {
            window.focus(); // bring tab to front
            window.location.href = `/dm/${message.sender_id}`;
          };
        }
      });

      return () => unsubscribe();
    }
  }, [user?.id, location]);

  return (
    <div className="d-flex">
      <Sidebar user={user} onLogout={onLogout} />
      <div style={{ flex: 1 }}>
        <Outlet />
      </div>
    </div>
  );
}
