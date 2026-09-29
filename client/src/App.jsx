import React, { useEffect, useState } from 'react';
import { HashRouter, BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { ConfigContext, InteractionContext } from './contexts';
import { scrollToRight } from './utils/scrollToRight';

import Login from './components/Login.jsx';
import Layout from './components/Layout.jsx';
import Settings from './components/Settings.jsx';
import Dm from './components/Dm.jsx';
import GuildView from './components/guild/GuildView.jsx';
import InvitePage from './components/guild/InvitePage.jsx';
import api from './utils/api';
import './assets/css/mobile.css';
import './assets/css/desktop.css';

import { closeWebSocket } from './utils/ws-client';
import { clearUserKeys } from './services/keyStore';
import EmojiProvider from './emoji/EmojiProvider';
import UpdateBanner from './components/UpdateBanner';
import ImageViewerProvider from './components/ImageViewerProvider';
import { disableNotificationsOnThisDevice } from './services/pushService';



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

  // Mobile: open on the content pane rather than the sidebar.
  useEffect(scrollToRight, []);

  return null;
}

export default function App() {
  const { user, setUser, loading } = useAuth();
  const [config, setConfig] = useState({ s3Endpoint: '' });

  const [interactionMode, setInteractionMode] = useState("auto");
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    // Fetch server config once at app start
    async function fetchConfig() {
      try {
        const res = await api.get('/config');
        // Everything the server exposes (s3Endpoint, maxPlaintextLength, vapidPublicKey, ...).
        setConfig(res.data);
      } catch (err) {
        console.error('Failed to fetch config', err);
      }
    }

    const saved = localStorage.getItem("interactionMode");
    if (saved) {
      setInteractionMode(saved);
    }

    console.log("fetch config")
    fetchConfig();
  }, []);

  useEffect(() => {
    localStorage.setItem("interactionMode", interactionMode);

    let resolvedMode = interactionMode;
    let resolvedIsMobile = false;

    if (interactionMode === "auto") {
      resolvedIsMobile =
        navigator.userAgentData?.mobile ??
        /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      resolvedMode = resolvedIsMobile ? "mobile" : "desktop";
    } else {
      resolvedIsMobile = interactionMode === "mobile";
    }

    setIsMobile(resolvedIsMobile);

    document.body.classList.toggle("mobile-mode", resolvedMode === "mobile");
    document.body.classList.toggle("desktop-mode", resolvedMode === "desktop");
  }, [interactionMode]);



  if (loading) return <div></div>;

  const isElectron = () => {
    return typeof window !== 'undefined' && window.navigator.userAgent.toLowerCase().includes('electron');
  };

  async function handleLogout() {
    // Before the token goes: the server must forget this device, or it would keep
    // receiving this account's notifications after logout.
    try {
      await disableNotificationsOnThisDevice();
    } catch (err) {
      console.error('Failed to turn off notifications on logout', err);
    }
    try {
      localStorage.removeItem('token');
      await clearUserKeys();
    } catch (err) {
      console.error('Failed to clear stored keys on logout', err);
    }
    closeWebSocket();
    setUser(null);
  }

  const Router = isElectron() ? HashRouter : BrowserRouter;

  return (
    <ConfigContext.Provider value={config}>
      <EmojiProvider>
      <InteractionContext.Provider value={{ interactionMode, setInteractionMode, isMobile }}>
        <ImageViewerProvider>
        <Router>
          <SWMessageHandler />
          <UpdateBanner />
          <Routes>
            <Route
              path="/"
              // TODO at some point, change this to the previously viewed page?
              element={user ? <Navigate to="/dm" replace /> : <Login onLoginSuccess={setUser} />}
            />

            {user && (
              <Route element={<Layout user={user} />}>
                <Route path="/settings" element={<Settings onLogout={handleLogout} />} />
                <Route path="/dm/:id?" element={<Dm user={user} />} />
                <Route path="/guild/:guildId/:channelId?" element={<GuildView user={user} />} />
                <Route path="/invite/:code" element={<InvitePage />} />
              </Route>
            )}

            {/* Logged out, an invite link asks you to log in first, then shows the invite. */}
            {!user && <Route path="/invite/:code" element={<Login onLoginSuccess={setUser} />} />}

            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </Router>
        </ImageViewerProvider>
      </InteractionContext.Provider>
      </EmojiProvider>
    </ConfigContext.Provider>
  );
}
