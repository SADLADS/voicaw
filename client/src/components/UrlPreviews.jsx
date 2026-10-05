import React, { useContext, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlay } from '@fortawesome/free-solid-svg-icons';
import { youtubeVideoId } from '../utils/youtube';
import { eventFromUrl, inviteCodeFromUrl } from '../utils/inviteLinks';
import { linksIn, mediaLinkKind } from '../utils/linkPreviews';
import { usePrivacyPrefs } from '../utils/privacy';
import { useMediaCover } from '../hooks/useMediaCover';
import { useBackCloses } from '../hooks/useBackCloses';
import { InteractionContext } from '../contexts';
import InviteEmbed from './guild/InviteEmbed';
import EventEmbed from './events/EventEmbed';
import MediaCover from './MediaCover';
import YouTubeViewer from './YouTubeViewer';
import { SiteImage, SiteVideo } from './LinkMedia';
import { t } from '../i18n';

// Videos played since the app was opened, so they stay loaded when the list redraws.
const playedVideos = new Set();

// A YouTube player, from youtube-nocookie.com (no cookies until the video is played). With
// Settings → Privacy's "Show YouTube videos straight away" off (utils/privacy), a placeholder
// stands in until Play is tapped: nothing, not even a thumbnail, is fetched from YouTube before.
// In an NSFW channel it's covered first (MediaCover), and the player only loads once uncovered.
// On a phone, as in Discord, the message only holds a preview (the video's thumbnail, from
// i.ytimg.com, or the placeholder): tapping it plays the video full screen (YouTubeViewer).
function YouTubeEmbed({ id, link }) {
  const autoLoad = usePrivacyPrefs().youtubeEmbeds;
  const cover = useMediaCover();
  const { isMobile } = useContext(InteractionContext);
  const [played, setPlayed] = useState(() => playedVideos.has(id));
  const [viewing, showViewer, closeViewer] = useBackCloses('voicawYouTubeViewer');
  const viewer = viewing && <YouTubeViewer id={id} link={link} onClose={closeViewer} />;
  if (isMobile && autoLoad) {
    return (
      <>
        <MediaCover label={cover} name={t('media.youtube.video')} placeholder={<div className="youtube-wrapper youtube-placeholder" />}>
          <button type="button" className="youtube-wrapper youtube-preview" onClick={showViewer} aria-label={t('media.youtube.play')}>
            <img src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`} alt="" loading="lazy" draggable={false} />
            <span className="youtube-preview-play" aria-hidden="true">
              <FontAwesomeIcon icon={faPlay} />
            </span>
          </button>
        </MediaCover>
        {viewer}
      </>
    );
  }
  if (!isMobile && (autoLoad || played)) {
    return (
      <MediaCover label={cover} name={t('media.youtube.video')} placeholder={<div className="youtube-wrapper youtube-placeholder" />}>
        <div className="youtube-wrapper">
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${id}${played && !autoLoad ? '?autoplay=1' : ''}`}
            title={t('media.youtube.video')}
            allow="autoplay; fullscreen; picture-in-picture"
            allowFullScreen
          ></iframe>
        </div>
      </MediaCover>
    );
  }
  const play = () => {
    if (isMobile) {
      showViewer();
      return;
    }
    playedVideos.add(id);
    setPlayed(true);
  };
  return (
    <>
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
      {viewer}
    </>
  );
}

// Embeds the app makes itself for links in a message (those utils/linkPreviews `linksIn`
// finds): Voicaw guild invites and YouTube videos and, in an end-to-end encrypted chat
// (`encrypted`), links straight to a picture or a video, shown from that site (LinkMedia; a
// guild's come from the server's link previews instead, MessageEmbeds). Invites in encrypted
// chats only load when tapped (see InviteEmbed); event links only show in guild channels.
export default function UrlPreviews({ text, encrypted = false }) {
  const links = linksIn(text);
  const inviteCodes = [...new Set(links.map(inviteCodeFromUrl).filter(Boolean))];
  const videos = new Map();
  for (const link of links) {
    const id = youtubeVideoId(link);
    if (id && !videos.has(id)) videos.set(id, link);
  }
  const media = encrypted ? links.filter((link) => !inviteCodeFromUrl(link) && !youtubeVideoId(link) && mediaLinkKind(link)) : [];
  const events = new Map();
  if (!encrypted) {
    for (const link of links) {
      const found = eventFromUrl(link);
      if (found && !events.has(found.eventId)) events.set(found.eventId, found);
    }
  }
  return (
    <>
      {inviteCodes.map((code) => <InviteEmbed key={code} code={code} autoLoad={!encrypted} />)}
      {[...events.values()].map((e) => <EventEmbed key={e.eventId} guildId={e.guildId} eventId={e.eventId} />)}
      {[...videos].map(([id, link]) => <YouTubeEmbed key={id} id={id} link={link} />)}
      {media.length > 0 && (
        <div className="message-files">
          {media.map((link) => (mediaLinkKind(link) === 'image'
            ? <SiteImage key={link} url={link} />
            : <SiteVideo key={link} url={link} />))}
        </div>
      )}
    </>
  );
}
