import React, { useContext, useState } from 'react';
import '../../assets/css/voice.css';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faClapperboard, faPhoneSlash, faVolumeHigh } from '@fortawesome/free-solid-svg-icons';
import { ConfigContext, InteractionContext } from '../../contexts';
import { useVoice } from '../../hooks/useVoice';
import { useVolumeMenu } from '../../hooks/useVolumeMenu';
import { useStreamWindow } from '../../hooks/useStreamWindow';
import { joinVoice, leaveVoice, watchStream } from '../../voice/voiceClient';
import { closeStreamWindow } from '../../voice/streamWindow';
import { PERMISSIONS, has } from '../../utils/permissions';
import UserAvatar from '../voice/UserAvatar';
import VoiceControls from '../voice/VoiceControls';
import ScreenShareButton from '../voice/ScreenShareButton';
import StreamView from '../voice/StreamView';
import UserVolumeMenu from '../voice/UserVolumeMenu';
import WatchPartyPanel from '../voice/WatchPartyPanel';
import { useWatchParty } from '../../voice/watchParty';
import { HeadphonesIcon, MicIcon } from '../voice/VoiceIcons';
import { displayName, useProfiles } from '../../utils/profiles';
import { t } from '../../i18n';

// A voice channel's page: everyone in it as tiles (ringed while they talk, if you're in there
// too), and joining, or mute/deafen/share screen/disconnect once you're in. On mobile this is
// where you join (tapping the channel only opens it); on desktop clicking the channel already
// joined. Someone sharing their screen is marked Live; once you're in, Watch Stream shows it
// big above the tiles (only watched streams are downloaded), or a note while it's popped out
// into its own window (StreamPopout). Clicking someone else's tile
// while you're in sets how loud they are for you. Watch Together (WatchPartyPanel) takes the
// page once you're in and open it, or while a video is playing; the people become a row.
// Outside, a note says what's playing.
export default function VoiceChannelView({ guild, channel, nameColors }) {
  useProfiles();
  const { voiceEnabled } = useContext(ConfigContext);
  const { isMobile } = useContext(InteractionContext);
  const voice = useVoice();
  const members = channel.voice ?? [];
  const here = voice.channelId === channel.id && voice.status !== 'idle';
  const volumeMenu = useVolumeMenu(here);
  const speaking = new Set(here ? voice.speaking : []);
  const canConnect = has(channel.my_permissions, PERMISSIONS.CONNECT);
  const streams = new Set(here ? voice.streams : []);
  const watched = here && voice.watching != null ? members.find((m) => String(m.user_id) === voice.watching) : null;
  const poppedOut = useStreamWindow() != null;
  const watchedOwn = voice.watching === voice.identity;
  const party = useWatchParty(guild.id, channel.id);
  const [watchOpen, setWatchOpen] = useState(false);
  const streamShown = Boolean(watched && !poppedOut);
  // A watched stream takes the page; the video then plays in its corner player.
  const showWatchParty = here && Boolean(watchOpen || party?.current) && !streamShown;

  let footer;
  if (here) {
    footer = (
      <div className="voice-view-controls">
        <VoiceControls className="voice-view-button" />
        <ScreenShareButton className="voice-view-button" />
        <button
          type="button"
          className={`voice-view-button watch-party-toggle${showWatchParty ? ' active' : ''}`}
          aria-label={t('voice.watchParty.title')}
          aria-pressed={showWatchParty}
          title={t('voice.watchParty.title')}
          disabled={Boolean(party?.current) && !streamShown}
          onClick={() => (streamShown ? watchStream(null) : setWatchOpen((open) => !open))}
        >
          <FontAwesomeIcon icon={faClapperboard} fixedWidth />
        </button>
        <button type="button" className="voice-view-button leave" aria-label={t('guilds.voice.disconnect')} title={t('guilds.voice.disconnect')} onClick={leaveVoice}>
          <FontAwesomeIcon icon={faPhoneSlash} fixedWidth />
        </button>
      </div>
    );
  } else if (!voiceEnabled) {
    footer = <p className="voice-view-note">{t('guilds.voice.notSetUp')}</p>;
  } else if (!canConnect) {
    footer = <p className="voice-view-note">{t('guilds.voice.noPermission')}</p>;
  } else {
    footer = (
      <button type="button" className="voice-view-join" onClick={() => joinVoice(guild.id, channel.id)}>
        {t('guilds.voice.join')}
      </button>
    );
  }

  return (
    <div className={`voice-view${streamShown || showWatchParty ? ' watching' : ''}`}>
      {showWatchParty && (
        <WatchPartyPanel guild={guild} channel={channel} myId={Number(voice.identity)} onClose={() => setWatchOpen(false)} />
      )}
      {!here && party?.current && (
        <p className="watch-party-banner">
          <FontAwesomeIcon icon={faClapperboard} /> {t('voice.watchParty.watchingNow', { title: party.current.title ?? t('voice.watchParty.untitled') })}
        </p>
      )}
      {watched && !poppedOut && (
        <StreamView
          key={watched.user_id}
          userId={watched.user_id}
          name={displayName(watched.user_id, watched.username)}
          own={watchedOwn}
        />
      )}
      {watched && poppedOut && (
        <div className="stream-popped-note">
          <span className="voice-live-badge">{t('guilds.voice.live')}</span>
          <span className="stream-popped-text">
            {watchedOwn ? t('guilds.voice.ownStreamPoppedOut') : t('guilds.voice.streamPoppedOut', { name: displayName(watched.user_id, watched.username) })}
          </span>
          <button type="button" className="stream-popped-button" onClick={closeStreamWindow}>{t('guilds.voice.bringBack')}</button>
          <button type="button" className="stream-popped-button" onClick={() => watchStream(null)}>{t('guilds.voice.stopWatching')}</button>
        </div>
      )}
      {members.length === 0 ? (
        <div className="voice-view-empty">
          <FontAwesomeIcon icon={faVolumeHigh} size="2x" />
          <p>{t('guilds.voice.empty')}</p>
        </div>
      ) : (
        <ul className="voice-view-tiles" aria-label={t('guilds.voice.inChannel', { name: channel.name })}>
          {members.map((m) => {
            const talking = speaking.has(String(m.user_id));
            const live = m.self_stream || streams.has(String(m.user_id));
            const watchable = streams.has(String(m.user_id)) && voice.watching !== String(m.user_id);
            return (
              <li
                key={m.user_id}
                className={`voice-tile${talking ? ' speaking' : ''}${live ? ' live' : ''}`}
                {...volumeMenu.triggerProps(m.user_id, displayName(m.user_id, m.username))}
              >
                <UserAvatar userId={m.user_id} className="voice-tile-avatar" />
                <span className="voice-tile-name" style={nameColors?.[m.user_id] ? { color: nameColors[m.user_id] } : undefined}>
                  {displayName(m.user_id, m.username)}
                </span>
                {(m.self_mute || m.self_deaf || live) && (
                  <span className="voice-tile-icons">
                    {live && <span className="voice-live-badge">{t('guilds.voice.live')}</span>}
                    {(m.self_mute || m.self_deaf) && <span title={t('guilds.voice.muted')} aria-label={t('guilds.voice.muted')}><MicIcon muted /></span>}
                    {m.self_deaf && <span title={t('guilds.voice.deafened')} aria-label={t('guilds.voice.deafened')}><HeadphonesIcon deafened /></span>}
                  </span>
                )}
                {watchable && (
                  <button
                    type="button"
                    className="voice-tile-watch"
                    onClick={(e) => {
                      e.stopPropagation();
                      watchStream(m.user_id);
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    {t('guilds.voice.watchStream')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {volumeMenu.menu && <UserVolumeMenu {...volumeMenu.menu} sheet={isMobile} onClose={volumeMenu.close} />}
      {here && voice.streamError && <p className="voice-view-note voice-view-error" role="alert">{voice.streamError}</p>}
      <div className="voice-view-footer">
        {voice.status === 'connecting' && voice.channelId === channel.id ? <p className="voice-view-note">{t('guilds.voice.connecting')}</p> : footer}
      </div>
    </div>
  );
}
