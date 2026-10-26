import { useEffect, useSyncExternalStore } from 'react';
import api from '../utils/api';
import { onAdminAlerts, onConnectionState } from '../utils/ws-client';
import { applyAdminAlerts, getAdminAlerts, subscribeAdminAlerts } from '../utils/adminAlerts';
import { applyAdminUsers, loadAdminUsers } from '../utils/adminUsers';

// Keeps utils/adminAlerts up to date for the logged-in user (Layout): loaded at login (a 403
// means not an admin: nothing to show) and, for admins, again after a reconnect; changed by the
// `admin_alerts` event (which also reaches someone made an admin meanwhile). Emptied on logging out.
// Admins' utils/adminUsers (for people's menus) is loaded and reloaded alongside.
export function useAdminAlertsSync(userId) {
  useEffect(() => {
    if (!userId) return undefined;
    let admin = false;
    let live = true;
    const loadUsers = () => loadAdminUsers().catch(() => applyAdminUsers(null));
    const load = () => api.get('/admin/alerts').then(
      (res) => {
        if (!live) return;
        admin = true;
        applyAdminAlerts(res.data);
        loadUsers();
      },
      () => { if (live) applyAdminAlerts(null); }
    );
    load();
    let wasOnline = true;
    const stopState = onConnectionState((state) => {
      if (state === 'online' && !wasOnline && admin) load();
      wasOnline = state === 'online';
    });
    const stopEvents = onAdminAlerts((next) => {
      admin = true;
      applyAdminAlerts(next);
      loadUsers();
    });
    return () => {
      live = false;
      stopState();
      stopEvents();
      applyAdminAlerts(null);
      applyAdminUsers(null);
    };
  }, [userId]);
}

// { reports, signups, testers }.
export function useAdminAlerts() {
  return useSyncExternalStore(subscribeAdminAlerts, getAdminAlerts);
}
