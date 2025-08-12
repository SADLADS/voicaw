import React from 'react';
import { HashRouter, BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './AuthProvider.jsx';

import Login from './components/Login.jsx';
import Layout from './components/Layout.jsx';
import Plaza from './components/Plaza.jsx';
import Calendar from './components/Calendar.jsx';
import Settings from './components/Settings.jsx';
import Dm from './components/Dm.jsx';

export default function App() {
  const { user, setUser, loading } = useAuth();

  if (loading) return <div></div>;

  const isElectron = () => {
    return typeof window !== 'undefined' && window.navigator.userAgent.toLowerCase().includes('electron');
  };


  async function handleLogout() {
    try {
      localStorage.removeItem('token');
      localStorage.removeItem('privateKey');
      setUser(null);
    } catch (err) {
      console.error('Logout failed', err);
    }
  }
  const Router = isElectron() ? HashRouter : BrowserRouter;

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
