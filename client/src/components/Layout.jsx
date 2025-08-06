import { useEffect, useState, createContext } from 'react';
import { useLocation, Outlet, useNavigate } from 'react-router-dom';
import Sidebar from './Sidebar';
import DmSidebar from './DmSidebar';
import SidebarWrapper from './SidebarWrapper';
import { connectWebSocket, onNewDm } from '../utils/ws-client';
import api from '../utils/api';
import { fetchUsersList } from '../services/dmService';
import notificationSound from '../assets/sounds/notification.mp3';
import logoIcon from '../assets/images/logo.svg';
import 'highlight.js/styles/atom-one-dark.css';

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
  const location = useLocation();
  const navigate = useNavigate();
  const [hasUnreadDms, setHasUnreadDms] = useState(false);
  const [unreadDms, setUnreadDms] = useState([]);
  
  const [users, setUsers] = useState([]);
  const [errorUsers, setErrorUsers] = useState(null);
  
  // Check if we are on the DM page
  const isDmPage = location.pathname.startsWith('/dm');

  useEffect(() => {
    // Only fetch users if we are on the DM page to avoid unnecessary API calls
    if (isDmPage) {
      async function fetchUsers() {
        try {
          const data = await fetchUsersList();
          setUsers(data);
          setErrorUsers(null);
          // If user lands on /dm without an ID, redirect to the first user
          if (location.pathname === '/dm' && data.length > 0) {
            navigate(`/dm/${data[0].id}`, { replace: true });
          }
        } catch (e) {
          setErrorUsers(e.message);
        }
      }
      fetchUsers();
    }
  }, [isDmPage, navigate, location.pathname]);


  async function fetchUnreadMessages() {
    try {
      const res = await api.get('/dm-get-unread');
      const data = res.data;
      console.log("data", data);
      setHasUnreadDms(data.length > 0);
      setUnreadDms(data);
    } catch (e) {
      console.log(e.message);
    }
  }

  useEffect(() => {
    if (user?.id) {
      requestNotificationPermission();
    }
  }, [user?.id]);

  useEffect(() => {
    fetchUnreadMessages();
  }, []);

  useEffect(() => {
    if (user?.id) {
      connectWebSocket(user.id);

      const unsubscribe = onNewDm((message) => {
        fetchUnreadMessages();

        const dmMatch = location.pathname.match(/^\/dm\/(\d+)/);
        const currentDmId = dmMatch ? dmMatch[1] : null;

        if (currentDmId && currentDmId === message.sender_id.toString() && document.hasFocus()) return;

        if (Notification.permission === 'granted') {
          const audio = new Audio(notificationSound);
          audio.play().catch(err => {
            console.warn('Autoplay failed:', err);
          });
          const notif = new Notification(`${message.sender_name || 'User'}`, {
            body: message.content,
            icon: logoIcon,
            silent: true
          });
          notif.onclick = async () => {
            try {
              window.focus();
              await api.post(`/dm-mark-read/${message.sender_id}`);
              navigate(`/dm/${message.sender_id}`);
            } catch (err) {
              console.error("Failed to mark DM as read:", err);
              navigate(`/dm/${message.sender_id}`);
            }
          };
        }
      });

      return () => unsubscribe();
    }
  }, [user?.id, location]);

  return (
    <LayoutContext.Provider value={{ fetchUnreadMessages, hasUnreadDms, unreadDms, users, errorUsers }}>
      <div className="main-wrapper d-flex">
        <SidebarWrapper>
          {/* Main sidebar always shows */}
          <Sidebar user={user} onLogout={onLogout} hasUnreadDms={hasUnreadDms} />

          {/* DM sidebar only shows on the /dm route */}
          {isDmPage && <DmSidebar users={users} />}
        </SidebarWrapper>

        {/* The main page content */}
        <div className='main-content-wrapper'>
          <Outlet />
        </div>
      </div>
    </LayoutContext.Provider>
  );
}