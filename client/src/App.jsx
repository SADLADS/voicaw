import React, { useEffect } from 'react';
import { HashRouter, BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthProvider.jsx';

import Login from './components/Login.jsx';
import Layout from './components/Layout.jsx';
import Plaza from './components/Plaza.jsx';
import Calendar from './components/Calendar.jsx';
import Settings from './components/Settings.jsx';
import Dm from './components/Dm.jsx';

import { closeWebSocket } from './utils/ws-client';

// Handles service worker messages (like "navigate")
function SWMessageHandler() {
  const navigate = useNavigate();

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      const handler = (event) => {
        if (event.data?.action === 'navigate' && event.data.url) {
          if (window.location.hash) {
            navigate(`#${event.data.url}`);
          } else {
            navigate(event.data.url);
          }
        }
      };

      navigator.serviceWorker.addEventListener('message', handler);
      return () => navigator.serviceWorker.removeEventListener('message', handler);
    }
  }, [navigate]);

  useEffect(() => {
    const wrapper = document.querySelector('.main-wrapper');
    if (wrapper) {
      requestAnimationFrame(() => {
        wrapper.scrollBy({ left: window.innerWidth, behavior: 'smooth' });
      });
    }
  }, [location]);

  return null;
}

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
      closeWebSocket();
      setUser(null);
    } catch (err) {
      console.error('Logout failed', err);
    }
  }

  const Router = isElectron() ? HashRouter : BrowserRouter;

  return (
    <Router>
      <SWMessageHandler />
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
