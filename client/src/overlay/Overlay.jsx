import React, { useEffect, useRef, useState } from 'react';
import '../assets/css/voice.css';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowUpRightFromSquare, faPhoneSlash, faXmark } from '@fortawesome/free-solid-svg-icons';
import defaultpfp from '../assets/images/default.png';
import { HeadphonesIcon, MicIcon } from '../components/voice/VoiceIcons';
import { describeAccelerator } from '../utils/desktop';
import { t } from '../i18n';

const POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
// How long a notification stays, and how many show at once.
const TOAST_MS = 6000;
const MAX_TOASTS = 3;
// How long "Press … to unlock" shows when it appears.
const HINT_MS = 6000;

// The desktop app's in-game overlay (electron/overlay.js), drawn from what the app sends
// (`bridge`, electron/overlayPreload.js). Locked, the mouse goes through it: who's in the voice
// channel or call (ringed while they talk, mute and deafen icons) and notifications. Unlocked
// (the shortcut), it dims the game and adds the channel's name, mute, deafen, disconnect, the
// corner it sits in and Open Voicaw; Escape or a click on the dimmed part locks it again.
// The window is only as big as its content while locked, which it tells the app.
export default function Overlay({ bridge }) {
  const [state, setState] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [hint, setHint] = useState(true);
  const content = useRef(null);
  const nextToast = useRef(0);

  useEffect(() => {
    bridge.onState(setState);
    bridge.onToast((notification) => {
      const id = nextToast.current++;
      setToasts((list) => [...list, { ...notification, id }].slice(-MAX_TOASTS));
      setTimeout(() => setToasts((list) => list.filter((n) => n.id !== id)), TOAST_MS);
    });
    const timer = setTimeout(() => setHint(false), HINT_MS);
    return () => clearTimeout(timer);
  }, [bridge]);

  const unlocked = Boolean(state?.unlocked);
  const ready = state !== null;

  // The app sizes the locked window to this.
  useEffect(() => {
    const element = content.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const report = () => {
      const { width, height } = element.getBoundingClientRect();
      bridge.send({ type: 'size', width: Math.ceil(width), height: Math.ceil(height) });
    };
    const observer = new ResizeObserver(report);
    observer.observe(element);
    report();
    return () => observer.disconnect();
  }, [bridge, ready]);

  useEffect(() => {
    if (!unlocked) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') bridge.send({ type: 'lock' });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [bridge, unlocked]);

  if (!state) return null;
  const { voice, position, shortcut } = state;
  const send = (type, extra) => bridge.send({ type, ...extra });

  return (
    <div className={`overlay ${unlocked ? 'unlocked' : 'locked'} overlay-${position}`}>
      {unlocked && <div className="overlay-backdrop" onClick={() => send('lock')} aria-hidden="true" />}
      <div className="overlay-content" ref={content}>
        {voice && (
          <section className="overlay-voice" aria-label={t('overlay.voice')}>
            {unlocked && <div className="overlay-voice-title">{voice.title}</div>}
            <ul className="overlay-members">
              {voice.members.map((m) => (
                <li key={m.id} className={`overlay-member${m.speaking ? ' speaking' : ''}`}>
                  <MemberPicture src={m.avatar} />
                  <span className="overlay-member-name">{m.name}</span>
                  {(m.muted || m.deafened) && (
                    <span className="overlay-member-icons">
                      {m.muted && <span title={t('overlay.muted')} aria-label={t('overlay.muted')}><MicIcon muted /></span>}
                      {m.deafened && <span title={t('overlay.deafened')} aria-label={t('overlay.deafened')}><HeadphonesIcon deafened /></span>}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {unlocked && (
              <div className="overlay-controls">
                <button
                  type="button"
                  className={`overlay-button${voice.selfMute || voice.selfDeaf ? ' active' : ''}`}
                  aria-label={voice.selfMute || voice.selfDeaf ? t('overlay.unmute') : t('overlay.mute')}
                  title={voice.selfMute || voice.selfDeaf ? t('overlay.unmute') : t('overlay.mute')}
                  onClick={() => send('toggleMute')}
                >
                  <MicIcon muted={voice.selfMute || voice.selfDeaf} />
                </button>
                <button
                  type="button"
                  className={`overlay-button${voice.selfDeaf ? ' active' : ''}`}
                  aria-label={voice.selfDeaf ? t('overlay.undeafen') : t('overlay.deafen')}
                  title={voice.selfDeaf ? t('overlay.undeafen') : t('overlay.deafen')}
                  onClick={() => send('toggleDeafen')}
                >
                  <HeadphonesIcon deafened={voice.selfDeaf} />
                </button>
                <button
                  type="button"
                  className="overlay-button overlay-leave"
                  aria-label={t('overlay.disconnect')}
                  title={t('overlay.disconnect')}
                  onClick={() => send('disconnect')}
                >
                  <FontAwesomeIcon icon={faPhoneSlash} fixedWidth />
                </button>
              </div>
            )}
          </section>
        )}
        {hint && !unlocked && shortcut && (
          <p className="overlay-hint">{t('overlay.unlockHint', { key: describeAccelerator(shortcut, bridge.platform) })}</p>
        )}
        {toasts.map((n) => (
          <button
            key={n.id}
            type="button"
            className="overlay-toast"
            tabIndex={unlocked ? 0 : -1}
            onClick={() => send('open', { url: n.url })}
          >
            {n.icon && <img className="overlay-toast-icon" src={n.icon} alt="" draggable={false} />}
            <span className="overlay-toast-text">
              <span className="overlay-toast-title">{n.title}</span>
              {n.body && <span className="overlay-toast-body">{n.body}</span>}
            </span>
          </button>
        ))}
        {unlocked && (
          <section className="overlay-panel" aria-label={t('overlay.settings')}>
            <div className="overlay-panel-row">
              <span>{t('overlay.position')}</span>
              <div className="overlay-corners" role="group" aria-label={t('overlay.position')}>
                {POSITIONS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`overlay-corner overlay-corner-${p}${p === position ? ' active' : ''}`}
                    aria-label={t(`overlay.positions.${p}`)}
                    aria-pressed={p === position}
                    title={t(`overlay.positions.${p}`)}
                    onClick={() => send('position', { position: p })}
                  />
                ))}
              </div>
            </div>
            <div className="overlay-panel-row">
              <button type="button" className="overlay-text-button" onClick={() => send('open', { url: null })}>
                <FontAwesomeIcon icon={faArrowUpRightFromSquare} fixedWidth /> {t('overlay.openApp')}
              </button>
              <button type="button" className="overlay-text-button" onClick={() => send('lock')}>
                <FontAwesomeIcon icon={faXmark} fixedWidth /> {t('overlay.lock')}
              </button>
            </div>
            {shortcut && <p className="overlay-panel-hint">{t('overlay.lockShortcutHint', { key: describeAccelerator(shortcut, bridge.platform) })}</p>}
          </section>
        )}
      </div>
    </div>
  );
}

// A profile picture (the main page sends its address: the overlay has no profile store), or
// the default one.
function MemberPicture({ src }) {
  const [failed, setFailed] = useState(null);
  return (
    <img
      className="overlay-member-avatar"
      src={src && failed !== src ? src : defaultpfp}
      alt=""
      draggable={false}
      onError={() => setFailed(src)}
    />
  );
}
