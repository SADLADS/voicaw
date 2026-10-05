import React, { useContext, useEffect, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faFile, faDownload } from '@fortawesome/free-solid-svg-icons';
import { parseAttachmentUrl } from '../services/attachmentCrypto';
import {
  loadDecryptedAttachment, getCachedAttachment, loadDecryptedPoster, getCachedPoster,
} from '../services/attachmentCache';
import { canStream, streamUrl, isStreamUrl, streamFailed, releaseStream } from '../services/videoStream';
import { formatBytes } from '../utils/formatBytes';
import { placeholderIdFromUrl } from '../utils/attachmentMarkup';
import { triggerDownload } from '../utils/saveFile';
import { ImageViewerContext } from '../contexts';
import { galleryAround, galleryItemRef } from '../utils/imageGallery';
import { parseGifUrl } from '../utils/gifMarkup';
import { usePrivacyPrefs } from '../utils/privacy';
import { reservedBoxStyle, mediaBoxStyle } from '../utils/mediaBox';
import { useMediaCover } from '../hooks/useMediaCover';
import { t } from '../i18n';
import VideoPlayer from './VideoPlayer';
import MediaCover from './MediaCover';

function kindOf(type) {
  if (type?.startsWith('image/')) return 'image';
  if (type?.startsWith('video/')) return 'video';
  return 'file';
}

// Spans rather than divs throughout: markdown renders images inside <p>.
function FileBox({ name, size, onDownload, status }) {
  return (
    <span className="attachment-file">
      <FontAwesomeIcon icon={faFile} className="attachment-file-icon" />
      <span className="attachment-file-info">
        <span className="attachment-file-name" title={name}>{name}</span>
        <span className="attachment-file-size">
          {status === 'loading'
            ? t('media.attachment.decrypting')
            : status === 'error' ? t('media.attachment.downloadFailed') : formatBytes(size)}
        </span>
      </span>
      <button
        type="button"
        className="attachment-file-download"
        onClick={onDownload}
        disabled={status === 'loading'}
        title={t('media.attachment.download', { name })}
        aria-label={t('media.attachment.download', { name })}
      >
        <FontAwesomeIcon icon={faDownload} />
      </button>
    </span>
  );
}

// An image in a message; clicking (or Enter) opens it in the full-screen viewer, along with
// the message's other images. `item` is its gallery item (utils/imageGallery.js).
// `external`: from another site (a GIF, an old plain link), which isn't told where it's shown.
function ViewableImage({ src, item, style, onError, external = false }) {
  const viewer = useContext(ImageViewerContext);
  const { name } = item;
  const referrerPolicy = external ? 'no-referrer' : undefined;
  if (!viewer) return <img className="attachment-media" style={style} src={src} alt={name} onError={onError} referrerPolicy={referrerPolicy} />;
  const open = (e) => viewer.openImage(galleryAround(e.currentTarget));
  return (
    <img
      ref={galleryItemRef(item)}
      data-gallery-item=""
      className="attachment-media viewable"
      style={style}
      src={src}
      alt={name}
      onError={onError}
      referrerPolicy={referrerPolicy}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open(e);
        }
      }}
    />
  );
}

// An image, behind a cover (MediaCover) if it's a spoiler or in an NSFW channel.
function MediaView({ src, name, size, width, height, spoiler, onDownload, galleryItem }) {
  const [failed, setFailed] = useState(false);
  const cover = useMediaCover(spoiler);
  const style = reservedBoxStyle(width, height);

  if (failed) return <FileBox name={name} size={size} onDownload={onDownload} />;
  return (
    <MediaCover
      label={cover}
      name={name}
      placeholder={<img className="attachment-media" style={style} src={src} alt="" onError={() => setFailed(true)} />}
    >
      <ViewableImage src={src} item={galleryItem} style={style} onError={() => setFailed(true)} />
    </MediaCover>
  );
}

// A video (VideoPlayer), likewise; covered, it's its poster (blurred), without controls.
function VideoView({ spoiler, poster, width, height, ...player }) {
  const cover = useMediaCover(spoiler);
  const placeholder = poster
    ? <img className="attachment-media" style={mediaBoxStyle(width, height)} src={poster} alt="" />
    : <span className="attachment-media attachment-spoiler-blank" style={mediaBoxStyle(width, height)} />;
  return (
    <MediaCover label={cover} name={player.name} placeholder={placeholder}>
      <VideoPlayer poster={poster} width={width} height={height} {...player} />
    </MediaCover>
  );
}

function LocalAttachment({ local, name }) {
  const kind = kindOf(local.type);
  const download = () => triggerDownload(local.previewUrl, name);
  if (kind === 'file') return <FileBox name={name} size={local.size} onDownload={download} />;
  if (kind === 'video') {
    return (
      <VideoView
        src={local.previewUrl}
        name={name}
        size={local.size}
        width={local.width}
        height={local.height}
        duration={local.duration}
        spoiler={local.spoiler}
        onDownload={async () => download()}
      />
    );
  }
  return (
    <MediaView
      src={local.previewUrl}
      name={name}
      size={local.size}
      width={local.width}
      height={local.height}
      spoiler={local.spoiler}
      onDownload={download}
      galleryItem={{ src: local.previewUrl, name, size: local.size, width: local.width, height: local.height }}
    />
  );
}

// An encrypted video: nothing but its poster is downloaded until it's played. A v2 one is then
// streamed through the service worker (services/videoStream.js), a piece at a time, from
// wherever it's played; an older one (or where streaming isn't available) is downloaded in
// full first.
function EncryptedVideo({ url, meta, name }) {
  const [poster, setPoster] = useState(() => (meta.posterUrl ? getCachedPoster(meta) : null));
  const stream = useRef(null);

  useEffect(() => {
    if (!meta.posterUrl || poster) return undefined;
    let live = true;
    loadDecryptedPoster(meta).then((objectUrl) => live && setPoster(objectUrl), (err) => {
      console.error('Failed to load video poster', err);
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  useEffect(() => () => releaseStream(stream.current), []);

  const loadWhole = (onProgress) => loadDecryptedAttachment(url, meta, onProgress);
  const load = async (onProgress) => {
    const whole = getCachedAttachment(url); // e.g. downloaded to save it
    if (whole) return whole;
    if (meta.version === 2 && await canStream()) {
      releaseStream(stream.current);
      stream.current = streamUrl(meta);
      return stream.current;
    }
    return loadWhole(onProgress);
  };
  // Streaming failed (not the video itself): download it whole instead.
  const recover = async (failedSrc, onProgress) => (
    isStreamUrl(failedSrc) && await streamFailed(failedSrc) ? loadWhole(onProgress) : null
  );
  const download = async (onProgress) => triggerDownload(await loadWhole(onProgress), name);

  return (
    <VideoView
      src={getCachedAttachment(url)}
      load={load}
      recover={recover}
      poster={poster}
      name={name}
      size={meta.size}
      width={meta.width}
      height={meta.height}
      duration={meta.duration}
      spoiler={meta.spoiler}
      onDownload={download}
    />
  );
}

// What an encrypted image shows in the chat, synchronously if it's at hand: the file itself
// if it's already decrypted (the sender's own, or opened in the viewer), else its thumbnail.
function cachedImage(url, meta) {
  return getCachedAttachment(url) ?? (meta.posterUrl ? getCachedPoster(meta) : null);
}

// A big image has a thumbnail (`p=`) and shows that: the file itself downloads only when it's
// opened in the viewer, saved or copied. If the thumbnail can't be had, the file it is.
function loadShownImage(url, meta) {
  const whole = () => loadDecryptedAttachment(url, meta);
  return meta.posterUrl ? loadDecryptedPoster(meta).catch(whole) : whole();
}

function EncryptedAttachment({ url, meta, name }) {
  const kind = kindOf(meta.type);
  const covered = Boolean(useMediaCover(meta.spoiler));
  const [state, setState] = useState(() => {
    const cached = kind === 'image' ? cachedImage(url, meta) : getCachedAttachment(url);
    return cached ? { status: 'ready', objectUrl: cached } : { status: 'idle', objectUrl: null };
  });

  // Shows what `loading` resolves to (the file, or an image's thumbnail).
  const load = (loading) => {
    setState((s) => (s.objectUrl ? s : { status: 'loading', objectUrl: null }));
    return loading.then(
      (objectUrl) => {
        setState({ status: 'ready', objectUrl });
        return objectUrl;
      },
      (err) => {
        console.error('Failed to load attachment', err);
        setState({ status: 'error', objectUrl: null });
        return null;
      }
    );
  };

  // Images load as soon as they're rendered; other files only on request.
  useEffect(() => {
    if (kind === 'image' && !state.objectUrl) load(loadShownImage(url, meta));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Always the file itself, never the thumbnail.
  const download = async () => {
    const objectUrl = getCachedAttachment(url) || (kind === 'file'
      ? await load(loadDecryptedAttachment(url, meta))
      : await loadDecryptedAttachment(url, meta).catch((err) => {
        console.error('Failed to download attachment', err);
        return null;
      }));
    if (objectUrl) triggerDownload(objectUrl, name);
  };

  if (kind === 'file') {
    return <FileBox name={name} size={meta.size} onDownload={download} status={state.status} />;
  }
  const galleryItem = { src: url, name, size: meta.size, width: meta.width, height: meta.height, meta };
  if (state.status === 'error') {
    return <FileBox name={name} size={meta.size} onDownload={download} status="error" />;
  }
  if (!state.objectUrl) {
    return (
      <span
        // Still decrypting, but already one of the message's images in the viewer.
        {...(!covered ? { ref: galleryItemRef(galleryItem), 'data-gallery-item': '' } : {})}
        className={`attachment-loading attachment-loading-${kind}`}
        style={reservedBoxStyle(meta.width, meta.height)}
        aria-label={t('media.attachment.loading', { name })}
      />
    );
  }
  return (
    <MediaView
      src={state.objectUrl}
      name={name}
      size={meta.size}
      width={meta.width}
      height={meta.height}
      spoiler={meta.spoiler}
      onDownload={download}
      galleryItem={galleryItem}
    />
  );
}

// GIFs shown since the app was opened, so they stay loaded when the list redraws.
const shownGifs = new Set();

// A GIF from the picker, loaded from Klipy. With Settings → Privacy's "Show GIFs straight away"
// off (utils/privacy), a box of its size waits for a tap on Show, so Klipy learns nothing first.
// In an NSFW channel it's covered too (as a GIF can't be a spoiler): the cover comes off first.
function GifView({ src, name, width, height }) {
  const autoLoad = usePrivacyPrefs().gifs;
  const cover = useMediaCover();
  const [shown, setShown] = useState(() => shownGifs.has(src));
  const style = reservedBoxStyle(width, height);
  if (autoLoad || shown) {
    return <ExternalImage src={src} item={{ src, name, width, height }} style={style} />;
  }
  const show = () => {
    shownGifs.add(src);
    setShown(true);
  };
  return (
    <MediaCover label={cover} name={name}>
      <span className="attachment-gif-hidden" style={style}>
        <span className="attachment-gif-hidden-label">{t('media.attachment.gifFromKlipy')}</span>
        <button type="button" className="btn btn-secondary" onClick={show} aria-label={t('media.attachment.showGif')}>
          {t('media.attachment.show')}
        </button>
      </span>
    </MediaCover>
  );
}

// Another site's image (a GIF, a plain link, a link preview's: LinkMedia), covered in an NSFW
// channel. `onError`: it didn't load.
export function ExternalImage({ src, item, style, onError }) {
  const cover = useMediaCover();
  return (
    <MediaCover
      label={cover}
      name={item.name}
      placeholder={<img className="attachment-media" style={style} src={src} alt="" referrerPolicy="no-referrer" onError={onError} />}
    >
      <ViewableImage src={src} item={item} style={style} onError={onError} external />
    </MediaCover>
  );
}

// Renders a markdown image (`![alt](src)`) from a message: a draft placeholder in a
// pending message, an encrypted attachment, or a plain image URL (legacy uploads and
// external images).
export default function Attachment({ src, alt, localAttachments }) {
  const name = alt || t('media.attachment.defaultName');

  const placeholderId = placeholderIdFromUrl(src);
  if (placeholderId !== null) {
    const local = localAttachments?.[placeholderId];
    return local
      ? <LocalAttachment local={local} name={name} />
      : <span className="attachment-missing">📎 {name}</span>;
  }

  // A GIF from the picker (utils/gifMarkup.js): its size is known, so its box is too.
  const gif = parseGifUrl(src);
  if (gif) return <GifView src={src} name={name} width={gif.width} height={gif.height} />;

  const meta = parseAttachmentUrl(src);
  if (!meta) return <ExternalImage src={src} item={{ src, name }} />;

  if (kindOf(meta.type) === 'video') return <EncryptedVideo url={src} meta={meta} name={name} />;
  return <EncryptedAttachment url={src} meta={meta} name={name} />;
}
