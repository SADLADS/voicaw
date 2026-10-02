import React, { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlay } from '@fortawesome/free-solid-svg-icons';
import { youtubeVideoId } from '../utils/youtube';
import { inviteCodeFromUrl } from '../utils/inviteLinks';
import { usePrivacyPrefs } from '../utils/privacy';
import InviteEmbed from './guild/InviteEmbed';

const URL_PATTERN = /https?:\/\/[^\s)]+/g;

// Videos played since the app was opened, so they stay loaded when the list redraws.
const playedVideos = new Set();

// A YouTube player, from youtube-nocookie.com (no cookies until the video is played). With
// Settings → Privacy's "Show YouTube videos straight away" off (utils/privacy), a placeholder
// stands in until Play is tapped: nothing, not even a thumbnail, is fetched from YouTube before.
function YouTubeEmbed({ id, link }) {
  const autoLoad = usePrivacyPrefs().youtubeEmbeds;
  const [played, setPlayed] = useState(() => playedVideos.has(id));
  if (autoLoad || played) {
    return (
      <div className="youtube-wrapper">
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${id}${played && !autoLoad ? '?autoplay=1' : ''}`}
          title="YouTube video"
          allow="autoplay; fullscreen; picture-in-picture"
          allowFullScreen
        ></iframe>
      </div>
    );
  }
  const play = () => {
    playedVideos.add(id);
    setPlayed(true);
  };
  return (
    <div className="youtube-wrapper youtube-placeholder">
      <button type="button" className="youtube-placeholder-play" onClick={play} aria-label="Play YouTube video">
        <FontAwesomeIcon icon={faPlay} />
      </button>
      <div className="youtube-placeholder-text">
        <div className="youtube-placeholder-title">YouTube video</div>
        <a href={link} target="_blank" rel="noreferrer noopener">{link}</a>
        <div className="youtube-placeholder-hint">Playing loads it from YouTube</div>
      </div>
    </div>
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
