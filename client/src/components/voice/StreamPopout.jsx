import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useVoice } from '../../hooks/useVoice';
import { useStreamWindow } from '../../hooks/useStreamWindow';
import { closeStreamWindow, setStreamWindowTitle } from '../../voice/streamWindow';
import { displayName, useProfiles } from '../../utils/profiles';
import StreamView from './StreamView';
import { t } from '../../i18n';

// The watched screen share in its own window (voice/streamWindow.js), drawn from Layout so it
// carries on whichever page you're on. The window goes once there's nothing to watch.
export default function StreamPopout() {
  useProfiles();
  const container = useStreamWindow();
  const { watching, identity } = useVoice();
  const own = watching != null && watching === identity;
  const name = watching == null ? '' : displayName(watching);

  useEffect(() => {
    if (container && watching == null) closeStreamWindow();
  }, [container, watching]);

  useEffect(() => {
    if (container && watching != null) setStreamWindowTitle(own ? t('voice.stream.ownWindowTitle') : t('voice.stream.windowTitle', { name }));
  }, [container, watching, own, name]);

  if (!container || watching == null) return null;
  return createPortal(<StreamView key={watching} userId={watching} name={name} own={own} popout />, container);
}
