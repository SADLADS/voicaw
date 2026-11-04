import React, { useContext, useEffect, useState } from 'react';
import '../../assets/css/voice.css';
import { Icon } from '../Icon';
import { faClapperboard, faMusic, faPhoneSlash, faVolumeHigh } from '@fortawesome/free-solid-svg-icons';
import { ConfigContext, InteractionContext } from '../../contexts';
import { useVoice } from '../../hooks/useVoice';
import { useVolumeMenu } from '../../hooks/useVolumeMenu';
import { useStreamWindow } from '../../hooks/useStreamWindow';
import { useFittedTiles } from '../../hooks/useFittedTiles';
import { cameraFocusAction, useCameraFocusKeys } from '../../hooks/useCameraFocus';
import { focusCamera, joinVoice, leaveVoice, watchStream } from '../../voice/voiceClient';
import { stageOf } from '../../voice/stage';
import { closeStreamWindow } from '../../voice/streamWindow';
import { PERMISSIONS, has } from '../../utils/permissions';
import UserAvatar from '../voice/UserAvatar';
import VoiceControls from '../voice/VoiceControls';
import PushToTalkButton from '../voice/PushToTalkButton';
import ScreenShareButton from '../voice/ScreenShareButton';
import CameraButton from '../voice/CameraButton';
import SoundboardButton from '../voice/SoundboardButton';
import CameraVideo from '../voice/CameraVideo';
import { fullScreenStage } from '../../voice/fullScreen';
import StreamView from '../voice/StreamView';
import StreamTile from '../voice/StreamTile';
import UserVolumeMenu from '../voice/UserVolumeMenu';
import WatchPartyPanel from '../voice/WatchPartyPanel';
import { useWatchParty } from '../../voice/watchParty';
import { useSoundEffects } from '../../voice/soundboard';
import { ReactionEmoji } from '../MessageReactions';
import { CameraIcon, EarIcon, HeadphonesIcon, MicIcon } from '../voice/VoiceIcons';
import { displayName, isBot, useProfiles } from '../../utils/profiles';
import { t } from '../../i18n';

// A voice channel's page: everyone in it as tiles (ringed while they talk, if you're in there
// too), and joining, or mute/deafen/share screen/disconnect once you're in. On mobile this is
// where you join (tapping the channel only opens it); on desktop clicking the channel already
// joined. Someone sharing their screen is marked Live; once you're in, Watch Stream shows it
// big above the tiles (only watched streams are downloaded), or a note while it's popped out
// into its own window (StreamPopout). Clicking someone else's tile
// while you're in sets how loud they are for you. Watch Together (WatchPartyPanel) takes the
// page once you're in and open it, or while a video is playing; the people become a row.
// Outside, a note says what's playing. Once you're in, someone whose camera is on shows it in
// their tile (outside, a camera icon says it's on): cameras fill the page, everyone else small
// under them. Clicking a camera focuses it, big like a watched stream, with the people as a row
// (right click or a long press for the volume there); a stream being watched then shrinks into
// the row, still playing. A soundboard sound someone plays pops its emoji up on their tile.
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
  // Its user limit reached (Manage Channels joins anyway, as the server allows).
  const full = !here && channel.user_limit > 0 && members.length >= channel.user_limit &&
    !has(channel.my_permissions, PERMISSIONS.MANAGE_CHANNELS);
  // Joining from here failed (full, or anything else): said here too, where a phone has no
  // voice bar.
  const [tried, setTried] = useState(false);
  const joinError = tried && voice.status === 'idle' ? voice.error : null;
  // A bot that can hear the channel gets an ear (Listen; people all have it by default).
  const listeningBot = (m) => isBot(m.user_id) && m.listening !== false;
  // Without Listen you're there but hear nobody (LiveKit sends you nothing).
  const cantHear = here && !has(channel.my_permissions, PERMISSIONS.LISTEN);
  // Soundboard sounds just played here: their emoji (or a note) pops up on the player's tile.
  const soundEffects = useSoundEffects(here ? channel.id : null);
  const streams = new Set(here ? voice.streams : []);
  const cameras = new Set(here ? voice.cameras : []);
  const member = (id) => members.find((m) => String(m.user_id) === id) ?? null;
  // What's big: the focused camera, else the watched stream.
  const stage = here ? stageOf(voice) : null;
  const stageMember = stage ? member(stage.id) : null;
  const stageCamera = stage?.kind === 'camera';
  const stageOwn = stage?.id === voice.identity;
  const focused = here ? voice.focusedCamera : null;
  // A stream being watched while a camera is on the stage: small, among the people.
  const smallStream = stageCamera ? member(voice.watching) : null;
  const poppedOut = useStreamWindow() != null;
  useCameraFocusKeys(here);
  const party = useWatchParty(guild.id, channel.id);
  const [watchOpen, setWatchOpen] = useState(false);
  // Once a video has played here, the panel stays open after the party ends (its activity log
  // shows who skipped the last one) until closed.
  const playing = Boolean(here && party?.current);
  useEffect(() => {
    if (playing) setWatchOpen(true);
  }, [playing]);
  const streamShown = Boolean(stageMember && !poppedOut);
  // A watched stream takes the page; the video then plays in its corner player.
  const showWatchParty = here && Boolean(watchOpen || party?.current) && !streamShown;

  let footer;
  if (here) {
    footer = (
      <div className="voice-view-controls">
        <VoiceControls className="voice-view-button" />
        <PushToTalkButton className="voice-view-button" />
        <CameraButton className="voice-view-button" />
        <ScreenShareButton className="voice-view-button" />
        <SoundboardButton className="voice-view-button" />
        <button
          type="button"
          className={`voice-view-button watch-party-toggle${showWatchParty ? ' active' : ''}`}
          aria-label={t('voice.watchParty.title')}
          aria-pressed={showWatchParty}
          title={t('voice.watchParty.title')}
          disabled={Boolean(party?.current) && !streamShown}
          onClick={() => {
            if (!streamShown) {
              setWatchOpen((open) => !open);
              return;
            }
            focusCamera(null);
            watchStream(null);
          }}
        >
          <Icon icon={faClapperboard} fixedWidth />
        </button>
        <button type="button" className="voice-view-button leave" aria-label={t('guilds.voice.disconnect')} title={t('guilds.voice.disconnect')} onClick={leaveVoice}>
          <Icon icon={faPhoneSlash} fixedWidth />
        </button>
      </div>
    );
  } else if (!voiceEnabled) {
    footer = <p className="voice-view-note">{t('guilds.voice.notSetUp')}</p>;
  } else if (!canConnect) {
    footer = <p className="voice-view-note">{t('guilds.voice.noPermission')}</p>;
  } else {
    footer = (
      <div className="voice-view-join-area">
        {(joinError || full) && (
          <p className="voice-view-note voice-view-error" role="alert">{joinError ?? t('guilds.voice.full')}</p>
        )}
        <button
          type="button"
          className="voice-view-join"
          onClick={() => {
            setTried(true);
            joinVoice(guild.id, channel.id);
          }}
        >
          {t('guilds.voice.join')}
        </button>
      </div>
    );
  }

  const hasVideo = (m) => cameras.has(String(m.user_id)) && focused !== String(m.user_id);
  const withCamera = members.filter(hasVideo);
  const withoutCamera = members.filter((m) => !hasVideo(m));
  const asRow = streamShown || showWatchParty;

  function renderTile(m) {
    const id = String(m.user_id);
    const talking = speaking.has(id);
    const live = m.self_stream || streams.has(id);
    const watchable = streams.has(id) && voice.watching !== id;
    const video = hasVideo(m);
    const name = displayName(m.user_id, m.username);
    const cameraOn = !video && m.self_video;
    const action = here ? cameraFocusAction({ id: m.user_id, name, own: id === voice.identity, hasCamera: cameras.has(id), focusedCamera: voice.focusedCamera }) : null;
    return (
      <li
        key={m.user_id}
        className={`voice-tile${talking ? ' speaking' : ''}${live ? ' live' : ''}${video ? ' video camera-tile' : ''}${focused === id ? ' on-stage' : ''}`}
        {...volumeMenu.triggerProps(m.user_id, name, action)}
        onDoubleClick={action ? fullScreenStage : undefined}
      >
        {video ? (
          <CameraVideo userId={m.user_id} name={name} own={id === voice.identity} className="voice-tile-video" />
        ) : (
          <UserAvatar userId={m.user_id} className="voice-tile-avatar" />
        )}
        {soundEffects[m.user_id] && (
          <span key={soundEffects[m.user_id].key} className="voice-tile-effect" title={soundEffects[m.user_id].name} aria-hidden="true">
            {soundEffects[m.user_id].emoji ? <ReactionEmoji native={soundEffects[m.user_id].emoji} /> : <Icon icon={faMusic} />}
          </span>
        )}
        <span className="voice-tile-name" style={nameColors?.[m.user_id] ? { color: nameColors[m.user_id] } : undefined}>
          {name}
        </span>
        {(m.self_mute || m.self_deaf || live || cameraOn || listeningBot(m)) && (
          <span className="voice-tile-icons">
            {live && <span className="voice-live-badge">{t('guilds.voice.live')}</span>}
            {cameraOn && <span title={t('guilds.voice.cameraOn')} aria-label={t('guilds.voice.cameraOn')}><CameraIcon /></span>}
            {listeningBot(m) && <span className="voice-listening" title={t('guilds.voice.botListening')} aria-label={t('guilds.voice.botListening')}><EarIcon /></span>}
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
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {t('guilds.voice.watchStream')}
          </button>
        )}
      </li>
    );
  }

  const streamTile = smallStream && (
    <StreamTile
      key="stream"
      userId={smallStream.user_id}
      name={displayName(smallStream.user_id, smallStream.username)}
      own={voice.watching === voice.identity}
    />
  );
  const label = t('guilds.voice.inChannel', { name: channel.name });

  let tiles;
  if (members.length === 0) {
    tiles = (
      <div className="voice-view-empty">
        <Icon icon={faVolumeHigh} size="2x" />
        <p>{t('guilds.voice.empty')}</p>
      </div>
    );
  } else if (asRow || (withCamera.length === 0 && !streamTile)) {
    // Under a stage (cameras first), or everyone's picture.
    tiles = (
      <ul className="voice-view-tiles" aria-label={label}>
        {streamTile}
        {withCamera.map(renderTile)}
        {withoutCamera.map(renderTile)}
      </ul>
    );
  } else {
    tiles = (
      <div className="voice-view-tiles with-video" role="group" aria-label={label}>
        <FittedCameras count={withCamera.length + (streamTile ? 1 : 0)}>
          {streamTile}
          {withCamera.map(renderTile)}
        </FittedCameras>
        {withoutCamera.length > 0 && <ul className="voice-view-others">{withoutCamera.map(renderTile)}</ul>}
      </div>
    );
  }

  return (
    <div className={`voice-view${asRow ? ' watching' : ''}`}>
      {showWatchParty && (
        <WatchPartyPanel guild={guild} channel={channel} myId={Number(voice.identity)} onClose={() => setWatchOpen(false)} />
      )}
      {!here && party?.current && (
        <p className="watch-party-banner">
          <Icon icon={faClapperboard} /> {t('voice.watchParty.watchingNow', { title: party.current.title ?? t('voice.watchParty.untitled') })}
        </p>
      )}
      {stageMember && !poppedOut && (
        <StreamView
          key={`${stage.kind}-${stage.id}`}
          userId={stageMember.user_id}
          name={displayName(stageMember.user_id, stageMember.username)}
          own={stageOwn}
          camera={stageCamera}
        />
      )}
      {stageMember && poppedOut && (
        <div className="stream-popped-note">
          {!stageCamera && <span className="voice-live-badge">{t('guilds.voice.live')}</span>}
          <span className="stream-popped-text">
            {stageCamera
              ? (stageOwn ? t('voice.camera.ownPoppedOut') : t('voice.camera.poppedOut', { name: displayName(stageMember.user_id, stageMember.username) }))
              : (stageOwn ? t('guilds.voice.ownStreamPoppedOut') : t('guilds.voice.streamPoppedOut', { name: displayName(stageMember.user_id, stageMember.username) }))}
          </span>
          <button type="button" className="stream-popped-button" onClick={closeStreamWindow}>{t('guilds.voice.bringBack')}</button>
          <button type="button" className="stream-popped-button" onClick={() => (stageCamera ? focusCamera(null) : watchStream(null))}>
            {stageCamera ? t('voice.camera.backToEveryone') : t('guilds.voice.stopWatching')}
          </button>
        </div>
      )}
      {tiles}
      {volumeMenu.menu && <UserVolumeMenu {...volumeMenu.menu} sheet={isMobile} onClose={volumeMenu.close} />}
      {here && voice.streamError && <p className="voice-view-note voice-view-error" role="alert">{voice.streamError}</p>}
      {here && voice.cameraError && <p className="voice-view-note voice-view-error" role="alert">{voice.cameraError}</p>}
      {cantHear && <p className="voice-view-note">{t('guilds.voice.cantHear')}</p>}
      <div className="voice-view-footer">
        {voice.status === 'connecting' && voice.channelId === channel.id ? <p className="voice-view-note">{t('guilds.voice.connecting')}</p> : footer}
      </div>
    </div>
  );
}

// The cameras, as big as the page lets them be.
function FittedCameras({ count, children }) {
  const ref = useFittedTiles(count);
  return <ul ref={ref} className="voice-view-cameras">{children}</ul>;
}
