import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useVoice } from '../../hooks/useVoice';
import { useStreamWindow } from '../../hooks/useStreamWindow';
import { closeStreamWindow, setStreamWindowTitle } from '../../voice/streamWindow';
import { displayName, useProfiles } from '../../utils/profiles';
import StreamView from './StreamView';
import { stageOf } from '../../voice/stage';
import { participantName } from '../../voice/voiceClient';
import { t } from '../../i18n';

// What's on the stage (the watched screen share or the focused camera) in its own window
// (voice/streamWindow.js), drawn from Layout so it carries on whichever page you're on. The
// window goes once there's nothing to show.
export default function StreamPopout() {
  useProfiles();
  const container = useStreamWindow();
  const voice = useVoice();
  const stage = stageOf(voice);
  const camera = stage?.kind === 'camera';
  const own = stage != null && stage.id === voice.identity;
  const name = stage == null ? '' : displayName(stage.id, participantName(stage.id));

  useEffect(() => {
    if (container && stage == null) closeStreamWindow();
  }, [container, stage]);

  useEffect(() => {
    if (!container || stage == null) return;
    const kind = camera ? 'camera' : 'stream';
    setStreamWindowTitle(own ? t(`voice.${kind}.ownWindowTitle`) : t(`voice.${kind}.windowTitle`, { name }));
  }, [container, stage?.id, camera, own, name]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!container || stage == null) return null;
  return createPortal(<StreamView key={`${stage.kind}-${stage.id}`} userId={stage.id} name={name} own={own} camera={camera} popout />, container);
}
