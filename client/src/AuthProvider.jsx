import React, { useState, useEffect } from 'react';
import api from './utils/api';
import { AuthContext } from './hooks/useAuth';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchProfile() {
      try {
        const res = await api.get('/profile');

        if (res.data && res.data.id) {
          setUser({
            id: res.data.id,
            username: res.data.username,
            token: res.data.token,
            hasRecoveryCode: res.data.hasRecoveryCode,
          });
        } else {
          setUser(null);
        }
      } catch {
        setUser(null);
      } finally {
        setLoading(false);
      }
    }

    fetchProfile();
  }, []);


  return (
    <AuthContext.Provider value={{ user, setUser, loading }}>
      {children}
    </AuthContext.Provider>
  );
}
