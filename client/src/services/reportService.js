import api from '../utils/api';

// Reporting (server/routes/reports.js) and the admins' side of it (Settings → Admin → Reports).

export const REPORT_CATEGORIES = ['spam', 'harassment', 'hate', 'sexual', 'child_safety', 'violence', 'self_harm', 'illegal', 'other'];

// A message: { kind: 'message', place: 'guild' | 'dm' | 'group', messageId, groupId?, sharedText? };
// a person: { kind: 'user', userId }; both with { category, note? }.
export async function sendReport(report) {
  return (await api.post('/reports', report)).data;
}

export async function fetchReports() {
  return (await api.get('/admin/reports')).data;
}

export async function dismissReport(id) {
  await api.post(`/admin/reports/${id}/dismiss`);
}

export async function deleteReportedMessage(id) {
  await api.post(`/admin/reports/${id}/delete-message`);
}

export async function suspendUser(userId, reason, reportId = null) {
  await api.post(`/admin/users/${userId}/suspend`, { reason, ...(reportId ? { reportId } : {}) });
}

export async function liftSuspension(userId) {
  await api.delete(`/admin/users/${userId}/suspension`);
}
