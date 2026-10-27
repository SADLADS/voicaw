import React, { useContext, useEffect, useRef, useState } from 'react';
import '../../assets/css/voice.css';
import { Icon } from '../Icon';
import {
  faArrowRight, faCheck, faDownLeftAndUpRightToCenter, faExpand, faEye, faSliders, faUpRightFromSquare, faVolumeHigh, faVolumeXmark, faXmark,
} from '@fortawesome/free-solid-svg-icons';
import UserAvatar from './UserAvatar';
import { InteractionContext } from '../../contexts';
import { useVoice } from '../../hooks/useVoice';
import { useShowsStreamOnPage } from '../../hooks/useStreamOnPage';
import { displayName, useProfiles } from '../../utils/profiles';
import { attachStream, setStreamError, watchStream } from '../../voice/voiceClient';
import { closeStreamWindow, openStreamWindow } from '../../voice/streamWindow';
import { DEFAULT_USER_VOLUME, maxUserVolume, setStreamVolume, useStreamVolume } from '../../voice/userVolumes';
import { VIEW_QUALITIES, setStreamViewQuality, useStreamViewQuality } from '../../voice/streamViewSettings';
import { t } from '../../i18n';

// The screen share being watched, big (the voice channel view's stage, or its own window when
// popped out) or small in a corner (`corner`, StreamCorner, while no page shows it; `onOpen`
// goes to its channel or call, `openLabel` saying which): the video, whose it is, who else is
// watching it (like Discord's viewers; never you), its volume, its quality (which copy this
// device downloads; not in the corner, no room), pop out (or bring back), full screen and stop
// watching. Its sound plays with the rest of voice (deafen mutes it), at the stream's own volume
// on this device (like Discord's Stream Volume, userVolumes.js); not for our own, which we don't
// hear.
export default function StreamView({ userId, name, own, popout = false, corner = false, onOpen, openLabel }) {
  const { watchingReady, selfDeaf, watchers } = useVoice();
  const { isMobile } = useContext(InteractionContext);
  const videoRef = useRef(null);
  const stageRef = useRef(null);
  // The size of what's arriving (the copy LiveKit sends, see StreamQuality).
  const [size, setSize] = useState(null);
  useShowsStreamOnPage(!popout && !corner);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    const measure = () => setSize(video.videoWidth > 0 ? { width: video.videoWidth, height: video.videoHeight } : null);
    video.addEventListener('resize', measure);
    video.addEventListener('loadedmetadata', measure);
    return () => {
      video.removeEventListener('resize', measure);
      video.removeEventListener('loadedmetadata', measure);
    };
  }, []);

  useEffect(() => {
    if (!watchingReady) return undefined;
    return attachStream(userId, videoRef.current);
  }, [userId, watchingReady]);

  function fullScreen() {
    // The document it's in: the pop-out window's, when it's there.
    const stage = stageRef.current;
    const doc = stage?.ownerDocument ?? document;
    if (doc.fullscreenElement) doc.exitFullscreen?.();
    else (stage?.requestFullscreen ?? stage?.webkitRequestFullscreen)?.call(stage)?.catch?.(() => {});
  }

  function popOut() {
    if (!openStreamWindow()) setStreamError(t('voice.stream.popupBlocked'));
  }

  return (
    <div className={`stream-view${popout ? ' popped-out' : ''}${corner ? ' corner' : ''}`} ref={stageRef} onDoubleClick={fullScreen}>
      {/* Muted: a screen share's sound plays through voice's own audio (see voiceClient). */}
      <video ref={videoRef} className="stream-video" autoPlay playsInline muted aria-label={t('voice.stream.screenOf', { name })} />
      {!watchingReady && <p className="stream-loading">{t('voice.stream.loading')}</p>}
      <div className="stream-bar">
        {!corner && <span className="voice-live-badge">{t('voice.stream.live')}</span>}
        <span className="stream-name" title={corner ? name : undefined}>{own ? t('voice.stream.yourStream') : name}</span>
        <StreamWatchers watchers={watchers?.[userId] ?? []} compact={corner || isMobile} />
        {!own && <StreamVolume userId={userId} deafened={selfDeaf} />}
        {!own && !corner && <StreamQuality size={size} />}
        {corner && onOpen && (
          <button type="button" className="stream-button" aria-label={openLabel} title={openLabel} onClick={onOpen}>
            <Icon icon={faArrowRight} fixedWidth />
          </button>
        )}
        {popout ? (
          <button type="button" className="stream-button" aria-label={t('voice.stream.bringBack')} title={t('voice.stream.bringBack')} onClick={closeStreamWindow}>
            <Icon icon={faDownLeftAndUpRightToCenter} fixedWidth />
          </button>
        ) : !isMobile && (
          <button type="button" className="stream-button" aria-label={t('voice.stream.popOut')} title={t('voice.stream.popOut')} onClick={popOut}>
            <Icon icon={faUpRightFromSquare} fixedWidth />
          </button>
        )}
        {!corner && (
          <button type="button" className="stream-button" aria-label={t('voice.stream.fullScreen')} title={t('voice.stream.fullScreen')} onClick={fullScreen}>
            <Icon icon={faExpand} fixedWidth />
          </button>
        )}
        <button type="button" className="stream-button" aria-label={t('voice.stream.stopWatching')} title={t('voice.stream.stopWatching')} onClick={() => watchStream(null)}>
          <Icon icon={faXmark} fixedWidth />
        </button>
      </div>
    </div>
  );
}

// How many others watch (`watchers`: [{ id, username }], voiceClient), with their pictures
// (not in the corner or on a phone: no room); a click lists their names.
const SHOWN_PICTURES = 3;

function StreamWatchers({ watchers, compact }) {
  useProfiles();
  const [open, setOpen] = useState(false);
  if (watchers.length === 0) return null;
  const ids = watchers.map((w) => w.id);
  const names = watchers.map((w) => displayName(w.id, w.username));
  const label = t('voice.stream.watchers', { count: ids.length, names: names.join(', ') });
  return (
    <span className="stream-watchers">
      <button
        type="button"
        className="stream-watchers-button"
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((was) => !was)}
        onBlur={() => setOpen(false)}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <Icon icon={faEye} />
        <span>{ids.length}</span>
        {!compact && (
          <span className="stream-watchers-pictures">
            {ids.slice(0, SHOWN_PICTURES).map((id) => <UserAvatar key={id} userId={id} />)}
          </span>
        )}
      </button>
      {open && (
        <ul className="stream-watchers-list" aria-label={t('voice.stream.watchersTitle')}>
          <li className="stream-watchers-heading">{t('voice.stream.watchersTitle')}</li>
          {ids.map((id, i) => (
            <li key={id}>
              <UserAvatar userId={id} />
              <span>{names[i]}</span>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

// Which copy of the stream this device downloads (voice/streamViewSettings.js: full size, or
// the half-size one to save data), for every stream, and the size arriving now.
function StreamQuality({ size }) {
  const quality = useStreamViewQuality();
  const [open, setOpen] = useState(false);
  const label = t('voice.stream.quality');
  return (
    <span className="stream-view-quality-menu">
      <button
        type="button"
        className="stream-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((was) => !was)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <Icon icon={faSliders} fixedWidth />
      </button>
      {open && (
        <div className="stream-view-quality-list" role="menu" aria-label={label} onDoubleClick={(e) => e.stopPropagation()}>
          <p className="stream-watchers-heading">{label}</p>
          {VIEW_QUALITIES.map((option) => (
            <button
              key={option}
              type="button"
              role="menuitemradio"
              aria-checked={option === quality}
              className="stream-view-quality-item"
              // Keeps the focus on the menu's button, whose blur closes the menu.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setStreamViewQuality(option);
                setOpen(false);
              }}
            >
              <span className="stream-view-quality-check">{option === quality && <Icon icon={faCheck} />}</span>
              <span>
                <span className="stream-view-quality-name">{t(`voice.stream.qualities.${option}`)}</span>
                <span className="stream-view-quality-hint">{t(`voice.stream.qualityHints.${option}`)}</span>
              </span>
            </button>
          ))}
          {size && <p className="stream-view-quality-size">{t('voice.stream.receiving', size)}</p>}
        </div>
      )}
    </span>
  );
}

function StreamVolume({ userId, deafened }) {
  const volume = useStreamVolume(userId);
  // What unmuting goes back to.
  const unmutedRef = useRef(DEFAULT_USER_VOLUME);
  if (volume > 0) unmutedRef.current = volume;
  const muted = deafened || volume === 0;
  // One saved above what this device can play shows (and plays) as the most it can.
  const percent = Math.round(Math.min(volume, maxUserVolume()) * 100);

  return (
    <span className="stream-volume">
      <button
        type="button"
        className="stream-button"
        aria-label={muted ? t('voice.stream.unmute') : t('voice.stream.mute')}
        title={deafened ? t('voice.stream.deafened') : muted ? t('voice.stream.unmute') : t('voice.stream.mute')}
        aria-pressed={volume === 0}
        disabled={deafened}
        onClick={() => setStreamVolume(userId, volume === 0 ? unmutedRef.current : 0)}
      >
        <Icon icon={muted ? faVolumeXmark : faVolumeHigh} fixedWidth />
      </button>
      <input
        type="range"
        className="stream-volume-slider"
        min={0}
        max={maxUserVolume() * 100}
        step={1}
        value={percent}
        disabled={deafened}
        aria-label={t('voice.stream.volume')}
        aria-valuetext={t('voice.stream.percent', { percent })}
        title={t('voice.stream.percent', { percent })}
        onChange={(e) => setStreamVolume(userId, Number(e.target.value) / 100)}
        onDoubleClick={(e) => e.stopPropagation()}
      />
    </span>
  );
}
