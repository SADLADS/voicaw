import React, { useEffect } from 'react';
import { HashRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth, AuthProvider } from './AuthProvider.jsx';

import Login from './components/Login.jsx';
import Layout from './components/Layout.jsx';
import Plaza from './components/Plaza.jsx';
import Calendar from './components/Calendar.jsx';
import Settings from './components/Settings.jsx';
import Dm from './components/Dm.jsx';

import api from './utils/api.js';
import { connectWebSocket, onNewDm } from './utils/ws-client.js';

export default function App() {
  const { user, setUser, loading } = useAuth();

  if (loading) return <div></div>;

  async function handleLogout() {
    try {
      localStorage.removeItem('token');
      setUser(null);
    } catch (err) {
      console.error('Logout failed', err);
    }
  }

  return (
    <Router>
      <Routes>
        <Route
          path="/"
          element={user ? <Navigate to="/plaza" replace /> : <Login onLoginSuccess={setUser} />}
        />

        {user && (
          <Route element={<Layout user={user} onLogout={handleLogout} />}>
            <Route path="/plaza" element={<Plaza user={user} />} />
            <Route path="/calendar" element={<Calendar user={user} />} />
            <Route path="/settings" element={<Settings user={user} />} />
            <Route path="/dm/:id?" element={<Dm user={user} />} />
          </Route>
        )}

        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Router>
  );
}
