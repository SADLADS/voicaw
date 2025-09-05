import React, { createContext, useState, useEffect, useContext } from 'react';
import api from './utils/api';

const AuthContext = createContext();

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
            private_key: res.data.private_key,
            vapidPubKey: res.data.vapidPubKey
          });
        } else {
          setUser(null);
        }
      } catch (err) {
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

export function useAuth() {
  return useContext(AuthContext);
}
