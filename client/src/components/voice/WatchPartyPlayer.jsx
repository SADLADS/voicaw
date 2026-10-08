import React, { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowRight, faCompress, faDownLeftAndUpRightToCenter, faExpand, faForwardStep, faPause, faPlay, faUpRightFromSquare, faVolumeHigh,
  faVolumeXmark, faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { InteractionContext, LayoutContext } from '../../contexts';
import { useVoice } from '../../hooks/useVoice';
import { useWatchPartySync } from '../../hooks/useWatchPartySync';
import { embedUrl, YouTubeEmbed } from '../../voice/youtubeEmbed';
import {
  expectedPosition, formatClock, serverNow, setPlayback, skipVideo, usePlayerSlot, useWatchParty,
} from '../../voice/watchParty';
import {
  closeWatchPartyWindow, openWatchPartyWindow, setWatchPartyWindowTitle, useWatchPartyWindow,
} from '../../voice/watchPartyWindow';
import { usePrivacyPrefs } from '../../utils/privacy';
import { PERMISSIONS, has } from '../../utils/permissions';
import { t } from '../../i18n';

const VOLUME_KEY = 'watchPartyVolume';
function loadVolume() {
  try {
    const stored = Number(localStorage.getItem(VOLUME_KEY));
    return localStorage.getItem(VOLUME_KEY) != null && Number.isFinite(stored) ? Math.min(100, Math.max(0, stored)) : 100;
  } catch {
    return 100;
  }
}
function saveVolume(volume) {
  try {
    localStorage.setItem(VOLUME_KEY, String(volume));
  } catch {
    // Not kept: fine.
  }
}

// Channels whose video was let load this session, with "Show YouTube videos straight away" off.
const allowedChannels = new Set();

// Watch Together's player (voice/watchParty.js): the voice channel you're in, while its party
// has a video. Drawn from Layout and never moved, so it plays on whatever page you open: over
// the channel page's slot (WatchPartyPanel) while that's on screen, else small in a corner
// (close it there to stop watching until you open the channel again), or, popped out
// (computers), in a window of its own (voice/watchPartyWindow.js), where it starts afresh.
export default function WatchPartyPlayer() {
  const voice = useVoice();
  const inChannel = voice.status !== 'idle' && voice.channelId != null && voice.guildId != null;
  const guildId = inChannel ? voice.guildId : null;
  const channelId = inChannel ? voice.channelId : null;
  const party = useWatchParty(guildId, channelId);
  const slot = usePlayerSlot();
  const [dismissed, setDismissed] = useState(null);
  const popoutRoot = useWatchPartyWindow();
  const live = inChannel && Boolean(party?.current);
  const title = party?.current ? party.current.title ?? t('voice.watchParty.untitled') : '';

  useEffect(() => {
    if (slot) setDismissed(null);
  }, [slot]);

  // The window goes once there's nothing to watch.
  useEffect(() => {
    if (popoutRoot && !live) closeWatchPartyWindow();
  }, [popoutRoot, live]);

  useEffect(() => {
    if (popoutRoot && title) setWatchPartyWindowTitle(t('voice.watchParty.windowTitleOf', { title }));
  }, [popoutRoot, title]);

  if (!live) return null;
  if (popoutRoot) {
    return createPortal(
      <PlayerBox
        key={`popout-${channelId}`}
        popout
        guildId={guildId}
        channelId={channelId}
        party={party}
        slot={null}
        deafened={voice.selfDeaf}
        myId={voice.identity == null ? null : Number(voice.identity)}
      />,
      popoutRoot,
    );
  }
  if (!slot && dismissed === channelId) return null;
  return (
    <PlayerBox
      key={channelId}
      guildId={guildId}
      channelId={channelId}
      party={party}
      slot={slot}
      deafened={voice.selfDeaf}
      myId={voice.identity == null ? null : Number(voice.identity)}
      onClose={() => setDismissed(channelId)}
    />
  );
}

function PlayerBox({ guildId, channelId, party, slot, deafened, myId, onClose, popout = false }) {
  const navigate = useNavigate();
  const { guildList } = useContext(LayoutContext);
  const { isMobile } = useContext(InteractionContext);
  const channel = guildList?.layouts?.[guildId]?.channels?.find((c) => c.id === channelId);
  const permissions = channel?.my_permissions ?? 0;
  const canControl = has(permissions, PERMISSIONS.CONTROL_PLAYBACK);
  const canSkip = canControl || (myId != null && party.current.added_by === myId);

  const autoLoad = usePrivacyPrefs().youtubeEmbeds;
  const [allowed, setAllowed] = useState(() => autoLoad || allowedChannels.has(channelId));
  const boxRef = useRef(null);
  const [onSlot, setOnSlot] = useState(Boolean(slot));
  // Popped out, it fills its window and has all its controls, as over the slot.
  const docked = popout || onSlot;
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [frame, setFrame] = useState(null);
  const [embed, setEmbed] = useState(null);
  const [ready, setReady] = useState(false);
  const [volume, setVolume] = useState(loadVolume);
  const [, setTick] = useState(0);
  const [dragging, setDragging] = useState(null); // the seek bar's value while dragged
  const [fullscreen, setFullscreen] = useState(false);
  // The frame's first address only: later videos are loaded through it (a new src would reload it).
  const [initialItemId] = useState(party.current.id);
  const [src] = useState(() => embedUrl(party.current.video_id, {
    start: expectedPosition(party),
    autoplay: party.playing,
    origin: window.location.origin,
  }));

  // Over the slot while it's on screen (followed every frame: the phone layout slides panes).
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || popout) return undefined;
    let raf = 0;
    let last = '';
    const place = () => {
      const rect = slot?.getBoundingClientRect();
      const onScreen = rect && rect.width > 0 && rect.height > 0;
      const key = onScreen ? `${rect.left},${rect.top},${rect.width},${rect.height}` : 'mini';
      if (key !== last) {
        last = key;
        setOnSlot(Boolean(onScreen));
        if (onScreen) Object.assign(box.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        else Object.assign(box.style, { left: '', top: '', width: '', height: '' });
      }
      if (slot) raf = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [slot, popout]);

  useEffect(() => {
    if (!frame) return undefined;
    const controller = new YouTubeEmbed(frame, { onChange: (info) => setReady(info.ready) });
    setEmbed(controller);
    return () => {
      controller.destroy();
      setEmbed(null);
      setReady(false);
    };
  }, [frame]);

  const { blocked, retry } = useWatchPartySync({
    embed, ready, party, guildId, channelId, volume: deafened ? 0 : volume, initialItemId,
  });

  // The clock and seek bar move on.
  useEffect(() => {
    if (!party.playing) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [party.playing]);

  // Full screen in the document it's in: the pop-out window's, when it's there.
  const ownDocument = () => boxRef.current?.ownerDocument ?? document;
  useEffect(() => {
    const doc = boxRef.current?.ownerDocument ?? document;
    const changed = () => setFullscreen(doc.fullscreenElement === boxRef.current);
    doc.addEventListener('fullscreenchange', changed);
    return () => doc.removeEventListener('fullscreenchange', changed);
  }, []);

  useEffect(() => {
    if (!popupBlocked) return undefined;
    const timer = setTimeout(() => setPopupBlocked(false), 5000);
    return () => clearTimeout(timer);
  }, [popupBlocked]);

  const changeVolume = (value) => {
    setVolume(value);
    saveVolume(value);
  };
  const toggleFullscreen = () => {
    const doc = ownDocument();
    if (doc.fullscreenElement) doc.exitFullscreen?.().catch(() => {});
    else boxRef.current?.requestFullscreen?.().catch(() => {});
  };
  const popOut = () => {
    if (!openWatchPartyWindow()) setPopupBlocked(true);
  };
  const canPopOut = !popout && !isMobile;
  const itemId = party.current.id;
  const send = useCallback((playback) => {
    setPlayback(guildId, channelId, { ...playback, itemId }).catch(() => {});
  }, [guildId, channelId, itemId]);
  const commitSeek = () => {
    if (dragging == null) return;
    send({ position: dragging });
    setDragging(null);
  };

  const duration = party.current.duration ?? 0;
  const position = dragging ?? expectedPosition(party, serverNow());
  const title = party.current.title ?? t('voice.watchParty.untitled');
  const muted = deafened || volume === 0;

  return (
    <div ref={boxRef} className={`watch-party-player${popout ? ' popped-out' : docked ? ' docked' : ' mini'}${fullscreen ? ' fullscreen' : ''}`}>
      {!docked && (
        <div className="watch-party-mini-bar">
          <span className="watch-party-mini-title" title={title}>{title}</span>
          <button type="button" className="watch-party-icon-button" title={t('voice.watchParty.openChannel')} aria-label={t('voice.watchParty.openChannel')} onClick={() => navigate(`/guild/${guildId}/${channelId}`)}>
            <FontAwesomeIcon icon={faArrowRight} fixedWidth />
          </button>
          {canPopOut && (
            <button type="button" className="watch-party-icon-button" title={t('voice.watchParty.popOut')} aria-label={t('voice.watchParty.popOut')} onClick={popOut}>
              <FontAwesomeIcon icon={faUpRightFromSquare} fixedWidth />
            </button>
          )}
          <button type="button" className="watch-party-icon-button" title={t('voice.watchParty.closePlayer')} aria-label={t('voice.watchParty.closePlayer')} onClick={onClose}>
            <FontAwesomeIcon icon={faXmark} fixedWidth />
          </button>
        </div>
      )}
      <div className="watch-party-stage">
        {allowed ? (
          <>
            <iframe
              ref={setFrame}
              src={src}
              title={t('voice.watchParty.playerTitle')}
              allow="autoplay; encrypted-media; picture-in-picture"
              referrerPolicy="strict-origin-when-cross-origin"
            />
            {/* Clicks go to our controls, not YouTube's player (everyone's must stay in step). */}
            <div className="watch-party-shield" onDoubleClick={toggleFullscreen} />
            {popupBlocked && <p className="watch-party-popup-blocked" role="alert">{t('voice.watchParty.popupBlocked')}</p>}
            {blocked && (
              <button type="button" className="watch-party-blocked" onClick={retry}>
                <FontAwesomeIcon icon={faPlay} /> {t('voice.watchParty.clickToWatch')}
              </button>
            )}
          </>
        ) : (
          <div className="watch-party-consent">
            <p>{t('voice.watchParty.consent')}</p>
            <button
              type="button"
              className="watch-party-primary"
              onClick={() => {
                allowedChannels.add(channelId);
                setAllowed(true);
              }}
            >
              {t('voice.watchParty.loadPlayer')}
            </button>
          </div>
        )}
      </div>
      <div className="watch-party-controls">
        {canControl && (
          <button
            type="button"
            className="watch-party-icon-button"
            aria-label={party.playing ? t('voice.watchParty.pause') : t('voice.watchParty.play')}
            title={party.playing ? t('voice.watchParty.pause') : t('voice.watchParty.play')}
            onClick={() => send({ playing: !party.playing })}
          >
            <FontAwesomeIcon icon={party.playing ? faPause : faPlay} fixedWidth />
          </button>
        )}
        {canSkip && (
          <button
            type="button"
            className="watch-party-icon-button"
            aria-label={t('voice.watchParty.skip')}
            title={t('voice.watchParty.skip')}
            onClick={() => skipVideo(guildId, channelId, itemId).catch(() => {})}
          >
            <FontAwesomeIcon icon={faForwardStep} fixedWidth />
          </button>
        )}
        <span className="watch-party-time">
          {formatClock(position)}{duration ? ` / ${formatClock(duration)}` : ''}
        </span>
        {docked && duration > 0 ? (
          <input
            type="range"
            className="watch-party-seek"
            min={0}
            max={Math.floor(duration)}
            step={1}
            value={Math.min(Math.floor(position), Math.floor(duration))}
            disabled={!canControl}
            aria-label={t('voice.watchParty.seek')}
            onChange={(e) => setDragging(Number(e.target.value))}
            onPointerUp={commitSeek}
            onKeyUp={commitSeek}
            onBlur={commitSeek}
          />
        ) : <span className="watch-party-spacer" />}
        {!party.playing && <span className="watch-party-paused">{t('voice.watchParty.paused')}</span>}
        <button
          type="button"
          className="watch-party-icon-button"
          aria-label={muted ? t('voice.watchParty.unmute') : t('voice.watchParty.mute')}
          title={deafened ? t('voice.watchParty.deafened') : muted ? t('voice.watchParty.unmute') : t('voice.watchParty.mute')}
          disabled={deafened}
          onClick={() => changeVolume(volume === 0 ? 100 : 0)}
        >
          <FontAwesomeIcon icon={muted ? faVolumeXmark : faVolumeHigh} fixedWidth />
        </button>
        {docked && (
          <input
            type="range"
            className="watch-party-volume"
            min={0}
            max={100}
            step={1}
            value={volume}
            aria-label={t('voice.watchParty.volume')}
            onChange={(e) => changeVolume(Number(e.target.value))}
          />
        )}
        {docked && canPopOut && (
          <button type="button" className="watch-party-icon-button" aria-label={t('voice.watchParty.popOut')} title={t('voice.watchParty.popOut')} onClick={popOut}>
            <FontAwesomeIcon icon={faUpRightFromSquare} fixedWidth />
          </button>
        )}
        {popout && (
          <button type="button" className="watch-party-icon-button" aria-label={t('voice.watchParty.bringBack')} title={t('voice.watchParty.bringBack')} onClick={closeWatchPartyWindow}>
            <FontAwesomeIcon icon={faDownLeftAndUpRightToCenter} fixedWidth />
          </button>
        )}
        {docked && (
          <button
            type="button"
            className="watch-party-icon-button"
            aria-label={fullscreen ? t('voice.watchParty.exitFullscreen') : t('voice.watchParty.fullscreen')}
            title={fullscreen ? t('voice.watchParty.exitFullscreen') : t('voice.watchParty.fullscreen')}
            onClick={toggleFullscreen}
          >
            <FontAwesomeIcon icon={fullscreen ? faCompress : faExpand} fixedWidth />
          </button>
        )}
      </div>
    </div>
  );
}
