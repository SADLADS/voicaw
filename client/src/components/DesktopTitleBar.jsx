import React, { useEffect } from 'react';
import { faArrowLeft, faArrowRight } from '@fortawesome/free-solid-svg-icons';
import { Icon } from './Icon';
import GuildIcon from './guild/GuildIcon';
import Inbox from './Inbox';
import { desktop } from '../utils/desktop';
import { useShownTitle } from '../hooks/usePageTitle';
import { useDesktopWindowState, useHistoryMoves } from '../hooks/useDesktopWindow';
import { t } from '../i18n';
import '../assets/css/titleBar.css';

// The desktop app's title bar (the window has none of its own: electron/main.js), on every page:
// back and forward (the browser's, as the mouse's side buttons), the page's title with its
// guild's icon, the inbox once logged in and, but on macOS (whose own buttons sit at its left),
// minimise, maximise and close. The bar drags the window. Never in a browser or on a phone.
export default function DesktopTitleBar({ loggedIn }) {
  const supported = Boolean(desktop?.windowAction);
  const { text, guild } = useShownTitle();
  const { maximized, fullScreen, focused } = useDesktopWindowState();
  const moves = useHistoryMoves();
  const mac = desktop?.platform === 'darwin';

  // The page leaves room for it (voicaw.css, html.has-title-bar).
  useEffect(() => {
    if (!supported) return undefined;
    document.documentElement.classList.add('has-title-bar');
    return () => document.documentElement.classList.remove('has-title-bar');
  }, [supported]);

  if (!supported) return null;

  return (
    <header className={`title-bar${mac ? ' mac' : ''}${focused ? '' : ' blurred'}${fullScreen ? ' full-screen' : ''}`}>
      <div className="title-bar-side title-bar-start">
        <button type="button" className="title-bar-button" disabled={!moves.back} onClick={() => window.history.back()}
          aria-label={t('app.titleBar.back')} title={t('app.titleBar.back')}>
          <Icon icon={faArrowLeft} />
        </button>
        <button type="button" className="title-bar-button" disabled={!moves.forward} onClick={() => window.history.forward()}
          aria-label={t('app.titleBar.forward')} title={t('app.titleBar.forward')}>
          <Icon icon={faArrowRight} />
        </button>
      </div>
      <div className="title-bar-title">
        {guild && <GuildIcon guild={guild} className="title-bar-guild-icon" />}
        <span className="title-bar-text">{text}</span>
      </div>
      <div className="title-bar-side title-bar-end">
        {loggedIn && <Inbox />}
        {!mac && (
          <div className="title-bar-window-buttons">
            <button type="button" className="title-bar-window-button" onClick={() => desktop.windowAction('minimize')}
              aria-label={t('app.titleBar.minimise')} title={t('app.titleBar.minimise')}>
              <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6h8" /></svg>
            </button>
            <button type="button" className="title-bar-window-button" onClick={() => desktop.windowAction('maximize')}
              aria-label={t(maximized || fullScreen ? 'app.titleBar.restore' : 'app.titleBar.maximise')}
              title={t(maximized || fullScreen ? 'app.titleBar.restore' : 'app.titleBar.maximise')}>
              {maximized || fullScreen
                ? <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5h5v5h-5zM4.5 4.5v-2h5v5h-2" /></svg>
                : <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5h7v7h-7z" /></svg>}
            </button>
            <button type="button" className="title-bar-window-button close" onClick={() => desktop.windowAction('close')}
              aria-label={t('app.titleBar.close')} title={t('app.titleBar.close')}>
              <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg>
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
