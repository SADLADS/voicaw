import { useEffect } from 'react';
import Sidebar from './Sidebar';
import { Outlet } from 'react-router-dom';
import { connectWebSocket, onNewDm } from '../utils/ws-client';

export default function Layout({ user, onLogout }) {
  useEffect(() => {
    if (user?.id) {
      connectWebSocket(user.id);
      const unsubscribe = onNewDm((message) => {
        console.log('[WS] Global handler: new DM received', message);
      });
      return () => unsubscribe();
    }
  }, [user?.id]);

  return (
    <div className="d-flex">
      <Sidebar user={user} onLogout={onLogout} />
      <div style={{ flex: 1 }}>
        <Outlet />
      </div>
    </div>
  );
}