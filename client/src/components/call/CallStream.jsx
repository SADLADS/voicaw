import React from 'react';
import { useVoice } from '../../hooks/useVoice';
import { useStreamWindow } from '../../hooks/useStreamWindow';
import { focusCamera, watchStream } from '../../voice/voiceClient';
import { closeStreamWindow } from '../../voice/streamWindow';
import StreamView from '../voice/StreamView';
import StreamTile from '../voice/StreamTile';
import { stageOf } from '../../voice/stage';
import { t } from '../../i18n';

// The stage of a DM or group call (the call panel, while you're in it): the watched screen share
// or the focused camera big (or a note while it's popped out into its own window); a stream
// watched while a camera is focused small under it; and a Watch Stream for every other one.
// `nameOf(id)` names the people in the call. Only watched streams are downloaded.
export default function CallStream({ nameOf }) {
  const voice = useVoice();
  const poppedOut = useStreamWindow() != null;
  const { watching } = voice;
  const stage = stageOf(voice);
  const camera = stage?.kind === 'camera';
  const own = stage != null && stage.id === voice.identity;
  const others = voice.streams.filter((id) => id !== watching && id !== voice.identity);

  return (
    <>
      {stage != null && !poppedOut && (
        <StreamView key={`${stage.kind}-${stage.id}`} userId={stage.id} name={nameOf(stage.id)} own={own} camera={camera} />
      )}
      {stage != null && poppedOut && (
        <div className="stream-popped-note call-stream-note">
          <span className="stream-popped-text">
            {camera
              ? (own ? t('voice.camera.ownPoppedOut') : t('voice.camera.poppedOut', { name: nameOf(stage.id) }))
              : (own ? t('calls.stream.ownPoppedOut') : t('calls.stream.poppedOut', { name: nameOf(stage.id) }))}
          </span>
          <button type="button" className="stream-popped-button" onClick={closeStreamWindow}>{t('calls.stream.bringBack')}</button>
          <button type="button" className="stream-popped-button" onClick={() => (camera ? focusCamera(null) : watchStream(null))}>
            {camera ? t('voice.camera.backToEveryone') : t('calls.stream.stopWatching')}
          </button>
        </div>
      )}
      {camera && watching != null && (
        <div className="call-stream-tile">
          <StreamTile as="div" userId={watching} name={nameOf(watching)} own={watching === voice.identity} />
        </div>
      )}
      {others.map((id) => (
        <div key={id} className="stream-popped-note call-stream-note">
          <span className="voice-live-badge">{t('calls.stream.live')}</span>
          <span className="stream-popped-text">{t('calls.stream.sharing', { name: nameOf(id) })}</span>
          <button type="button" className="voice-tile-watch" onClick={() => watchStream(id)}>{t('calls.stream.watch')}</button>
        </div>
      ))}
    </>
  );
}
