import React, { useEffect, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlay } from '@fortawesome/free-solid-svg-icons';
import { youtubeVideoId } from '../utils/youtube';
import { inviteCodeFromUrl } from '../utils/inviteLinks';
import { usePrivacyPrefs } from '../utils/privacy';
import { EMBED_ORIGIN, STATE, YouTubeEmbed as EmbedControl } from '../voice/youtubeEmbed';
import { useMediaCover } from '../hooks/useMediaCover';
import InviteEmbed from './guild/InviteEmbed';
import MediaCover from './MediaCover';
import { t } from '../i18n';

const URL_PATTERN = /https?:\/\/[^\s)]+/g;

// Videos played since the app was opened, so they stay loaded when the list redraws.
const playedVideos = new Set();

const PLAYING = [STATE.PLAYING, STATE.BUFFERING];
const BLOCKED_MS = 1500; // a Play sent from the shield that hasn't started by then was refused

function embedSrc(id, autoplay) {
  const params = new URLSearchParams({ enablejsapi: '1' });
  // The frame only answers to this origin; our desktop app's voicaw:// pages have none it accepts.
  if (/^https?:/.test(window.location.origin)) params.set('origin', window.location.origin);
  if (autoplay) params.set('autoplay', '1');
  return `${EMBED_ORIGIN}/embed/${id}?${params}`;
}

// The player itself. Touches on a cross-origin frame never reach our page, so on touch screens
// a shield covers it (all but YouTube's control bar, see .youtube-shield) and swipes starting on
// the video still move the panes or reply. Tapping the shield plays or pauses, over the embed's
// messages (voice/youtubeEmbed.js). If the phone won't start a video for a message rather than a
// tap in the frame, the shield steps aside until it plays, so the next tap reaches YouTube.
function YouTubePlayer({ id, autoplay }) {
  const frameRef = useRef(null);
  const controlRef = useRef(null);
  const blockedTimer = useRef(0);
  const [passThrough, setPassThrough] = useState(false);

  useEffect(() => {
    const control = new EmbedControl(frameRef.current, {
      onChange: (info) => {
        if (!PLAYING.includes(info.playerState)) return;
        clearTimeout(blockedTimer.current);
        setPassThrough(false);
      },
    });
    controlRef.current = control;
    return () => {
      clearTimeout(blockedTimer.current);
      control.destroy();
    };
  }, []);

  const toggle = () => {
    const control = controlRef.current;
    if (!control?.info.ready) {
      setPassThrough(true);
      return;
    }
    if (PLAYING.includes(control.info.playerState)) {
      control.pause();
      return;
    }
    control.play();
    clearTimeout(blockedTimer.current);
    blockedTimer.current = setTimeout(() => {
      if (!PLAYING.includes(control.info.playerState)) setPassThrough(true);
    }, BLOCKED_MS);
  };

  return (
    <div className="youtube-wrapper">
      <iframe
        ref={frameRef}
        src={embedSrc(id, autoplay)}
        title={t('media.youtube.video')}
        allow="autoplay; fullscreen; picture-in-picture"
        allowFullScreen
      ></iframe>
      {!passThrough && <div className="youtube-shield" aria-hidden="true" onClick={toggle} />}
    </div>
  );
}

// A YouTube player, from youtube-nocookie.com (no cookies until the video is played). With
// Settings → Privacy's "Show YouTube videos straight away" off (utils/privacy), a placeholder
// stands in until Play is tapped: nothing, not even a thumbnail, is fetched from YouTube before.
// In an NSFW channel it's covered first (MediaCover), and the player only loads once uncovered.
function YouTubeEmbed({ id, link }) {
  const autoLoad = usePrivacyPrefs().youtubeEmbeds;
  const cover = useMediaCover();
  const [played, setPlayed] = useState(() => playedVideos.has(id));
  if (autoLoad || played) {
    return (
      <MediaCover label={cover} name={t('media.youtube.video')} placeholder={<div className="youtube-wrapper youtube-placeholder" />}>
        <YouTubePlayer id={id} autoplay={played && !autoLoad} />
      </MediaCover>
    );
  }
  const play = () => {
    playedVideos.add(id);
    setPlayed(true);
  };
  return (
    <MediaCover label={cover} name={t('media.youtube.video')}>
      <div className="youtube-wrapper youtube-placeholder">
        <button type="button" className="youtube-placeholder-play" onClick={play} aria-label={t('media.youtube.play')}>
          <FontAwesomeIcon icon={faPlay} />
        </button>
        <div className="youtube-placeholder-text">
          <div className="youtube-placeholder-title">{t('media.youtube.video')}</div>
          <a href={link} target="_blank" rel="noreferrer noopener">{link}</a>
          <div className="youtube-placeholder-hint">{t('media.youtube.hint')}</div>
        </div>
      </div>
    </MediaCover>
  );
}

// Embeds for links in a message: Voicaw guild invites and YouTube videos.
// `encrypted`: the chat is end-to-end encrypted, so invites only load when tapped (see
// InviteEmbed).
export default function UrlPreviews({ text, encrypted = false }) {
  const links = text?.match(URL_PATTERN) ?? [];
  const inviteCodes = [...new Set(links.map(inviteCodeFromUrl).filter(Boolean))];
  const videos = new Map();
  for (const link of links) {
    const id = youtubeVideoId(link);
    if (id && !videos.has(id)) videos.set(id, link);
  }
  return (
    <>
      {inviteCodes.map((code) => <InviteEmbed key={code} code={code} autoLoad={!encrypted} />)}
      {[...videos].map(([id, link]) => <YouTubeEmbed key={id} id={id} link={link} />)}
    </>
  );
}
