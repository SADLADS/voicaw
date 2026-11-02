import React, { useEffect, useRef, useState } from 'react';
import { faCompress, faExpand } from '@fortawesome/free-solid-svg-icons';
import { Icon } from '../Icon';
import { isFullScreen, toggleFullScreen } from '../../voice/fullScreen';
import { t } from '../../i18n';

// Full screen for a camera, as for a watched stream: the button sits in the camera's tile
// (`.camera-tile`, which is what goes full screen, so the name and the mirroring come too) and
// shows on hover (always on touch screens). Its clicks and keys stay off the tile, whose own
// open the volume menu.
export default function CameraFullScreenButton({ name }) {
  const ref = useRef(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const doc = ref.current?.ownerDocument;
    if (!doc) return undefined;
    const changed = () => setFull(isFullScreen(ref.current));
    doc.addEventListener('fullscreenchange', changed);
    return () => doc.removeEventListener('fullscreenchange', changed);
  }, []);
  const label = full ? t('voice.camera.exitFullScreen') : t('voice.camera.fullScreen', { name });
  return (
    <button
      ref={ref}
      type="button"
      className="camera-full-screen"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        toggleFullScreen(e.currentTarget.closest('.camera-tile'));
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <Icon icon={full ? faCompress : faExpand} fixedWidth />
    </button>
  );
}
