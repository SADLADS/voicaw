import React, { useEffect, useRef, useState } from 'react';
import { HashRouter, BrowserRouter, unstable_HistoryRouter as HistoryRouter, Routes, Route, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { ConfigContext, InteractionContext } from './contexts';
import { showContent } from './utils/mobilePanes';
import { createPhoneHistory } from './utils/phoneHistory';

import Login from './components/Login.jsx';
import PendingApproval from './components/PendingApproval.jsx';
import Layout from './components/Layout.jsx';
import Settings from './components/Settings.jsx';
import Dm from './components/Dm.jsx';
import Friends from './components/Friends';
import Notes from './components/Notes.jsx';
import GroupDm from './components/group/GroupDm.jsx';
import BotDm from './components/BotDm.jsx';
import GuildView from './components/guild/GuildView.jsx';
import InvitePage from './components/guild/InvitePage.jsx';
import DeveloperPortal from './components/developers/DeveloperPortal.jsx';
import AuthorizePage from './components/developers/AuthorizePage.jsx';
import api from './utils/api';
import './assets/css/mobile.css';
import './assets/css/desktop.css';

import { onLoggedOutElsewhere, onLoginReplaced } from './utils/ws-client';
import { forgetLogin, logOut } from './services/logout';
import EmojiProvider from './emoji/EmojiProvider';
import UpdateBanner from './components/UpdateBanner';
import OfflineBanner from './components/OfflineBanner';
import ImageViewerProvider from './components/ImageViewerProvider';
import PageMenus from './components/PageMenus';
import SafetyDialogs from './components/SafetyDialogs';
import { setCustomEmojiBase } from './emoji/customEmoji';
import { setAvatarBase } from './utils/profiles';
import { t } from './i18n';
import { watchKeyboardViewport } from './utils/keyboardViewport';
import TermsGate from './components/TermsGate';



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

// An app invite link (/join/<code>, Settings → Admin): signing up with it filled in.
function JoinPage({ onLoginSuccess }) {
  const { code } = useParams();
  return <Login onLoginSuccess={onLoginSuccess} invite={code} />;
}

// The phone or computer layout, from the device. It can't be chosen: the phone layout on a
// computer (or the other way round) isn't usable.
const isMobile = typeof navigator !== 'undefined' &&
  (navigator.userAgentData?.mobile ?? /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent));
const interaction = { isMobile };
// Phones: chat pages replace each other in history, so Back goes as in Discord's app.
const phoneHistory = isMobile && window.location.protocol !== 'file:' ? createPhoneHistory() : null;

// How soon the server's config is asked again when it couldn't be loaded, doubling up to the
// maximum.
const CONFIG_RETRY_MS = 2000;
const CONFIG_RETRY_MAX_MS = 30000;

export default function App() {
  const { user, setUser, loading, unreachable } = useAuth();
  const [config, setConfig] = useState({ s3Endpoint: '' });
  const logoutRef = useRef(null);

  // Logged out from another device (Settings → Devices), or the account was deleted there:
  // this one logs out too.
  useEffect(() => onLoggedOutElsewhere(() => logoutRef.current?.()), []);
  // This page's login ended while another tab logged in again: it reloads onto the new one.
  useEffect(() => onLoginReplaced(() => window.location.reload()), []);

  // The server's config, at start. Without it there are no profile pictures, guild icons or
  // custom emoji (their addresses start with s3Endpoint), so it's asked again until it comes:
  // a phone often starts offline, or before the server can be reached.
  useEffect(() => {
    let stopped = false;
    let timer = null;
    let delay = CONFIG_RETRY_MS;
    async function fetchConfig() {
      clearTimeout(timer);
      try {
        const res = await api.get('/config');
        if (stopped) return;
        // Everything the server exposes (s3Endpoint, maxPlaintextLength, vapidPublicKey, ...).
        setConfig(res.data);
        setCustomEmojiBase(res.data.s3Endpoint);
        setAvatarBase(res.data.s3Endpoint);
        window.removeEventListener('online', fetchConfig);
      } catch (err) {
        if (stopped) return;
        console.error('Failed to fetch config', err);
        timer = setTimeout(fetchConfig, delay);
        delay = Math.min(delay * 2, CONFIG_RETRY_MAX_MS);
      }
    }
    window.addEventListener('online', fetchConfig);
    fetchConfig();
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener('online', fetchConfig);
    };
  }, []);

  useEffect(() => {
    // Left over from when the layout could be picked in Settings.
    try { localStorage.removeItem("interactionMode"); } catch { /* storage blocked */ }
    document.body.classList.toggle("mobile-mode", isMobile);
    document.body.classList.toggle("desktop-mode", !isMobile);
  }, []);

  // Phones: the app ends where the on-screen keyboard starts (see utils/keyboardViewport.js).
  useEffect(() => (isMobile ? watchKeyboardViewport() : undefined), []);



  // The saved login is kept while the server can't be reached; AuthProvider keeps asking.
  if (loading) {
    if (!unreachable) return <div></div>;
    return (
      <div className="auth-unreachable">
        <p>{t('app.unreachable')}</p>
        {/* The saved login can still be dropped (nothing else would: it isn't a cookie). */}
        <button
          type="button"
          className="btn btn-link"
          onClick={async () => { await forgetLogin(); window.location.reload(); }}
        >
          {t('app.unreachableLogOut')}
        </button>
      </div>
    );
  }

  // The server gets a few seconds to end the session; this device forgets it either way.
  async function handleLogout() {
    await logOut();
    setUser(null);
  }
  logoutRef.current = handleLogout;

  // Logged in but the current terms of use not accepted yet: nothing else until they are.
  if (user && user.termsAccepted === false) {
    return (
      <ConfigContext.Provider value={config}>
        <TermsGate onAccepted={() => setUser({ ...user, termsAccepted: true })} onLogout={handleLogout} />
      </ConfigContext.Provider>
    );
  }

  // A page opened from a file (no server to answer every route) needs hash URLs; the desktop
  // app serves real paths (electron/protocol.js).
  // Phones have their own history (utils/phoneHistory.js).
  let Router = window.location.protocol === 'file:' ? HashRouter : BrowserRouter;
  let routerProps = {};
  if (phoneHistory) {
    Router = HistoryRouter;
    routerProps = { history: phoneHistory };
  }

  return (
    <ConfigContext.Provider value={config}>
      <EmojiProvider>
      <InteractionContext.Provider value={interaction}>
        <ImageViewerProvider>
        <Router {...routerProps}>
          <SWMessageHandler />
          <PageMenus />
          <SafetyDialogs />
          <UpdateBanner />
          <OfflineBanner />
          {/* Waiting for an admin's approval (server/signups.js): only that, whatever the address. */}
          {user?.pending ? (
            <PendingApproval user={user} onApproved={() => setUser({ ...user, pending: false })} onLogout={handleLogout} />
          ) : (
          <Routes>
            <Route
              path="/"
              // TODO at some point, change this to the previously viewed page?
              element={user ? <Navigate to="/dm" replace /> : <Login onLoginSuccess={setUser} />}
            />

            {user && (
              <Route element={<Layout user={user} onLogout={handleLogout} />}>
                <Route path="/settings/*" element={<Settings onLogout={handleLogout} />} />
                <Route path="/dm/:id?" element={<Dm user={user} />} />
                <Route path="/dm/notes" element={<Notes user={user} />} />
                <Route path="/dm/friends" element={<Friends user={user} />} />
                <Route path="/dm/g/:groupId" element={<GroupDm user={user} />} />
                <Route path="/dm/b/:dmId" element={<BotDm user={user} />} />
                <Route path="/guild/:guildId/:channelId?" element={<GuildView user={user} />} />
                <Route path="/invite/:code" element={<InvitePage />} />
              </Route>
            )}

            {/* The developer portal and a bot's invite link: pages of their own (docs/bots.md). */}
            {user && <Route path="/developers" element={<DeveloperPortal />} />}
            {user && <Route path="/developers/applications/:appId" element={<DeveloperPortal />} />}
            {user && <Route path="/oauth2/authorize" element={<AuthorizePage />} />}

            {/* Logged out, an invite link asks you to log in first, then shows the invite (the
                same for the developer portal and bots' invite links). */}
            {!user && <Route path="/invite/:code" element={<Login onLoginSuccess={setUser} />} />}
            {!user && <Route path="/developers/*" element={<Login onLoginSuccess={setUser} />} />}
            {!user && <Route path="/oauth2/authorize" element={<Login onLoginSuccess={setUser} />} />}
            {!user && <Route path="/join/:code" element={<JoinPage onLoginSuccess={setUser} />} />}

            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
          )}
        </Router>
        </ImageViewerProvider>
      </InteractionContext.Provider>
      </EmojiProvider>
    </ConfigContext.Provider>
  );
}
