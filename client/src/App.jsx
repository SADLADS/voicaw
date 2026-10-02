import React, { useEffect, useRef, useState } from 'react';
import { HashRouter, BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { ConfigContext, InteractionContext } from './contexts';
import { showContent } from './utils/mobilePanes';

import Login from './components/Login.jsx';
import Layout from './components/Layout.jsx';
import Settings from './components/Settings.jsx';
import Dm from './components/Dm.jsx';
import Notes from './components/Notes.jsx';
import GroupDm from './components/group/GroupDm.jsx';
import GuildView from './components/guild/GuildView.jsx';
import InvitePage from './components/guild/InvitePage.jsx';
import api from './utils/api';
import './assets/css/mobile.css';
import './assets/css/desktop.css';

import { closeWebSocket, onLoggedOutElsewhere } from './utils/ws-client';
import { leaveVoice } from './voice/voiceClient';
import { hangUp } from './voice/callClient';
import { clearUserKeys } from './services/keyStore';
import { forgetGroups } from './services/groupCache';
import EmojiProvider from './emoji/EmojiProvider';
import UpdateBanner from './components/UpdateBanner';
import ImageViewerProvider from './components/ImageViewerProvider';
import { MessageImageMenus } from './components/ImageMenu';
import { disableNotificationsOnThisDevice } from './services/pushService';
import { clearDrafts } from './services/draftStore';
import { setCustomEmojiBase } from './emoji/customEmoji';
import { setAvatarBase } from './utils/profiles';



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
          showContent();
        }
      };

      navigator.serviceWorker.addEventListener('message', handler);
      return () => navigator.serviceWorker.removeEventListener('message', handler);
    }
  }, [navigate]);

  return null;
}

// The phone or computer layout, from the device. It can't be chosen: the phone layout on a
// computer (or the other way round) isn't usable.
const isMobile = typeof navigator !== 'undefined' &&
  (navigator.userAgentData?.mobile ?? /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent));
const interaction = { isMobile };

export default function App() {
  const { user, setUser, loading, unreachable } = useAuth();
  const [config, setConfig] = useState({ s3Endpoint: '' });
  const logoutRef = useRef(null);

  // Logged out from another device (Settings → Devices), or the account was deleted there:
  // this one logs out too.
  useEffect(() => onLoggedOutElsewhere(() => logoutRef.current?.()), []);

  useEffect(() => {
    // Fetch server config once at app start
    async function fetchConfig() {
      try {
        const res = await api.get('/config');
        // Everything the server exposes (s3Endpoint, maxPlaintextLength, vapidPublicKey, ...).
        setConfig(res.data);
        setCustomEmojiBase(res.data.s3Endpoint);
        setAvatarBase(res.data.s3Endpoint);
      } catch (err) {
        console.error('Failed to fetch config', err);
      }
    }

    console.log("fetch config")
    fetchConfig();
  }, []);

  useEffect(() => {
    // Left over from when the layout could be picked in Settings.
    try { localStorage.removeItem("interactionMode"); } catch { /* storage blocked */ }
    document.body.classList.toggle("mobile-mode", isMobile);
    document.body.classList.toggle("desktop-mode", !isMobile);
  }, []);



  // The saved login is kept while the server can't be reached; AuthProvider keeps asking.
  if (loading) {
    return unreachable ? <div className="auth-unreachable">Can&apos;t reach Voicaw. Trying again…</div> : <div></div>;
  }

  async function handleLogout() {
    // Before the token goes: the server must forget this device, or it would keep
    // receiving this account's notifications after logout.
    try {
      await disableNotificationsOnThisDevice();
    } catch (err) {
      console.error('Failed to turn off notifications on logout', err);
    }
    await hangUp();
    await leaveVoice();
    // The token stops working on the server too (it may already have: logged out elsewhere).
    try {
      await api.post('/logout');
    } catch (err) {
      if (!err.response) console.error('Failed to end the session on logout', err);
    }
    try {
      localStorage.removeItem('token');
      await clearUserKeys();
      await forgetGroups();
    } catch (err) {
      console.error('Failed to clear stored keys on logout', err);
    }
    clearDrafts();
    closeWebSocket();
    setUser(null);
  }
  logoutRef.current = handleLogout;

  // A page opened from a file (no server to answer every route) needs hash URLs; the desktop
  // app serves real paths (electron/protocol.js).
  const Router = window.location.protocol === 'file:' ? HashRouter : BrowserRouter;

  return (
    <ConfigContext.Provider value={config}>
      <EmojiProvider>
      <InteractionContext.Provider value={interaction}>
        <ImageViewerProvider>
        <Router>
          <SWMessageHandler />
          <MessageImageMenus />
          <UpdateBanner />
          <Routes>
            <Route
              path="/"
              // TODO at some point, change this to the previously viewed page?
              element={user ? <Navigate to="/dm" replace /> : <Login onLoginSuccess={setUser} />}
            />

            {user && (
              <Route element={<Layout user={user} onLogout={handleLogout} />}>
                <Route path="/settings" element={<Settings onLogout={handleLogout} />} />
                <Route path="/settings/profile" element={<Settings onLogout={handleLogout} />} />
                <Route path="/dm/:id?" element={<Dm user={user} />} />
                <Route path="/dm/notes" element={<Notes user={user} />} />
                <Route path="/dm/g/:groupId" element={<GroupDm user={user} />} />
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
