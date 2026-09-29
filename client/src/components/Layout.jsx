import { useEffect, useState, useContext } from 'react';
import { useLocation, Outlet, useNavigate } from 'react-router-dom';
import Sidebar from './Sidebar';
import DmSidebar from './DmSidebar';
import SidebarWrapper from './SidebarWrapper';
import UserPanel from './UserPanel';
import { connectWebSocket, onNewDm } from '../utils/ws-client';
import api from '../utils/api';
import { fetchUsersList } from '../services/dmService';
import 'highlight.js/styles/atom-one-dark.css';
import { ConfigContext, LayoutContext } from '../contexts';
import { ensureSubscription, getPushStatus } from '../services/pushService';

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
      setHasUnreadDms(data.length > 0);
      setUnreadDms(data);
    } catch (e) {
      console.log(e.message);
    }
  }

  const { vapidPublicKey } = useContext(ConfigContext);

  // Push subscriptions can change or expire, and permission may have been granted since
  // the last visit, so re-sync this device's subscription with the server on every start.
  // (Asking for permission needs a tap, so that's left to NotificationPrompt/Settings.)
  useEffect(() => {
    if (!user?.id || !vapidPublicKey || getPushStatus() !== 'granted') return;
    ensureSubscription(vapidPublicKey).catch((err) =>
      console.warn('Could not refresh push subscription:', err)
    );
  }, [user?.id, vapidPublicKey]);

  useEffect(() => {
    fetchUnreadMessages();
  }, []);


  useEffect(() => {
    if (user?.id) {
      connectWebSocket(user.id);

      // Notifications come from web push (service-worker.js); here just refresh the badge.
      const unsubscribe = onNewDm(() => {
        fetchUnreadMessages();
      });

      return () => unsubscribe();
    }
  }, [user?.id]);

  return (
    <LayoutContext.Provider value={{ fetchUnreadMessages, hasUnreadDms, unreadDms, users, errorUsers }}>
      <div className={`${isDmPage ? 'slidey' : ''} main-wrapper d-flex`}>
        {/* The user panel sits under the conversation list (not on e.g. Settings). */}
        <SidebarWrapper footer={isDmPage ? <UserPanel user={user} /> : null}>
          {/* Main sidebar always shows */}
          <Sidebar user={user} onLogout={onLogout} hasUnreadDms={hasUnreadDms} />

          {/* DM sidebar only shows on the /dm route */}
          {isDmPage && <DmSidebar users={users} unreadDms={unreadDms} />}
        </SidebarWrapper>

        {/* The main page content */}
        <div className='main-content-wrapper'>
          <Outlet />
        </div>
      </div>
    </LayoutContext.Provider>
  );
}