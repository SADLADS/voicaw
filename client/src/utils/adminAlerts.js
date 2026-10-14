// What's waiting for a global admin (server/adminAlerts.js): open reports, accounts waiting for
// approval and Android tester requests not yet added. Shown as a count on the Settings gear
// (UserPanel) and on Settings' Admin and Reports pages until they're dealt with. Kept by
// hooks/useAdminAlerts.js (in Layout); all zero for everyone else.

const NONE = { reports: 0, signups: 0, testers: 0 };
let alerts = NONE;
const listeners = new Set();

export function applyAdminAlerts(next) {
  alerts = next ? { reports: next.reports || 0, signups: next.signups || 0, testers: next.testers || 0 } : NONE;
  listeners.forEach((listener) => listener());
}

export const getAdminAlerts = () => alerts;

export const adminAlertsTotal = (a) => a.reports + a.signups + a.testers;

export function subscribeAdminAlerts(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
