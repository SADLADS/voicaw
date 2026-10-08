import React from 'react';
import { useVoice } from '../../hooks/useVoice';
import { useStreamWindow } from '../../hooks/useStreamWindow';
import { watchStream } from '../../voice/voiceClient';
import { closeStreamWindow } from '../../voice/streamWindow';
import StreamView from '../voice/StreamView';
import { t } from '../../i18n';

// Screen shares in a DM or group call (the call panel, while you're in it): the watched one big
// (or a note while it's popped out into its own window), and a Watch Stream for every other
// one. `nameOf(id)` names the people in the call. Only watched streams are downloaded.
export default function CallStream({ nameOf }) {
  const voice = useVoice();
  const poppedOut = useStreamWindow() != null;
  const watching = voice.watching;
  const own = watching != null && watching === voice.identity;
  const others = voice.streams.filter((id) => id !== watching && id !== voice.identity);

  return (
    <>
      {watching != null && !poppedOut && (
        <StreamView key={watching} userId={watching} name={nameOf(watching)} own={own} />
      )}
      {watching != null && poppedOut && (
        <div className="stream-popped-note call-stream-note">
          <span className="stream-popped-text">
            {own ? t('calls.stream.ownPoppedOut') : t('calls.stream.poppedOut', { name: nameOf(watching) })}
          </span>
          <button type="button" className="stream-popped-button" onClick={closeStreamWindow}>{t('calls.stream.bringBack')}</button>
          <button type="button" className="stream-popped-button" onClick={() => watchStream(null)}>{t('calls.stream.stopWatching')}</button>
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
