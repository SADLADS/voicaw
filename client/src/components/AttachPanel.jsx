import React, { useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCamera, faClock, faComments, faFile, faImages, faPlus, faSquarePollHorizontal } from '@fortawesome/free-solid-svg-icons';
import { useDeviceMedia, useMediaThumbnail } from '../hooks/useDeviceMedia';
import { useSheetDrag } from '../hooks/useSheetDrag';
import { android, readMedia } from '../utils/android';
import { formatDuration } from '../utils/videoPlayer';
import { t } from '../i18n';

// How close to the grid's end (px) the next page of photos loads.
const LOAD_MORE_PX = 400;

function MediaTile({ item, order, onToggle }) {
  const ref = useRef(null);
  const thumbnail = useMediaThumbnail(item, ref);
  const [reading, setReading] = useState(false);
  const picked = order > 0;

  async function toggle() {
    if (reading) return;
    setReading(true);
    try {
      await onToggle(item, picked);
    } finally {
      setReading(false);
    }
  }

  return (
    <button
      ref={ref}
      type="button"
      className={`attach-tile attach-media${picked ? ' picked' : ''}`}
      onClick={toggle}
      aria-pressed={picked}
      aria-label={item.name}
      aria-busy={reading}
    >
      {thumbnail && <img src={thumbnail} alt="" draggable={false} />}
      {item.duration > 0 && <span className="attach-media-duration">{formatDuration(item.duration / 1000)}</span>}
      <span className="attach-media-check" aria-hidden="true">{picked ? order : ''}</span>
    </button>
  );
}

// Mobile: the + button's panel, docked where the keyboard would be (`height`, like the emoji
// panel; swiped or tapped up to full screen). A camera tile, then the phone's photos and
// videos (the Android app only: a web page can't list them), tapped to attach or take back;
// `picked` lists the gallery ids attached so far, in order. Underneath, a bar: Photos (the
// phone's own picker), Poll, Thread (when `onThread`), Files and Timestamps (`onTimestamp`).
// `onAddFiles(files, { source })` attaches files (`source`: the gallery id), `onRemove(source)`
// takes one back, `onPickFiles(options)` opens the file chooser (useAttachmentDrafts).
export default function AttachPanel({ height, picked, onAddFiles, onRemove, onPickFiles, onPoll, onThread, onTimestamp, onError }) {
  const rootRef = useRef(null);
  const [expanded, setExpanded] = useState(false);
  useSheetDrag({ sheetRef: rootRef, enabled: true, expanded, setExpanded, collapsedHeight: height });
  const media = useDeviceMedia({ enabled: true });
  // Asked once and still refused: Android won't ask again, only its settings can allow it.
  const [refused, setRefused] = useState(false);

  async function askForAccess() {
    if (refused) {
      android.openSettings({ which: 'app' }).catch((err) => console.warn('Could not open settings', err));
      return;
    }
    await media.request();
    setRefused(true);
  }

  async function toggle(item, isPicked) {
    if (isPicked) {
      onRemove(item.id);
      return;
    }
    try {
      onAddFiles([await readMedia(item)], { source: item.id });
    } catch (err) {
      console.warn('Could not read the photo', err);
      onError(t('chat.attachPanel.readFailed', { name: item.name }));
    }
  }

  function onScroll(e) {
    const grid = e.currentTarget;
    if (grid.scrollHeight - grid.scrollTop - grid.clientHeight < LOAD_MORE_PX) media.more();
  }

  const photos = () => onPickFiles({ accept: 'image/*,video/*' });
  const camera = () => onPickFiles({ accept: 'image/*', capture: 'environment' });

  return (
    <>
      <div
        ref={rootRef}
        className={`attach-panel${expanded ? ' expanded' : ''}`}
        style={height && !expanded ? { height: `${height}px` } : undefined}
        role="dialog"
        aria-label={t('chat.attachPanel.label')}
      >
        <button
          type="button"
          className="emoji-picker-handle"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? t('chat.attachPanel.shrink') : t('chat.attachPanel.expand')}
          aria-expanded={expanded}
        />
        <div className="attach-panel-grid" onScroll={onScroll}>
          <button type="button" className="attach-tile attach-action" onClick={camera}>
            <FontAwesomeIcon icon={faCamera} />
            <span>{t('chat.attachPanel.camera')}</span>
          </button>
          {media.access === 'unsupported' && (
            <button type="button" className="attach-tile attach-action" onClick={photos}>
              <FontAwesomeIcon icon={faImages} />
              <span>{t('chat.attachPanel.photos')}</span>
            </button>
          )}
          {media.access === 'none' && (
            <div className="attach-panel-ask">
              <p>{refused ? t('chat.attachPanel.refused') : t('chat.attachPanel.askText')}</p>
              <button type="button" className="btn btn-primary btn-sm" onClick={askForAccess}>
                {refused ? t('chat.attachPanel.openSettings') : t('chat.attachPanel.allow')}
              </button>
            </div>
          )}
          {media.items.map((item) => (
            <MediaTile key={item.id} item={item} order={picked.indexOf(item.id) + 1} onToggle={toggle} />
          ))}
          {media.access === 'some' && media.done && (
            <button type="button" className="attach-tile attach-action" onClick={media.request}>
              <FontAwesomeIcon icon={faPlus} />
              <span>{t('chat.attachPanel.chooseMore')}</span>
            </button>
          )}
        </div>
        <div className="attach-panel-bar">
          <button type="button" onClick={photos}>
            <FontAwesomeIcon icon={faImages} />
            <span>{t('chat.attachPanel.photos')}</span>
          </button>
          <button type="button" onClick={onPoll} disabled={!onPoll}>
            <FontAwesomeIcon icon={faSquarePollHorizontal} />
            <span>{t('chat.attachPanel.poll')}</span>
          </button>
          {onThread && (
            <button type="button" onClick={onThread}>
              <FontAwesomeIcon icon={faComments} />
              <span>{t('chat.attachPanel.thread')}</span>
            </button>
          )}
          <button type="button" onClick={() => onPickFiles()}>
            <FontAwesomeIcon icon={faFile} />
            <span>{t('chat.attachPanel.files')}</span>
          </button>
          <button type="button" onClick={onTimestamp}>
            <FontAwesomeIcon icon={faClock} />
            <span>{t('chat.attachPanel.timestamps')}</span>
          </button>
        </div>
      </div>
      <div className="emoji-picker-spacer attach-panel-spacer" style={height ? { height: `${height}px` } : undefined} aria-hidden="true" />
    </>
  );
}
