import React, { useEffect, createContext, useState } from 'react';
import { HashRouter, BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthProvider.jsx';

import Login from './components/Login.jsx';
import Layout from './components/Layout.jsx';
import CreateGuild from './components/CreateGuild.jsx';
import Calendar from './components/Calendar.jsx';
import Settings from './components/Settings.jsx';
import Dm from './components/Dm.jsx';
import api from './utils/api';

import { closeWebSocket } from './utils/ws-client';

export const ConfigContext = createContext({ s3Endpoint: '' });

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
  const [config, setConfig] = useState({ s3Endpoint: '' });

  useEffect(() => {
    console.log("fetch config")
    // Fetch server config once at app start
    async function fetchConfig() {
      try {
        const res = await api.get('/config');
        setConfig({ s3Endpoint: res.data.s3Endpoint });
      } catch (err) {
        console.error('Failed to fetch config', err);
      }
    }
    fetchConfig();
  }, []);

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
    <ConfigContext.Provider value={config}>
      <Router>
        <SWMessageHandler />
        <Routes>
          <Route
            path="/"
            // TODO at some point, change this to the previously viewed page?
            element={user ? <Navigate to="/dm" replace /> : <Login onLoginSuccess={setUser} />}
          />

          {user && (
            <Route element={<Layout user={user}  />}>
              <Route path="/createguild" element={<CreateGuild user={user} />} />
              <Route path="/calendar" element={<Calendar user={user} />} />
              <Route path="/settings" element={<Settings user={user} onLogout={handleLogout} />} />
              <Route path="/dm/:id?" element={<Dm user={user} />} />
            </Route>
          )}

          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </Router>
    </ConfigContext.Provider>
  );
}
