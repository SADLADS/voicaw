import React, { useState } from 'react';
import { usePrivacyPrefs } from '../utils/privacy';
import { useMediaCover } from '../hooks/useMediaCover';
import { linkFileName } from '../utils/linkPreviews';
import { reservedBoxStyle, mediaBoxStyle } from '../utils/mediaBox';
import { ExternalImage } from './Attachment';
import SiteMediaGate from './SiteMediaGate';
import MediaCover from './MediaCover';
import VideoPlayer from './VideoPlayer';

// Pictures and videos straight from other sites: a link to one, or a guild link preview's.
// Loaded by the reader from that site (no referrer), so it sees their IP address; with
// Settings → Privacy's "Show link previews" off, nothing loads before a tap (SiteMediaGate for
// pictures, Play for videos). Covered in an NSFW channel. `link` is the address in the message
// (it names the file); `url` the file's own.

// Opens in the image viewer; a link that isn't a picture after all (or is gone) draws nothing.
export function SiteImage({ url, link = url, width, height }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  const style = reservedBoxStyle(width, height);
  return (
    <SiteMediaGate url={url} style={style}>
      <ExternalImage
        src={url}
        item={{ src: url, name: linkFileName(link), width, height }}
        style={style}
        onError={() => setFailed(true)}
      />
    </SiteMediaGate>
  );
}

// Our video player; `poster` (another site's picture) only while the setting is on.
export function SiteVideo({ url, link = url, width, height, poster }) {
  const autoLoad = usePrivacyPrefs().linkPreviews;
  const cover = useMediaCover();
  const name = linkFileName(link);
  return (
    <MediaCover
      label={cover}
      name={name}
      placeholder={<span className="attachment-media attachment-spoiler-blank" style={mediaBoxStyle(width, height)} />}
    >
      <VideoPlayer
        {...(autoLoad ? { src: url, poster } : { load: async () => url })}
        name={name}
        width={width}
        height={height}
      />
    </MediaCover>
  );
}
