import React, { useState, useEffect } from 'react';
import api from './utils/api';
import { AuthContext } from './hooks/useAuth';

// How long to wait before asking again when the server can't be reached.
const RETRY_MS = 3000;

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
        const res = await api.get('/profile');
        if (cancelled) return;

        if (res.data && res.data.id) {
          setUser({
            id: res.data.id,
            username: res.data.username,
            token: res.data.token,
            hasRecoveryCode: res.data.hasRecoveryCode,
            // Waiting for an admin's approval: the app shows only that (PendingApproval).
            pending: Boolean(res.data.pending),
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
