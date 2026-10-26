import api from './api';
import { liftSuspension, suspendUser } from '../services/reportService';

// For global admins: who's an admin and who's suspended (GET /admin/users), so a person's
// right-click menu (utils/personMenu.js) can offer Suspend or Lift Suspension, Make or Remove
// Admin. Loaded by hooks/useAdminAlertsSync.js once the server says you're an admin, again on
// every `admin_alerts` event (suspending and changing admins send one) and after your own
// changes here; null for everyone else, and emptied on logging out.

let state = null; // { admins: Set of ids, suspended: Set of ids }

export function applyAdminUsers(lists) {
  state = lists
    ? { admins: new Set((lists.admins ?? []).map(Number)), suspended: new Set((lists.suspended ?? []).map(Number)) }
    : null;
}

export async function loadAdminUsers() {
  applyAdminUsers((await api.get('/admin/users')).data);
}

// Read once, while a menu is being built.
export const getAdminUsers = () => state;

const thenReload = (request) => request.then(() => loadAdminUsers().catch(() => {}));

export const suspendAccount = (userId, reason) => thenReload(suspendUser(userId, reason));
export const liftAccountSuspension = (userId) => thenReload(liftSuspension(userId));
export const makeAdmin = (userId) => thenReload(api.post('/admin/admins', { userId: Number(userId) }));
export const removeAdmin = (userId) => thenReload(api.delete(`/admin/admins/${userId}`));
