import React, { useState, useEffect } from 'react';
import api from './utils/api';
import { AuthContext } from './hooks/useAuth';
import { setOfflineMode, setReachable } from './utils/offlineMode';
import { forgetLogin } from './services/logout';

// How long to wait before asking again when the server can't be reached.
const RETRY_MS = 3000;
// How long the profile may take: a server that takes connections but never answers (stuck,
// restarting) counts as unreachable, rather than leaving a blank page.
const PROFILE_TIMEOUT_MS = 10000;
// In offline mode, how often to look for the server again.
const OFFLINE_RETRY_MS = 5000;

// Only the server saying the login is no good ends the session. Anything else (no network
// yet after the computer starts, the API restarting) is retried, so a saved login isn't
// thrown away while the server is out of reach.
function isRejected(err) {
  const status = err?.response?.status;
  return status === 401 || status === 403 || status === 404;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // Still loading because the server didn't answer (App says so while it retries).
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let retryTimer;

    async function fetchProfile() {
      if (!localStorage.getItem('token')) {
        setLoading(false);
        return;
      }
      try {
        // Without the server, the offline copy's (services/offlineCopy.js): the app opens in
        // offline mode, showing what this device saved, read-only.
        const res = await api.get('/profile', { timeout: PROFILE_TIMEOUT_MS, offlineCopy: 'fallback' });
        if (cancelled) return;
        if (res.fromOfflineCopy) {
          setOfflineMode(true);
          retryTimer = setTimeout(lookForServer, OFFLINE_RETRY_MS);
        }

        if (res.data && res.data.id) {
          setUser({
            id: res.data.id,
            username: res.data.username,
            token: res.data.token,
            hasRecoveryCode: res.data.hasRecoveryCode,
            // Waiting for an admin's approval: the app shows only that (PendingApproval).
            pending: Boolean(res.data.pending),
            // false: the terms of use must be accepted first (TermsGate). An older server
            // doesn't say, which counts as accepted.
            termsAccepted: res.data.termsAccepted !== false,
          });
        } else {
          setUser(null);
        }
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        if (isRejected(err)) {
          setUser(null);
          setLoading(false);
        } else {
          setUnreachable(true);
          retryTimer = setTimeout(fetchProfile, RETRY_MS);
        }
      }
    }

    // Offline mode: once the server answers, OfflineBanner offers to reconnect. If it says the
    // login is no good any more (logged out elsewhere meanwhile), this device forgets it.
    async function lookForServer() {
      try {
        await api.get('/profile', { timeout: PROFILE_TIMEOUT_MS, offlineCopy: 'never' });
        if (!cancelled) setReachable();
      } catch (err) {
        if (cancelled) return;
        if (isRejected(err)) {
          await forgetLogin();
          window.location.reload();
          return;
        }
        retryTimer = setTimeout(lookForServer, OFFLINE_RETRY_MS);
      }
    }

    fetchProfile();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, []);

  return (
    <AuthContext.Provider value={{ user, setUser, loading, unreachable }}>
      {children}
    </AuthContext.Provider>
  );
}
