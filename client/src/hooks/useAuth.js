import { createContext, useContext } from 'react';

// The logged-in user ({ id, username, token } or null), provided by AuthProvider.
export const AuthContext = createContext();

export function useAuth() {
  return useContext(AuthContext);
}
