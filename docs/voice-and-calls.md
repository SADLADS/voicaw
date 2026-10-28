# Voice channels and calls

## Voice channels (LiveKit)

A voice channel's audio goes through a self-hosted LiveKit server (an SFU: it forwards each
person's audio to the others, it doesn't mix or decode; setup in `README.md`). Not end-to-end
encrypted, like the rest of a guild. The API decides who may join and keeps track of who's in;
LiveKit carries the audio.
- **Server** (`server/voice.js`, `routes/voice.js`): each voice channel is LiveKit room
  `channel-<id>`, each participant's identity their user id. `POST
  /guilds/:g/channels/:c/voice` (View Channel + Connect) returns `{ url, token }`: a 10 minute
  LiveKit token for that room (LiveKit keeps it fresh once connected), publishing only the
  microphone, and only with Speak, and hearing the others only with **Listen** (2026-10-05,
  `canSubscribe`: everyone has it through @everyone unless taken away; bots only when given it,
  see Voice in `docs/bots.md`; without it the call view says you can't hear the channel). One
  voice channel per user: getting a token for another
  removes you from the first. Who's actually in comes from LiveKit's **webhooks** (`POST
  /livekit/webhook`, signed with the API key of the region's server, see Voice regions):
  joined/left/room finished. The state is in memory
  (`states`), rebuilt from LiveKit's room list when the API starts (`restoreFromLiveKit`, only
  when run as the server). A "left" only counts for the session (sid) that's in, since joining
  from a second device replaces the first. After any guild change (`announceGuildUpdate`) and
  when a member is removed, `enforceGuild` disconnects whoever lost View/Connect and gives or
  takes away Speak, Video and Listen live (a change of Listen is announced too). Self mute/deafen: `PUT /voice/state` (kept in LiveKit participant
  attributes too, so a restart keeps them); `DELETE /voice` leaves. Everyone who can see the
  channel gets `guild_voice_state { guildId, channelId, userId, state }` (`state` null: left),
  and a voice channel in the layout has `voice: [{ user_id, username, self_mute, self_deaf,
  self_stream, listening }]`. `GET /guilds` gives each guild `voice: { [channelId]: [userId] }`, who's in
  the voice channels you can see (`guildVoiceFor`), for guilds whose layout isn't loaded yet.
- **Guild rail speaker**: a guild with someone in a voice channel you can see gets a speaker on
  its rail icon (`Sidebar`), grey, or `--vc-online` green when you're in voice there (on any
  device, or this one from the moment it starts joining); it sits above a mention badge. The
  map behind it is `useGuildList`'s `guildVoice`, kept for every guild: seeded from the list,
  replaced by a layout when one loads, moved by `guild_voice_state`, refetched after a reconnect.
  Without `LIVEKIT_*` settings voice is off: `/api/config` says `voiceEnabled: false`, joins 503.
- **Client** (`voice/voiceClient.js`, read with `hooks/useVoice.js`): one connection per
  device, a module-level store like `ws-client`. `livekit-client` is loaded on the first join
  (it's big). Joining must come from a click (browsers play sound only after one). Muted, the
  mic is released (`stopMicTrackOnMute`, the browser's recording light goes off; it's a publish
  option, in `publishDefaults`: as a Room option LiveKit ignored it until 2026-10-06); deafened,
  everyone's playback volume is 0 and you're muted too; unmuting undeafens (Discord's rules). Mute
  and deafen are remembered per device (`localStorage voicePrefs`) and work outside a call.
  Everything that turns the mic on or off (mute, deafen, Speak, a mic or processing change)
  runs one at a time (`queueMicrophone`), each reading the state when its turn comes: side by
  side, a mute during an unmute's capture (a slow mic, the browser's permission prompt) found
  nothing to turn off (LiveKit's `isMicrophoneEnabled` is false until the track is published)
  and the unmute then went live: muted, and still heard. Turning it off always asks LiveKit
  (which waits for a publish, or its republish after a reconnect, under way), and it's
  checked again after a reconnect and whenever the mic is (re)published. Muted, our chain's
  output (what's actually sent) is switched off too, not only the mic.
  `voice/voiceClient.test.js` covers this and deafen below; `e2e/voice.mjs` unmutes and mutes
  at once with a slow mic and asks LiveKit itself.
  Being removed, or joining the same channel elsewhere, ends it with a message in the voice bar.
- **Who's talking** (`speaking`, the green rings; `voice/speaking.js`): measured on the device,
  not taken from LiveKit's active speakers (its server sends those every 400 ms or so, smoothed:
  the ring lit about half a second after someone started and stayed most of a second after they
  stopped). Each voice gets an AnalyserNode: everyone else's microphone track as received (in
  `playback`, or an AudioContext of its own where voices play from elements), ours as sent
  (LiveKit's local track is the processed one, after the gate, so a closed gate is silence).
  They're read every 50 ms: talking from the moment a voice reaches -50 dB until it's been
  below that for 250 ms (the pauses between words don't flicker it). With our microphone off we
  aren't talking at once. Voices that can't be measured (not yet subscribed, or the
  AudioContext waiting for a click) fall back to LiveKit's list. Deafened, you still see the
  rings (the meters read the tracks, not the volume). `e2e/speaking.mjs` times it against the
  audio received: about 30 ms to light, 300 ms to go out (LiveKit's took 500 and 650).
- **Playback** (`voiceClient`): others' voices play through Web Audio, LiveKit's `webAudioMix`
  in our own AudioContext (`playback`, one per connection, its `setSinkId` the chosen speakers;
  LiveKit's own context would miss the speakers chosen before joining): each remote track gets
  its own GainNode (`track.setVolume`), so volumes can go past 100%. Its `<audio>` element
  stays attached but muted (Chrome only feeds a remote stream to Web Audio while it plays). Where
  the browser can pick speakers for elements but not for an AudioContext (Firefox) it plays
  from the elements instead, capped at 100% (`userVolumes.js` `canBoostVolume`; there the
  per-user and stream volume sliders stop at 100%, `maxUserVolume`). `applyVolumes` sets every track to
  `playbackVolume` (`userVolumes.js`: 0 deafened, else output volume × the person's volume, or
  their stream's volume for a screen share's sound) on any change. Through Web Audio that's a
  GainNode of ours that LiveKit puts before its own (`setWebAudioPlugins`), not LiveKit's
  `setVolume`: LiveKit rebuilds a track's graph now and then and only re-applies a volume that
  isn't 0 (and fades towards 0 without reaching it), so a deafened listener heard people
  again. Through elements it's `setVolume` and `muted`, again after LiveKit restarts the audio
  (which unmutes elements).
- **Per-user volume** (like Discord's User Volume; `voice/userVolumes.js`, per device,
  `localStorage userVolumes`, by user id, 0–200%, the same for channels and calls): click (or
  right-click, Enter) someone else in a voice channel's list in the sidebar, their tile, or the
  DM/group call panel, once you're in that channel or call (`hooks/useVolumeMenu.js`), for
  `voice/UserVolumeMenu.jsx`: a slider, Reset and Copy User ID, floating on a computer (placed like
  `ContextMenu`, `utils/menuPlacement.js`), a sheet on a phone. Applied live.
- **Stream volume** (like Discord's Stream Volume): a screen share's sound has its own volume per
  sharer, apart from their voice's (`userVolumes.js` `streamVolumes`, `localStorage
  streamVolumes`, 0–200%, per device), set in the watched stream's bar (`StreamView`, popped out
  too): a speaker button mutes it (unmuting goes back to the volume it had) and a slider beside
  it (shown on hover or focus on a computer, always on a phone). Not on your own stream (you
  don't hear it); greyed out while deafened.
- **Lost connections** (voice channels; `voice/rejoin.js`): the bar says "Reconnecting…"
  (LiveKit's `Reconnecting` and `SignalReconnecting`, the latter being a signalling-only resume,
  e.g. after a phone's app was in the background). LiveKit's own retries can take minutes to
  give up and can't get in with an expired token, so after 15 s (`TAKE_OVER_AFTER_MS`), or once
  it gives up with a reason that isn't meant (`shouldRejoin`: not left, removed, replaced or
  room gone), `voiceClient` drops it and joins the channel again with a new token, backing off
  (0, 1, 2, 5, 10 s) for up to 5 minutes; an API refusal (`joinRefused`) stops it. Phones only
  try while the app is visible (iOS stops a page's microphone and connection in the background)
  and, back in view after over 10 s with the connection still recovering, rejoin at once. Each
  join is capped at 20 s (LiveKit's `connect` can loop forever when WebSockets are blocked but
  its HTTP answers). A `Disconnected` before a room finished joining is a failed join, handled
  by `connect` (`joinedRooms`). DM and group calls don't rejoin (their token and key come from
  `callClient`).
- **Screen sharing** (guild voice channels, with Video; DM and group calls always, see Screen
  sharing in calls under DM calls): the token lets you publish
  `screen_share` and `screen_share_audio` (and `camera`, see Cameras) only with Video (`publishPermission`), and
  `enforceGuild` changes that live (LiveKit then ends a stream that's no longer allowed; the
  client lets go of the capture). Who's live (`self_stream`) comes from LiveKit's
  `track_published` / `track_unpublished` webhooks (screen share tracks of the session that's
  in), so it's what LiveKit really carries. Client: `startScreenShare` (from a click; the
  browser asks what to share and whether with its sound; at the chosen quality, see Stream quality)
  shows your own stream at once. **A shared screen's sound never carries Voicaw's own** (the
  call's voices, our sounds; like Discord): the sound is asked for with `restrictOwnAudio`
  (Chromium 140+ and the desktop app, Windows and macOS; others ignore it). Chrome does it by
  leaving all of Chrome out of the system sound, so a whole-screen share also loses other
  tabs' sound (sharing that tab still carries it; Linux browsers have no system sound to
  share); `stopScreenShare`, also noticed when the browser's own "Stop
  sharing" ends it. **Nobody downloads a stream they aren't watching:** `voiceClient` connects
  with `autoSubscribe: false` and `syncSubscriptions` subscribes every microphone, and a screen
  share (and its sound) only for the one person `watching` (`watchStream(id)`; `attachStream`
  plays it in a `<video>`). The stream's sound plays like the others' (deafen mutes it), at its
  own volume (Stream volume, above). **Who's watching** (2026-10-20, like Discord's viewers): LiveKit
  never tells anyone who subscribed, so each client says whose stream it watches (`PUT
  /voice/watching { watching: user id | null }`, from `voiceClient` `reportWatching` once per
  change and LiveKit session; never for your own preview) and the server sets it as the
  participant's `watching` attribute (`voice.js` / `calls.js` `setWatching`, through LiveKit's
  RoomService like mute and deafen; a channel's before its "joined" webhook is applied then).
  The server keeps nothing itself: the attribute lives in LiveKit and goes with the session
  (the token still can't set attributes). Clients read everyone else's into `watchers`
  (`{ streamer: [{ id, username }] }`, live streams only, never you), and `StreamView` shows an
  eye, the count and up to three pictures in the stream bar (only the count in the corner and on
  phones), a click listing their names; the sharer's own preview shows it too. Calls the same
  (the attribute isn't encrypted, but LiveKit knows who downloads each stream anyway; said in
  the privacy policy). `e2e/streamwatchers.mjs` checks it. UI: a
  Live badge in the channel list and on tiles, Watch Stream on a live tile once you're in, the
  stream big above the tiles (`voice/StreamView.jsx`: full screen, stop watching; the people
  become a row; pop out and the corner, below), and the share button (`voice/ScreenShareButton.jsx`) in the voice bar and the
  channel page. Not offered where the browser has no `getDisplayMedia` (phones, which can
  still watch). The desktop app shows our own picker first (`voice/ScreenPicker.jsx`, see
  Desktop app).
  **Zoom** (on this device only, to read small text on a shared screen): the wheel zooms on
  the point under the pointer (never scrolling the page), two fingers pinch, a drag looks
  around a zoomed stream (never past the picture's edge; a side still shorter than the stage
  may move inside it, so the wheel's point stays put), and the stream bar has zoom out, a
  slider (100%–800% in powers of two, shown on hover like the volume's) and zoom in, then the
  percentage while zoomed, which fits it again. A phone's bar has no room: there only the
  percentage, floating above the bar. Popped out too; not in the corner (it's dragged there);
  every stream starts fitted. `hooks/useStreamZoom.js` (a view is the image viewer's `{ scale,
  x, y }`, `utils/imageZoom.js`, against the video's fitted size); `e2e/streamzoom.mjs`.
  **The corner** (like Watch Together's player, and Discord's): someone else's stream you're
  watching, once no page shows it (you went to another channel, conversation or page), plays
  small in a corner (`voice/StreamCorner.jsx`, drawn from Layout; bottom right, on a phone top
  right under the header, until dragged elsewhere) with whose it is, its volume, Go to the voice channel (or the call),
  Pop out and Stop watching. Pages showing it (`StreamView` on the channel page, a call panel)
  say so (`hooks/useStreamOnPage.js`), and the corner steps aside. Not your own stream, which
  you can see on your screen. It sits in `.corner-players` above Watch Together's mini player,
  so both fit. **Dragged** (like Discord's picture in picture; `hooks/useCornerDrag.js`): the
  column moves as one, from anywhere on the players but their controls (a mouse or a finger;
  under 6 px is a click), and snaps to the nearest of the screen's four corners when let go,
  kept on the device (`localStorage pipCorner`; bottom right, on a phone top right, until
  then). On a computer the left corners keep inside the page's content (`--vc-pip-left`,
  measured from the content pane), clear of the rail, channel list, voice bar and user panel;
  on a phone the bottom corners cover part of the message box (as the person chose). While a page shows a stream, a bottom corner moves to the top on the same side, so
  Watch Together's mini player doesn't cover the stream's bar or the call's buttons. On a
  phone the corner's volume is just the mute button (no room for the slider). DM and group
  calls' streams go there too. `e2e/streamcorner.mjs` checks it all, Watch Together's pop-out
  included.
  **Pop out** (computers, like Discord's): the stream in a window of its own
  (`voice/streamWindow.js`, on `voice/popoutWindow.js`, shared with Watch Together's), to put
  on another screen, maximise or make full screen. It's a
  blank window opened from the click (`window.open('', 'voicaw-stream')`; a blocked pop-up
  says so), with the page's stylesheets copied in (and any added later) and `<html>`'s theme
  attributes kept in step; `StreamPopout` (drawn from Layout, so it carries on on every page)
  renders `StreamView` into it with a portal, playing the same LiveKit track (nothing more is
  downloaded). The channel page shows a note instead (Bring back, Stop watching); the corner
  shows nothing. Closing the window or Bring back puts the stream back on the page (or the
  corner); Stop watching, the stream ending,
  leaving voice or the page going (reload, logout) closes it. The desktop app allows exactly
  this window (see Desktop app).
  Bandwidth: the sharer uploads once; LiveKit sends a copy to each viewer.
- **Stream quality** (like Discord's): the sharer picks a resolution (720p, 1080p, or Source,
  the screen's own size) and a frame rate (15, 30, 60 fps) before going live: in a browser a
  small dialog (`voice/GoLiveDialog.jsx`) whose Go Live click then opens the browser's picker,
  in the desktop app beside its screens (`ScreenPicker`), and as the default in Settings →
  Voice & video (`StreamQualityPicker`, all three). Remembered per device
  (`voice/streamSettings.js`, `localStorage streamSettings`); 1080p at 15 fps (what LiveKit sent
  by default) until changed. `screenShareOptions` turns it into the capture (`getDisplayMedia`
  width/height `max` keeping the screen's shape, never enlarged; frame rate `max`; passed with
  `resolution: { width: 0, height: 0 }`, since without a `resolution` LiveKit puts its own
  1080p30 over ours: that 1080p cap is also why Source was never above 1080p before), a content
  hint (15 fps `detail`: text stays sharp and the frame rate drops first when the connection
  is short; 30/60 `motion`: the resolution drops first) and the encoder's `screenShareEncoding`
  (maxBitrate from a table, 1.5 Mbps for 720p15 to 10 Mbps for Source at 60; maxFramerate).
  It applies from the next Go Live, not to a running stream. **Simulcast:** LiveKit sends every screen share
  twice (its default, which we keep): full size and half the width and height at the same frame
  rate and a quarter of the bitrate (about 25% more upload and encoding for the sharer).
  LiveKit's server moves a struggling viewer to the small copy on its own. **Viewers' quality**
  (2026-10-27): the stream bar's Stream quality menu (`StreamView` `StreamQuality`; not in the
  corner, no room; not on your own stream) picks which copy this device downloads: Auto (the
  full size, LiveKit still dropping to the small copy while the connection can't keep up; what
  everyone got before) or Data saver (always the small copy: half the width and height, about a
  quarter of the data), and says what size is arriving (the `<video>`'s own size). One choice for
  every stream, remembered per device (`voice/streamViewSettings.js`, `localStorage
  streamViewQuality`); `voiceClient` `applyStreamQuality` asks LiveKit with `setVideoQuality`
  (HIGH or LOW) once the stream is subscribed, and again on a change. Calls' streams the same.
  The sharer's choice still decides the copies: Data saver of a 720p stream is 360p, of a 4K
  Source one 1080p. `e2e/streamviewquality.mjs` checks it. **Admin limit:** Settings → Admin's Screen share resolution limit and
  frame rate limit (`appSettings.js` `streamMaxResolution` / `streamMaxFramerate`, no limit by
  default) come with the join token (`streamLimit`, `voice.js` `joinToken`; so from people's
  next join); the pickers grey out what's above them and say so, and a choice above goes out
  at the limit. It's kept by the client: LiveKit can't cap a track's bitrate, so a modified
  client could send more.
- **Cameras** (voice channels with Video, like Discord's one permission for both; DM and
  group calls always, `calls.js` `tokenFor` `canCamera`; never bots): your camera goes out as
  LiveKit's `camera` track, captured at 720p 30 fps (`voice/videoSettings.js` `cameraOptions`:
  the camera chosen in Settings → Voice & video, else the front one) and sent in three sizes
  (simulcast: 180p, 360p, 720p). `startCamera` / `stopCamera` (`voice/CameraButton.jsx`, in the
  voice bar, the channel page and the call panels); off means unpublished, not muted, so the
  camera's light goes off. It's not remembered between joins (off on every join, like
  Discord), but comes back after a rejoin of a lost channel connection (`cameraWanted`). Taking
  Video away turns it off (LiveKit unpublishes it; the client lets go). Who has a camera on
  (`self_video`, also in bots' voice states) comes from the `track_published` /
  `track_unpublished` webhooks like Live, and shows as a camera icon in the channel list and on
  tiles seen from outside. **Nobody downloads a camera that isn't on their screen:**
  `voice/CameraVideo.jsx` registers its `<video>` with `showCamera(id, element)`;
  `syncSubscriptions` subscribes a camera only while at least one element shows it and the page
  isn't hidden, and `setVideoDimensions` asks for the size of the biggest one (a ResizeObserver
  keeps it current), so LiveKit sends the smallest layer that fills it (a 500 px tile gets
  360p). LiveKit's own `adaptiveStream` does this too, but it pauses every video while the page
  is hidden or an element isn't in its viewport, which would freeze a stream watched in its
  pop-out window, so it isn't used. In a voice channel, a camera fills its tile (16:9, name and
  icons over it; tiles grow while any camera is on); in a call it replaces the person's picture
  in the panel. Your own is mirrored, as in a mirror (others see it the right way round),
  except a phone's back camera. **Front and back** (2026-10-27): on a phone or tablet
  (`isMobileDevice`), a Switch camera button sits next to the camera's while it's on;
  `switchCamera` restarts the same track (`restartTrack`, which lets the old camera go first:
  phones open one at a time) with `facingMode` the other way, so nothing is published again.
  The side (`cameraFacing`) overrides the camera chosen in Settings and is kept through turning
  the camera off and on and rejoins, until leaving; choosing a camera in Settings drops it. If
  the other camera fails, it goes back to the one it had and shows the error. In
  calls the video is end-to-end encrypted with the call's key like the audio (LiveKit's E2EE
  covers every track; `e2e/camera.mjs` asks LiveKit). Settings → Voice & video: the camera (a
  list, named once the page may use the camera) and Test camera, a mirrored preview captured
  only while testing (`CameraSettings.jsx`). The desktop app allows the camera for its own
  pages; the Android app asks for it when first used, and Android stops it while the app is in
  the background. Bandwidth: each viewer gets one copy per camera they show, at most 720p
  (about 1.5 Mbit/s; 360p about 0.5).
- **Microphone chain** (`voice/voiceChain.js`): the browser captures with echo cancellation and
  auto gain (its own noise suppression and `voiceIsolation` only when that's the one chosen:
  two suppressors in a row sound worse); then our own LiveKit audio processor runs the mic
  through Web Audio stages: the input volume (`inputGainStage`), then noise suppression and the
  gate (`voice/noise/noiseStages.js` `voiceProcessingStage`). The processor is set on the track
  after the mic is on (LiveKit applies capture-time processors before the track has its
  AudioContext), and it keeps the AudioContext from `init`, because LiveKit calls `restart`
  (after an unmute, a mic change or `restartTrack`) without one; every (re)build reads the
  settings afresh. RNNoise and DeepFilterNet only work at 48 kHz, so when LiveKit's context
  runs at another rate (the device's, often 44.1 kHz) the chain makes its own 48 kHz one.
- **Noise suppression and the gate** (`voice/noise/`, all on the device: nothing is sent
  anywhere, no third party; Discord's Krisp needs LiveKit Cloud or a licence). Modes
  (`audioSettings` `noiseSuppression`): **Standard** (default) is RNNoise, Xiph's small network,
  ~150 KB of WebAssembly from `@sapphi-red/web-noise-suppressor` (only its `.wasm` files; its
  own worklet throws away the speech probability), driven directly by `rnnoise.js`; **Strong**
  is DeepFilterNet 3 (Krisp-like: removes typing even while you talk), our own build of its
  `libDF` WebAssembly with the model compiled in (`noise/deepfilter/`, 17 MB, 10 MB gzipped,
  not precached: it downloads the first time someone picks Strong; computers only,
  `canSuppressStrongly`); **Browser** is the browser's own (good for fans, lets typing
  through); **Off**. Two AudioWorklets (bundled with Vite's `?worker&url`, each module added
  once per AudioContext, WebAssembly compiled once per page and passed in): `voiceWorklet.js`
  runs RNNoise on every 10 ms frame in every mode (`frames.js` reblocks the worklet's
  128-sample blocks), sends its denoised audio for Standard (and for Strong when DeepFilterNet
  isn't there), then the **gate** (`gate.js`, Discord's input sensitivity): automatic opens on
  RNNoise's speech probability (two frames of ≥0.6 in a row: a key click can score one frame
  that high, never two; stays open while ≥0.3), or by hand on loudness above a threshold in dB
  (-100: always open); it looks two frames ahead (opens from the frame before speech), holds
  300 ms and fades, so 30 ms of delay in all. `deepFilterWorklet.js` comes before it for
  Strong (`workletPolyfills.js` gives the glue the TextDecoder and crypto a worklet lacks); it
  times itself and, if a device can't keep up (over 80% of each frame's time for 3 s), steps
  aside for RNNoise (`isDeepFilterSlow`, Settings says so). It costs about half a core of this
  server's Intel N100 (RNNoise ~2%). Anything that fails to load leaves the audio as it was, so
  the mic never goes silent over it. Gate settings reach running worklets at once; a mode
  change re-captures (`processingChanged`). `scripts/build-deepfilternet.sh` rebuilds
  `deepfilter/` from DeepFilterNet's source at a pinned commit, with
  `scripts/deepfilternet-wasm.patch` (adds `df_create_default` and `df_destroy`); needs Rust
  with the wasm32 target and wasm-pack, ~12 min. `e2e/noise.mjs` renders a made-up recording
  (fan, key clicks, voice) through every mode and measures it.
- **Voice settings** (`voice/audioSettings.js`, Settings → Voice & video, `VoiceSettings.jsx`;
  per device, `localStorage audioSettings`; the camera is `videoSettings`, see Cameras):
  input device (not on phones and tablets, `canChooseInput`: they always use the default, the
  system moving it to a headset, and one saved before is ignored there) and output device
  (only where the browser has `setSinkId`). Browsers hide device names until the page may use
  the microphone, listing one placeholder per kind with no id instead: those are left out, so
  the lists show only Default and "Allow it" (a brief capture) fetches the names. The desktop
  app allows the microphone, so it has them from the start (its permission check compares the
  origin without the trailing slash Electron adds to the microphone's, `isAppOrigin`). Input volume
  (0–200%, a gain in the microphone chain, changed live) and output volume (0–100%, a factor
  in every voice's playback volume, see Playback), echo cancellation, noise suppression (Standard, Strong, Your
  browser's, Off; see above), input sensitivity (Automatic, or a dB slider over a meter of the
  level the gate sees, green while open, during the mic test) and automatic gain control
  (`captureOptions`; devices as `{ ideal }`, so an unplugged one falls back to the default).
  Saved `noiseSuppression: true/false` from before the modes reads as Standard/Off. `voiceClient` applies a change at once: speakers through
  LiveKit's `switchActiveDevice`; a new microphone or processing re-captures it
  (`restartTrack`), or while muted drops the track so unmuting captures it afresh. A mic test
  (`voice/micTest.js`, like Discord's "Let's Check"): the microphone as a call would send it,
  through the same noise suppression and gate (in its own 48 kHz context), a level meter
  (`levelOf`), played back through the chosen speakers. While it runs you're muted and
  deafened, in a call too (`setMicTesting`, 2026-10-07: a call doesn't hear the test, nor play
  over it): the buttons and shortcuts are held (`micTesting`), the device keeps remembering
  the mute and deafen from before, and those come back when the test stops. The app's sounds play
  through the chosen speakers too (`AudioContext.setSinkId`). Browsers name devices only once
  the page may use the microphone ("Allow it"). Each remote voice's `<audio>` element is kept
  per track (`audioElementsByTrack`): LiveKit has often detached it already by the time it
  says the track is gone, so `detach()` alone left empty elements behind.
- **Push to talk** (built 2026-10-27, as Discord's; `voice/pushToTalk.js`, keys in
  `voice/pushToTalkKeys.js`): Settings → Voice & video → Input mode is Voice activity (the
  default: the gate decides) or Push to talk, per device (`audioSettings` `inputMode`,
  `pushToTalkKey`, `pushToTalkDelay`). The key is one key or mouse button, no combinations,
  saved as `KeyboardEvent.code` (layout-independent; "Mouse3"-"Mouse5" for middle, back and
  forward): any key but Escape, Backspace, Enter and Tab, recorded from the next press
  (Escape cancels, Backspace clears; choosing Push to talk with none set starts recording).
  The release delay (0–2000 ms, default 20, Discord's) keeps sending after it's let go.
  What's sent is cut by a gain at the end of the microphone chain (`pushToTalkStage`, ramps
  of a few ms, no clicks), not by muting: the microphone stays captured (its light stays on,
  as Discord's), so the first word isn't lost to starting it, and the gate is held open
  (`gateOptions`: the key decides, not loudness; Settings says so under Input sensitivity).
  Our own green ring follows, since it's measured on what's sent. Mute and deafen still win.
  Talking lasts while any **source** is held: `key` (the page's own listener, on `window`,
  capture phase, while Voicaw has focus; a blur lets go, since the release won't be seen;
  typing the key in a box still types it; the back and forward buttons don't navigate),
  `button` (`PushToTalkButton`, hold to talk, in the voice bar under its buttons and in the
  voice channel and call views, for phones and anyone without a key: pointer capture,
  Space/Enter, greyed out while muted) and `desktop` (the desktop app's keyboard hook, in
  other apps too: see Push to talk in other apps in `docs/desktop-and-site.md`). Sounds
  Push to talk on/off (Settings → Sounds) mark it starting and stopping to send, only while
  that's heard (connected, Speak, not muted). The mic test isn't held back by it.
  `voice/pushToTalk.test.js`, `components/voice/PushToTalkButton.test.jsx`;
  `e2e/pushtotalk.mjs` checks what LiveKit receives.
- **UI:** in the channel list, people in a voice channel are listed under it (ringed while
  talking, when you're in there too). Clicking a voice channel joins it on desktop; on mobile a
  tap only opens it and you join from its page (`guild/VoiceChannelView.jsx`: tiles, outlined while talking, not their pictures; Join Voice,
  mute/deafen/share screen/disconnect). `voice/VoiceBar.jsx` sits above the user panel while
  connected, in two rows as Discord's (2026-10-24): the state (a signal in a tile tinted green, or
  orange while connecting), the channel link and Disconnect; then the chat, camera and share
  screen as equal buttons across the width (tinted while on). It's the top of the docked user
  card (phones too, since 2026-10-26), one card with a line between; errors and notes follow
  under the buttons.
  `UserPanel` has mute and deafen
  (`voice/VoiceControls.jsx`). A guild reopens on its last *text* (or list) channel.
- **Watch Together** (YouTube watch parties, like Discord's activity): everyone in a voice
  channel plays the same YouTube video at the same point. A guild can connect its own Jellyfin
  or Emby server, whose films and shows then play the same way (Media servers, below). The server keeps each channel's queue
  and clock (`server/watchParty.js`, `routes/watchParty.js`, in memory like who's in voice: an
  API restart ends every party); the clients only follow it.
  - **State:** a party is `{ current, queue, playing, position, updated_at }`: `position`
    (seconds) is where `current` was at `updated_at` (server ms), so anyone works out where it is
    now. Items are `{ id, video_id, title, author, duration, added_by }`. Title and channel come
    from YouTube's oEmbed when a video is added (the API asks `youtube.com/oembed`, so YouTube
    sees the server's address and the video, never who asked); oEmbed's 401/403 (embedding
    turned off, private) and 400/404 refuse it, and YouTube being unreachable adds it untitled.
    `duration` comes from the first player that knows it (`PUT .../duration`, first answer
    counts), and lets the server move on by itself 1 s after a video ends (paused, it doesn't);
    a live stream has none and plays until skipped. A member could report a short duration and
    so end a video early: people in a channel are trusted that far. 100 videos wait at most.
    The party ends with its last video, or a minute after its channel empties (`voiceChanged`,
    from voice.js: a lone watcher whose connection drops comes back to it); deleting the
    channel or guild drops it.
  - **API** (`/guilds/:g/channels/:c/watch-party`, each answer `{ party, server_time }`): `GET`
    needs View Channel (and also gives the `log`, below); every change needs you in that channel's voice (`voice.states`, any
    device), then: `POST /queue { videoId }` Queue Videos (nothing playing: it starts);
    `DELETE /queue/:item` your own with Queue Videos, anyone's with Manage Queue; `PUT
    /queue/:item/move { beforeId }` (null: the end) Manage Queue; `PUT /playback { playing?,
    position?, itemId }` Control Playback (`itemId`: the video meant, 409 if another is on now);
    `POST /skip { itemId }` Control Playback, or whoever added the video playing (a second skip
    of the same item does nothing). Everyone who can see the channel gets `guild_watch_party {
    guildId, channelId, party, entry, serverTime }` (party null: ended; `entry`: what was just
    logged, or null), and a voice channel in the
    layout has `watch_party: { video_id, title, playing }` or null, for the channel list ("Watching
    …" / "Paused: …" under it).
  - **Activity log** (who's been skipping around): each channel keeps its last 100 actions in
    memory only (`log` in watchParty.js, never in the database): added, removed and moved
    videos (a move with the place it went to, 1 = next), played, paused, jumped (`from` and
    `to`, seconds; only a move of a second or more counts, else it's logged as play/pause, and a
    request changing nothing isn't logged), skipped, and `ended` (the server moving on by
    itself, no user). Entries are `{ id, at, user_id, action, video_id, title, from?, to? }`.
    It outlives the party (so who skipped the last video still shows) and is forgotten with
    the party a minute after the channel empties, when the channel or guild is deleted, or on
    an API restart. Everyone who can see the channel can read it, like the queue. Client:
    `useWatchPartyLog(channelId)` (the whole log from GET, each event's `entry` added, the last
    100), drawn by `voice/WatchPartyActivity.jsx` at the bottom of the panel: folded, "Activity
    (n)" and the latest as one line; open, every entry newest first as a sentence ("alice
    jumped from 0:45 to 3:10 in …") with its time (`formatTime`, with seconds). Once a video
    has played, the panel stays open after the party ends, until closed, so the log stays in
    view.
  - **Search** (`GET .../search?q=`, `server/youtubeSearch.js`): the panel's box takes a link or
    words; a link (anything starting `http(s)://` or `www.`, or a youtu.be/youtube.com path:
    `looksLikeLink`) is added, or refused if it isn't a YouTube video, and words are searched
    for (a bare video id too: YouTube finds it). Needs you in the channel's voice with Queue
    Videos, at most 100 characters, 20 searches a minute each (`rateLimit.js`, off in tests).
    The server asks YouTube, so YouTube sees the server's address and the words, never who
    searched. There's no API key: it posts to InnerTube (`youtubei/v1/search`, the endpoint
    youtube.com's own search page uses, with the "videos only" filter), which is undocumented
    and may change; then searching answers 502 ("paste a link") and links still work. If that
    happens often, the YouTube Data API (a key in `server/.env`, 100 quota units a search,
    10,000 a day free) is the fallback to build. Answers `{ results: [{ video_id, title,
    author, duration, live }] }` (YouTube's first page, up to 20; upcoming premieres left
    out; a live stream has `duration` null), each query cached for 10 minutes (200 kept).
    Client: `searchVideos()` and `voice/WatchPartySearchResults.jsx` under the box: thumbnail
    (`i.ytimg.com`, loaded by the viewer, so only when Settings → Privacy lets YouTube load at
    once), title, channel · length or Live, and Play (nothing on yet) or Add, which turns into
    ✓ Added so several can be queued from one search; the results stay until closed or the
    next search. On a phone (`mobile.css`), while the box is focused (keyboard up) the people
    row and call buttons are hidden, and the empty page's picture and words while typing or
    with results open, so the box and results stay in view; sending a search blurs the box so
    the keyboard goes and the results have the screen. The panel's buttons don't take focus on
    mousedown (`keepTyping`): a finger landing on Search would otherwise blur the box first,
    bringing all that back and moving the button before the click, which then never came.
  - **Permissions** (Discord has none of these; ours only, bits 58-60 for bots): Queue Videos
    (`QUEUE_VIDEOS`) and Control Playback (`CONTROL_PLAYBACK`) are @everyone defaults (migration
    11 gave them to existing guilds), Manage Queue (`MANAGE_QUEUE`) isn't; all three are channel
    overrides of voice channels.
  - **Client:** `voice/watchParty.js` keeps each channel's party (from GET, the answers to
    changes, and the events; reloaded after a reconnect) and the server's clock: `serverNow()`
    is Date.now() plus an offset taken from the quickest GET round trip so far (to within half
    of it), and moved forward by any event whose `serverTime` says the server is further ahead.
    `useWatchParty(guildId, channelId)` reads it. **The player** (`voice/WatchPartyPlayer.jsx`)
    is drawn from Layout while you're in a channel whose party has a video, and is never moved
    (moving an iframe reloads it): `position: fixed` over the channel page's slot (set by
    `WatchPartyPanel` with `setPlayerSlot`; its rect followed every frame, since the phone layout
    slides panes), or, with no slot on screen (another page, or a stream being watched there),
    small in a corner (bottom right; on a phone top right under the header, clear of the message
    box; in `.corner-players`, under a stream in the corner) with the title, Go to the voice
    channel, Pop out and close (stops it on this device until you open the channel again).
    **Pop out** (computers): the player in a window of its own (`voice/watchPartyWindow.js`, on
    the same `popoutWindow.js` as streams'), from the docked player's controls or the corner's
    bar. Not a blank window like the stream's: YouTube refuses to play without a Referer
    (Error 153) and a blank window sends none, so it opens `public/popout.html` (an empty page
    of ours), waits for it to load, then draws into it. The frame can't move without reloading,
    so it starts afresh there and catches up (`useWatchPartySync`; the browser may ask for
    Click to watch); `youtubeEmbed.js` listens on the frame's own window. Bring back, or
    closing the window, puts it back; the party ending or leaving the channel closes it. The
    channel page says it's playing in its own window, with Bring back. Its controls follow your permissions: play/pause, skip, the time,
    a seek bar, and for you alone volume (`localStorage watchPartyVolume`; deafened: muted) and
    full screen. A transparent shield covers the frame, so clicks never reach YouTube's own
    controls (which are hidden: `controls=0`, `disablekb=1`), which would put one person out
    of step.
  - **Driving YouTube without its script:** `voice/youtubeEmbed.js` talks to the
    youtube-nocookie.com embed over the messages its page understands (`listening`, then
    `infoDelivery` and the events; commands `{ event: 'command', func, args }`), which is all
    YouTube's iframe API script does. That script isn't loaded: it would run YouTube's code in
    our page, next to the keys. The frame opens on the first video by its address (`embedUrl`,
    `enablejsapi=1` and our origin); later ones are loaded through it.
  - **Keeping in step** (`hooks/useWatchPartySync.js`, twice a second): the item changed → load
    it at the expected point; should be playing → play (seeking first if more than 0.75 s off),
    and a playing video more than 2 s off is moved back (at most every 3 s); paused → pause,
    and seek if more than 0.75 s off (a cued video is cued again at that point, since seeking
    one starts it). Three play commands ignored in a row means the browser won't autoplay: a
    "Click to watch" button over the player asks for the click. The first player to know a
    video's length reports it.
  - **Page** (`voice/WatchPartyPanel.jsx`, in `VoiceChannelView` once you're in its voice): the
    clapperboard button among the controls opens it (it stays open while a video plays); a watched
    stream takes the page instead, and the video goes to its corner. A link box (any YouTube
    watch, share, shorts, live or embed link, or a bare id; Queue Videos), the player's slot
    (16:9 and its controls; on a computer the queue sits beside it, or under it when the page
    is narrower than 720 px, a container query), Now playing, and Up next: dragged into order
    with Manage Queue (`useDragReorder`; `movedItem` turns the new order into one move), ✕ on
    your own (or anyone's with Manage Queue). The people become a row, as when watching a
    stream. Outside voice the page only says what's on.
  - **Privacy:** the player loads from YouTube (youtube-nocookie.com), which sees each viewer's
    IP address and the video, as with YouTube links. With Settings → Privacy's "Show YouTube
    videos straight away" off, the player shows a note and Watch first (per channel, until the
    app reloads); nothing else (no thumbnails) is fetched from YouTube. The desktop app's
    Referer fix covers the embed (see Desktop app); its voicaw:// pages can't be given as the
    `origin`, and Watch Together hasn't been checked there yet.
  - **Media servers** (built 2026-10-23; `server/mediaServers.js`, `routes/mediaServers.js`):
    a guild's own Jellyfin or Emby (one API, but logged in to differently: Emby's is under
    `/emby` and takes `X-Emby-Authorization: Emby …`, `X-Emby-Token` and `?api_key=`; Jellyfin
    takes the standard `Authorization: MediaBrowser …, Token="…"` and `?ApiKey=`. Jellyfin 10.10
    took Emby's ways too, but 12 refuses `X-Emby-Authorization` with a 400, ignores the token
    headers and `api_key`, and has no `/emby` paths: found 2026-10-23 on a real 12.2, and
    `e2e/mediacontainers.mjs` now runs one). **Connecting** (Guild Settings →
    Watch Together, Manage Guild; `PUT /guilds/:g/media-server { kind, url, username,
    password }`, 10 tries a minute each): the address (https only; a pasted `…/web/` or Emby's
    `…/emby` is trimmed; public addresses only, any port, through `safeFetch`, whose private
    addresses and http are allowed only with `LINK_PREVIEWS_ALLOW_PRIVATE=1`, tests and e2e),
    `System/Info/Public` (asked with no authorisation; if it isn't there as the kind chosen, as
    the other) says it's that kind (Jellyfin names itself in `ProductName`, Emby doesn't: a
    mismatch is refused, "That's a Jellyfin server, not Emby"), then `Users/AuthenticateByName`
    as the guild (`Device="Voicaw: <guild name>"`, and a `DeviceId` made at random on each
    connect, kept as `device_id`: the servers keep one login per device, and an id made from the
    guild's, as connections before had, `voicaw-guild-<id>`, would sign out a guild with the same
    id on another Voicaw server, or a test server's). A refusal other than a wrong password says
    its status ("refused the login (error 400)"), not "couldn't be reached". Only the access
    token is kept (`guild_media_servers`, one
    per guild, deleted with it), never the password. An account that's the server's
    administrator is refused and its login ended (the user chose: viewers get the token, see
    below); a restricted account made for the guild decides which libraries it can see.
    Replacing or disconnecting (`DELETE`) ends the old login there (`Sessions/Logout`), takes
    that server's videos out of every queue of the guild (one playing is skipped, logged
    `ended`), and is in the audit log (`media_server_connect { kind, name, url, username }`,
    `media_server_disconnect`). `GET` gives Manage Guild `{ kind, name, url, username,
    connected_by, connected_at }`; every member sees `media_server: { kind, name, url }` in the
    guild's layout (null: none).
    **Searching** (`GET …/watch-party/media-search?q=`, and a show's episodes
    `…/media-episodes/:seriesId`; in voice with Queue Videos, sharing YouTube search's 20 a
    minute): films, episodes, music videos, other videos and shows the account can see, 30 at
    most, as `{ media_id, type, title, series, season, episode, year, duration, image_url }`
    (`image_url`: the server's `Items/:id/Images/Primary`, which needs no token). In the panel
    a switch above the box picks the media server (first) or YouTube; a show's Episodes button
    lists its episodes (Back returns to the results); films' and shows' pictures are drawn as
    posters, episodes' as stills; a link to the server's own web app (Jellyfin's
    `…/web/#/details?id=…`, Emby's `…/web/index.html#!/item?id=…`; `mediaIdFromLink`, only
    the guild's server) adds that item, and a YouTube link still adds YouTube's video.
    **Items** (`POST …/queue { mediaId }`, checked with `Users/:user/Items/:id`: a video the
    account can see) are `{ source: 'media', media_id, media: { type, series, season, episode,
    year, image_url }, title, duration }` (`source: 'youtube'` for the others); the length comes
    from the server, so it moves on by itself at once. **Playing:** the first player to want the
    video playing asks `GET …/watch-party/stream/:itemId` (in voice; 409 for another video),
    and the server asks the media server once per item (`Items/:id/PlaybackInfo` with a device
    profile of what every browser plays: H.264 with AAC, MP3, Opus or FLAC in MP4, VP8/VP9/AV1
    in WebM, up to 12 Mbit/s). A file it plays as it is comes as `{ type: 'file', url }` (Emby's
    `DirectStreamUrl`, Jellyfin's `Videos/:id/stream?static=true`); anything else (MKV, HEVC,
    AC-3…) as `{ type: 'hls', url }`, the server's transcode to H.264/AAC (`TranscodingUrl`).
    The servers put the token in those addresses; it's taken out of what's kept and put back
    (`ApiKey` for Jellyfin, `api_key` for Emby) for each answer. Everyone gets the same PlaySessionId, so the media server makes
    one transcode for the channel (checked: three viewers, one set of segments), seeking
    restarts it there; it's stopped (`DELETE Videos/ActiveEncodings`) once the video stops
    being the one playing. A failed answer isn't kept (the next player asks again); an address
    from a login since replaced answers 410. **The player:** `voice/mediaElementPlayer.js`, a
    `<video>` with YouTubeEmbed's face (`accepts`, `load`, `play`, `pause`, `seek`,
    `setVolume`, `info` in YouTube's states), so `useWatchPartySync` drives either; Layout's
    player draws the `<video>` for a media item and YouTube's frame (`YouTubeFrame`, opened on
    the item playing when it appears) for a YouTube one, swapping when the party moves between
    them (the sync leaves an item to the player that `accepts` it). HLS goes through hls.js
    (^1.7, imported the first time it's needed) wherever it works, else the browser's own
    (iPhones without MediaSource; newer Chromes have one too, but hls.js has been tried for
    longer), starting at the party's point (`startPosition`, and the element's own
    `currentTime`, which can keep the last video's point through the change). While the address
    is asked for it says buffering, so the sync doesn't take the wait for autoplay being
    refused; a 403 (just joined: LiveKit's webhook telling the server you're in comes a moment
    after the app joins), 502 or no answer is asked again (4 tries, 1.5 s apart), the wait added
    to the start if it should be playing. Couldn't play: a note over the player (the server's
    reason, or "This video couldn't be played") with Try again (`retry`, which loads it again).
    No consent step like YouTube's: it's the guild's own server.
  - **Media servers' privacy** (also the privacy policy): the video and its pictures load from
    the media server, which sees each viewer's IP address and what they watch; searches come
    from our server. The token is handed to whoever is in the voice channel (in the addresses,
    and so readable by them), so they could use it to browse what the account can see: hence a
    restricted account, and administrators refused. Bots can't search or add media server
    videos (no bot API for Watch Together yet).
  - `e2e/watchparty.mjs` checks it with real videos (needs the internet); `e2e/mediaservers.mjs`
    with real Jellyfin and Emby servers in Docker (`e2e/mediacontainers.mjs` starts them).
- **Not done yet:** a per-user local mute (Discord has one), output volume above 100%, server mute/move (Mute Members, Move Members), push to talk
  with a key combination or several keys, Discord's push to talk (priority), noise suppression and the gate on the other side (for people whose
  app doesn't, like Discord's "suppress others' noise"),
  background blur, a camera spotlight (one camera big, like a watched stream); Watch Together: a party surviving an API restart, other sites than YouTube and the guild's
  Jellyfin or Emby (Plex), choosing a media server video's subtitles or audio track (the
  account's settings on the server decide; not checked how subtitles come out),
  playlists, start times from links (`t=`). Phones: a PWA's audio stops when it's in the background (iOS also when locked; it
  rejoins when the app is back, see Lost connections). Staying in while locked needs a native
  app: background audio, and voice through LiveKit's native SDK (iOS also pauses microphone
  capture in a Capacitor WebView).

## Soundboard

Built 2026-10-25, like Discord's: each guild's short sounds, played in its voice channels for
everyone there to hear.
- **Sounds** (`server/soundboard.js`, `routes/soundboard.js`, table `guild_sounds`): per guild,
  plain files (not encrypted, like custom emoji) in the public `sounds` bucket at `sounds/<id>`,
  each with a name (2–32 characters, not unique), an optional emoji (Unicode or `<:name:id>`)
  and its own volume (0–1). Added like emoji, in two steps: `POST /guilds/:g/soundboard { name,
  emoji, volume, type, size }` makes an unavailable row and signs an upload to
  `sounds/src/<id>`; `POST …/:id/ready` checks the bytes (an MP3, Ogg or WAV by its first
  bytes, `sniffAudio`, at most 512 KB), stores it as `sounds/<id>` and sends
  `guild_soundboard_update { guildId, sounds }` to every member. `PATCH …/:id`
  (name, emoji, volume), `DELETE …/:id` (the file goes too; join sounds that were it are
  cleared, with `guild_join_sound` to their owners). Adding, editing and deleting take **Manage Emoji** (Discord's Manage
  Expressions; its label is now Manage Emoji and Sounds) and are in the audit log
  (`sound_create` / `sound_update` / `sound_delete`). At most 48 per guild; unfinished uploads
  are forgotten after an hour; deleted with the guild. `GET /guilds/:g/soundboard` (any member)
  answers `{ sounds }`.
- **Length:** Discord's 5.2 seconds. The server can't check it without decoding, so the apps
  do: Guild Settings → Soundboard (`guild/SoundboardSettings.jsx`, `voice/soundClip.js`)
  takes several files at once and adds each as soon as it's picked, with nothing to confirm
  (2026-10-26): named after its file, no emoji, 100%, all changed afterwards in its row. Each
  file is decoded (anything the browser reads: MP3, WAV, Ogg, M4A, FLAC, a video's sound…); an
  MP3 or WAV that's short and small enough goes up as it is, anything else is cut to 5.2 s from
  just before its sound starts (`soundStart`: leading silence under -40 dBFS skipped, and early
  enough to keep 5.2 s), with 10 ms fades at the cuts, mixed to mono and made a 16-bit 48 kHz
  WAV (always under 512 KB; also what makes Ogg playable on Safari). Files it can't read, or
  past the 48, are named in an error and the rest still go up. And every app stops any sound
  at 5.2 s when playing it.
- **Playing** (`POST /guilds/:g/channels/:c/soundboard/:soundId`): you must be in that channel's
  voice (any device), not deafened, with **Speak** and **Use Soundboard** there (`USE_SOUNDBOARD`,
  a new permission and channel override, Discord's bit 42, an @everyone default; migration 19
  gave it to existing guilds), and only the channel's guild's sounds (no sounds from other
  guilds, which Discord sells; join sounds are the exception, below). Three sounds in five
  seconds each (`plays`, off in tests); past that the server answers 429 and the panel just
  doesn't play it, saying nothing (2026-10-26). The
  sound isn't mixed into anyone's microphone: the server sends `guild_soundboard_play {
  guildId, channelId, userId, join, sound }` to everyone in the channel who can hear it
  (Listen), and each app plays the file itself (`voice/soundboard.js`), so each listener
  chooses whether and how loud. Nothing about who played what is stored.
- **Join sounds** (Discord's entrance sounds): since 2026-10-26 one per person, the same in
  every guild (was one per guild; migration 20 kept each person's newest), picked from the
  sounds of any guild they're in (`users.join_sound_id`; `GET /soundboard/join-sound` answers
  `{ join_sound_id, guilds: [{ id, name, sounds }] }`, `PUT /soundboard/join-sound { soundId |
  null }`, their other devices follow with `guild_join_sound { soundId }`), in their own full
  profile's About tab (`UserProfile.jsx` `OwnJoinSound`, grouped by guild, with a preview), no
  longer in the soundboard panel. Leaving the sound's guild makes it none (`joinSoundOf` checks
  membership; the choice is kept, unused). When LiveKit says they joined any guild's voice
  channel (`voice.js` `participantJoined`, not a new session in the same channel), it's sent
  the same way with `join: true` (its `sound.guild_id` may be another guild), if they have
  Speak and Use Soundboard there; coming back to the same channel within 30 s (a dropped
  connection) doesn't play it again. They hear it too. (`guild_members.join_sound_id` is left
  unused.)
- **Listening** (`voice/soundboard.js`, started from Layout): the device that's in that channel
  plays it through the app's sounds' AudioContext (`sounds.js` `playClip`: the chosen speakers,
  the decoded file kept, the last 100), unless deafened, at Settings → Voice & video →
  Soundboard's volume for its kind × the sound's own × the output volume. Two kinds, each with
  its own switch and volume (`audioSettings` `soundboardOn`/`soundboardVolume`,
  `joinSoundsOn`/`joinSoundVolume`, per device, on and 100% by default): sounds people play,
  and join sounds. Each person's sound stops when they play another (`playFor`, a sound per
  player; others' play on), even one this device doesn't play (that kind off). The emoji of
  each sound played pops up on its player's tile for 3 s
  (`useSoundEffects`; a note where it has none), heard or not.
- **UI:** the note button (`voice/SoundboardButton.jsx`) in the voice bar and the channel page
  while connected to a guild voice channel opens `voice/SoundboardPanel.jsx` (floating on a
  computer, a sheet on a phone): the sounds as buttons (a click plays it for everyone; off,
  with a note, without the permissions or deafened), a speaker on each playing it only to you
  (at your soundboard volume), and a link to the settings.
- **Bots** see it as Discord's API (see Soundboard in `docs/bots.md`).
- `e2e/soundboard.mjs` checks adding three files at once (as it is, cut after leading silence,
  an unreadable one refused), playing for both (cut at 5.2 s), the
  tile's emoji, preview, the setting, deafened, a phone's sheet, a second sound cutting off the
  player's first, and a join sound picked in the profile playing in another guild.
- **Not done yet:** choosing which 5.2 s of a long file to keep (the trim slider went with
  adding on pick; re-upload a cut file instead), Discord's default sounds, sounds from other guilds, favourites, a
  per-sound cooldown shown in the panel, playing a sound from a keyboard shortcut.

## TURN (networks that only allow the web)

Built 2026-10-14. Media normally goes straight to LiveKit on UDP 7882, or TCP 7881 when UDP is
blocked. Some work and school networks allow neither, only web traffic (TCP 443); Discord
can't be used there either (its voice is UDP only). For them LiveKit's own TURN server relays
the call over TLS on port 443, as Zoom or Teams do. Only a fallback: TCP adds delay when packets
are lost, so browsers use it only when nothing direct works.
- **How:** `turn:` in `~/livekit/livekit.yaml` (`domain: turn.voicaw.com`, `tls_port: 7883`,
  `external_tls: true`, `udp_port: 0`; setup in `README.md` section 5). LiveKit then gives every
  client `turns:turn.voicaw.com:443?transport=tcp` with short-lived credentials in its join
  response, so the client needed no change (DM calls and bots' LiveKit SDKs get it too). The
  relayed audio is the same as direct: DM calls stay end-to-end encrypted, guild voice isn't;
  nothing new is stored and no third party is involved.
- **Sharing 443 with nginx** (`server/scripts/turn-443.sh`, README section 7): nginx's stream
  module takes 443 and reads each connection's TLS name without decrypting it (`ssl_preread`):
  `turn.voicaw.com` goes to a TLS end on 127.0.0.1:8444 (the `*.voicaw.com` certificate),
  which passes plain TCP to LiveKit; everything else to the sites, which listen on
  127.0.0.1:8443 with `proxy_protocol` and take the visitor's address from it
  (`real_ip_header proxy_protocol`), so logs, rate limits and `X-Forwarded-For` still see real
  addresses. A site added later with `certbot --nginx` gets `listen 443 ssl`, which can't share
  443 with the stream block: run the script again (it moves new sites, keeps the rest).
- **Relaying to the SFU:** LiveKit's TURN refuses to relay to private addresses unless
  `allow_restricted_peer_cidrs` lists them, so relayed calls reach LiveKit through its public
  address (the router loops it back). Allowing the LAN address (`192.168.50.135/32`) would also
  work without the router, but lets anyone with call credentials send UDP to every service on
  the host (rpcbind, mDNS, the other coturn...), so it's only the fallback if the loop back fails.
- **Checked by** `e2e/turn.mjs` (the same setup on loopback, Chrome allowed relayed paths only).
- **Not done:** TURN over UDP (on 443 it would help networks that allow QUIC; LiveKit can't run
  as root and nginx can't pass UDP by name), and TURN for the other voice regions (each region's
  server needs its own `turn:` block and 443).

## Channel settings (bitrate, user limit)

Like Discord's (built 2026-10-07): a voice channel's Overview (`guild/ChannelDialog.jsx`, its
voice part `guild/VoiceChannelSettings.jsx`; Manage Channels) has a **bitrate** and a **user
limit**, and a region (below) when there's more than one. Columns `guild_channels.bitrate`
(bits/s, 8000–384000, Discord's range up to its most boosted servers; default 64000, Discord's
default, also for channels made before), `user_limit` (0–99, 0: none) and `rtc_region`. Set on
`POST`/`PATCH /guilds/:g/channels[/:c]` as `bitrate`, `userLimit`, `rtcRegion`
(`routes/guilds.js` `voiceSettingsOf`, shared with the bot API), audit-logged, copied by Clone.
- **Bitrate**: the join token comes with the channel's `bitrate`, and the client publishes its
  microphone with `audioPreset: { maxBitrate }` (LiveKit's default was 48 kbps, the "low
  quality" people heard). LiveKit's server answers with Opus `maxaveragebitrate=510000`, so the
  sender's limit is what counts. A change reaches the people in the channel at once
  (`guild_voice_channel { guildId, channelId, bitrate, moved: false }`, sent only to them,
  `voice.channelSettingsChanged`), and `voiceClient.setBitrate` changes the sender's
  `maxBitrate` live (no reconnect) and the publish default for a republish. Above ~96 kbps a
  voice hardly changes (the chain is mono); the dialog says so. RED (LiveKit's packet loss
  protection, on) sends each frame twice, so about twice the bitrate goes out: e2e measured
  ~210 kbps for 128. DM and group calls stay at 64 kbps.
- **User limit**: `joinToken` refuses (403 "This voice channel is full") once the others in it
  reach the limit; Manage Channels joins anyway (Discord's Move Members, which we don't have),
  and someone already in it gets a new token (a rejoin). Counted from who LiveKit says is in,
  so two tokens handed out at the same moment can both get in. The channel list shows "02/05"
  (amber when full), and the channel's page says it's full above Join (and why a join failed:
  a phone has no voice bar there).

## Voice regions

Several LiveKit servers, like Discord's voice regions (built 2026-10-07): global admins add them
in Settings → Admin → Voice regions (`VoiceRegionsAdmin.jsx`, `routes/admin.js`
`/admin/voice-regions`), each a flag (any flag emoji, countries or not, chosen from the emoji picker's Flags: `EmojiPicker category="flags"`, drawn as Twemoji everywhere, since Windows has no flag emoji), a name, its LiveKit address for the apps
(`wss://`), optionally the address this API reaches it on, and its API key and secret
(`server/voiceRegions.js`, table `voice_regions`). The secret is stored in the database (like
an admin's Klipy key) and never sent back: the panel shows its last four characters, and an
empty secret on an edit keeps it. Each server needs its own API key (that's how its webhooks
are told apart) and its `webhook:` pointed at this API's `/api/livekit/webhook`.
- **Main**: migration 15 made `server/.env`'s LiveKit the built-in region (`builtin`, named
  "Main"; its address and keys stay in .env, only its name and flag change here). It can't be
  removed. Without LIVEKIT_* it's "not set up" and voice works only if another region is the
  default.
- **Default**: one region (`is_default`), Main at first. DM and group calls start on it (the
  call keeps its region, `call.regionId`), and so do voice channels left on **Automatic**
  (`rtc_region` null; Discord picks the region nearest the first person in, we don't).
  `GET /voice/regions` lists them for the channel dialog (no addresses or keys); the dialog
  shows the choice (a list, not a menu, so flags can be pictures) only with two or more.
- **Server side** (`voice.js`): `serviceFor(regionId)` is each region's LiveKit client;
  states and calls remember their region, and everything (tokens, removing people, mute
  attributes, the start-up `restoreFromLiveKit`) goes to that one. A webhook is checked against
  the region whose API key signed it (`verifyWebhook`, from the JWT's issuer). A "joined" from a
  server that isn't the channel's region now (a token from before a move) is removed; a
  "room finished" only clears the people on that server.
- **Moving**: a channel's region changed (its setting, the default changed under Automatic,
  its region removed, or a region's server changed) sends `guild_voice_channel { moved: true }`
  to the people in it; their apps drop the connection and join again with a new token
  (`takeOver`, as after a lost connection: "Reconnecting…" for a moment, the camera comes back,
  a screen share doesn't). When the new session starts, the API ends the old one on the old
  server (LiveKit only replaces a session on the same server). Bots are taken out instead, to
  join again. People still on a removed region after a minute are disconnected.
- **Bot API**: channels' `bitrate`, `user_limit` and `rtc_region` (the region's id as a string)
  are real and can be set (`PATCH /channels/:id`, create), and `GET /voice/regions` and
  `GET /guilds/:id/regions` list them (`optimal`: the default).
- **Not done**: picking a region by latency (Discord's Automatic), and moving a call to
  another region.
- e2e: `e2e/regions.mjs` runs a second LiveKit as "Frankfurt" (adds it in the admin panel,
  measures the bitrate going out, full channel on a phone, live bitrate change, a move both
  servers confirm, removal).

## DM calls

One-to-one voice calls from a DM, through the same LiveKit and `voiceClient` connection (one
per device: starting or answering a call leaves a voice channel, and joining a channel hangs up
a call; the server enforces both). **End-to-end encrypted**, unlike guild voice:
- **Key:** the caller makes 32 random bytes per call (`generateCallKey`) and a call id (UUID),
  and encrypts the key with the DM conversation key (`encryptCallKey`, additional data
  `callKeyContext(callId, callerId, calleeId)`, so it can't be moved to another call or have
  the roles swapped). The server passes on only that envelope (`key_envelope`). Both clients
  give the key to LiveKit's E2EE (`ExternalE2EEKeyProvider` + its worker, in `voiceClient`
  `connect`), which encrypts every audio frame before it leaves: LiveKit sees GCM-encrypted
  tracks (`calls.mjs` checks with LiveKit's API). No E2EE in the browser: no call (never a
  plain fallback). A contact whose key changed can't be called or answered (their chat has to
  accept the new key first); the callee checks the caller's keys like opening their chat does.
- **Server** (`server/calls.js`, `routes/calls.js`, in memory): `POST /dm-calls { calleeId,
  callId, keyEnvelope }` rings (409 if they're in a call) and returns the caller's LiveKit
  token (room `call-<id>`); the callee gets `call_incoming` on every device and a push ("Incoming
  voice call", tag `call-<id>`, 45 s TTL). `POST /dm-calls/:id/accept` (callee, once) returns
  theirs; `call_update` (state `active`) tells both, and the callee's other devices stop
  ringing. `/decline`, `DELETE /dm-calls/:id` (hang up; the caller before an answer cancels)
  and 45 s without an answer (`RING_MS`: missed) end it: `call_end { id, reason }` to both
  (`ended`, `declined`, `cancelled`, `missed`), LiveKit's room is deleted, and a missed or
  cancelled call replaces the ringing notification with "Missed call". Someone leaving the room
  (LiveKit webhook) ends it after a 10 s grace (LiveKit's client may rejoin after a network
  change). `GET /dm-calls/current` lets a just-opened app show a call ringing for it. An API
  restart forgets calls (people keep talking until they hang up).
- **Client** (`voice/callClient.js`, read with `hooks/useCall.js`; `initCalls(user)` from
  `Layout`): the call button in the DM header, `call/IncomingCall.jsx` over any page (answering
  opens the chat), `call/CallPanel.jsx` at the top of the DM (both people, speaking rings, the
  other's mute, the duration, controls, "End-to-end encrypted"), the voice bar ("Call with …",
  hang up; why a call ended: declined, didn't answer, missed call). Ring and ringback sounds are
  the Incoming/Outgoing ring loops (see Sounds). Reloading or leaving the page leaves the call.
- **Group calls** (from a group DM's header): the call key is encrypted with the group's
  current epoch key (`groupCallKeyContext(callId, groupId, epoch, callerId)`, `key_epoch`), so
  only members of that epoch can open it; members added during a call join the next one. It's
  also signed by the caller's identity key, inside the encryption like group messages
  (`encryptGroupCallKey` / `decryptGroupCallKey` in groupCrypto.js, a `v2.` envelope of 171
  characters, covering `callKeySignatureContext({ callId, groupId, epoch, callerId })`), so a
  member working with the server can't start a call in someone else's name: a key that isn't
  signed by the caller (from the group's checked log) isn't joined ("couldn't be verified"), and
  the server takes only `v2.` keys for group calls (an older app gets "Please update the app").
  Not covered: the ringing notice shows the server's caller name before the key is checked, and
  who's who *inside* a call comes from the server's LiveKit tokens; every member has the call
  key, so a member working with the server could still join a call under another member's name.
  `POST /group-dms/:id/call { callId, epoch, keyEnvelope }` rings every other member (409 with
  the `call` if the group has one: join that); any member joins any time with
  `/dm-calls/:id/accept` (declining only stops your ringing; after 45 s nobody's rung and they
  get "Missed call"); `DELETE` leaves, and the last one out ends it. `call_update` (with
  `participants` and `ringing`) goes to every member, so the group shows who's in and "Join call"
  (`group/GroupCallPanel.jsx`; `callClient` keeps `groupCalls`). Being removed from the group
  takes you out of its call (LiveKit too). The call key isn't changed when someone leaves a
  call.
- **Calls in the chat history** (`server/callLog.js`, `utils/callLog.js`,
  `CallLogNotice.jsx`): when a call ends, the server adds a row to its DM or group (in the
  group's latest epoch) with `system` = 'call', the caller as sender and plaintext content
  `{ v: 1, outcome, duration, joined }`, sent as the chat's usual new-message event (no push;
  the ringing notification already became "Missed call"). Not encrypted, like a "poll ended"
  row: the server knows who called whom, when and for how long anyway. Someone picked up
  (`ended`): everyone sees "Alice started a call that lasted 12 minutes." (a 1:1 call timed from
  the answer, a group call from its start). Nobody did (`missed`, or `declined` in a 1:1
  call): the caller sees "Bob didn't answer." / "Bob declined the call." / in a group "Nobody
  answered.", everyone else "You missed a call from Alice." (red phone). Missed calls are
  unread for the people rung; an ended call isn't for those who were in it. Call rows are only
  ever drawn as notices (the server writes them, so never as someone's message) and can't be
  edited, deleted, reacted to, pinned or replied to. A call going on when the API restarts gets
  no row.
- **Video** in calls: see Cameras under Voice channels (the same code, always allowed in calls).
- **Screen sharing in calls** (2026-10-08): the same code as voice channels' (Screen sharing,
  Stream quality, pop out), always allowed: `calls.js` `tokenFor` gives everyone `canStream`
  (`screen_share` and `screen_share_audio`) and the admin's `streamLimit`, which `callClient`
  passes to `joinCall`. **End-to-end encrypted** like the rest of the call: LiveKit's E2EE
  encrypts every track of the room, so the screen and its sound reach LiveKit as ciphertext.
  The share button is in the call panels and the voice bar (computers only, as in channels;
  phones watch). `call/CallStream.jsx`, in `CallPanel` and `GroupCallPanel`: the watched
  stream big in the panel (`StreamView`, at most 40% of the app's height, the chat below; full screen and pop out for more),
  the "in its own window" note while popped out, and "X is sharing their screen." with Watch
  Stream for every other stream; a Live badge on the sharer. **Watching:** in a 1:1 call the
  other person's stream opens on its own once the DM is shown (you're its only viewer; not
  over your own preview or a stream you're already watching), and Stop watching keeps it
  closed until they share again; in a group call it waits for Watch Stream, as in channels
  (only watched streams are downloaded). No `self_stream` from the server: calls aren't
  voice states, so Live comes from the room itself and only people in the call see it.
- **Not done yet:** the incoming
  call screen of a native app (a closed PWA only gets the notification).
