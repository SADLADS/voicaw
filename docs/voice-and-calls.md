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
  from the elements instead, capped at 100%. `applyVolumes` sets every track to
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
- **Screen sharing** (guild voice channels, with Video): the token lets you publish
  `screen_share` and `screen_share_audio` (and `camera`, see Cameras) only with Video (`publishPermission`), and
  `enforceGuild` changes that live (LiveKit then ends a stream that's no longer allowed; the
  client lets go of the capture). Who's live (`self_stream`) comes from LiveKit's
  `track_published` / `track_unpublished` webhooks (screen share tracks of the session that's
  in), so it's what LiveKit really carries. Client: `startScreenShare` (from a click; the
  browser asks what to share and whether with its sound; LiveKit's default 1080p at 15 fps)
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
  own volume (Stream volume, above). UI: a
  Live badge in the channel list and on tiles, Watch Stream on a live tile once you're in, the
  stream big above the tiles (`voice/StreamView.jsx`: full screen, stop watching; the people
  become a row; pop out, below), and the share button (`voice/ScreenShareButton.jsx`) in the voice bar and the
  channel page. Not offered where the browser has no `getDisplayMedia` (phones, which can
  still watch). The desktop app shows our own picker first (`voice/ScreenPicker.jsx`, see
  Desktop app).
  **Pop out** (computers, like Discord's): the stream in a window of its own
  (`voice/streamWindow.js`), to put on another screen, maximise or make full screen. It's a
  blank window opened from the click (`window.open('', 'voicaw-stream')`; a blocked pop-up
  says so), with the page's stylesheets copied in (and any added later) and `<html>`'s theme
  attributes kept in step; `StreamPopout` (drawn from Layout, so it carries on on every page)
  renders `StreamView` into it with a portal, playing the same LiveKit track (nothing more is
  downloaded). The channel page shows a note instead (Bring back, Stop watching). Closing the
  window or Bring back puts the stream back on the page; Stop watching, the stream ending,
  leaving voice or the page going (reload, logout) closes it. The desktop app allows exactly
  this window (see Desktop app).
  Bandwidth: the sharer uploads once; LiveKit sends a copy to each viewer.
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
  in the panel. Your own is mirrored, as in a mirror (others see it the right way round). In
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
- **UI:** in the channel list, people in a voice channel are listed under it (ringed while
  talking, when you're in there too). Clicking a voice channel joins it on desktop; on mobile a
  tap only opens it and you join from its page (`guild/VoiceChannelView.jsx`: tiles, outlined while talking, not their pictures; Join Voice,
  mute/deafen/share screen/disconnect). `voice/VoiceBar.jsx` sits above the user panel while
  connected (status, channel link, share screen, disconnect, errors); `UserPanel` has mute and deafen
  (`voice/VoiceControls.jsx`). A guild reopens on its last *text* (or list) channel.
- **Watch Together** (YouTube watch parties, like Discord's activity): everyone in a voice
  channel plays the same YouTube video at the same point. The server keeps each channel's queue
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
    box) with the title, Go to the voice channel and close (stops it on this device until you
    open the channel again). Its controls follow your permissions: play/pause, skip, the time,
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
  - `e2e/watchparty.mjs` checks it with real videos (needs the internet).
- **Not done yet:** a per-user local mute (Discord has one), push-to-talk, output volume above 100%, server mute/move (Mute Members, Move Members), a global
  push-to-talk key in the desktop app (it has global mute/deafen toggles; holding a key needs a
  native keyboard hook), noise suppression and the gate on the other side (for people whose
  app doesn't, like Discord's "suppress others' noise"), screen share in DM/group calls (LiveKit's E2EE
  would cover the video too), switching between a phone's front and back camera in a call,
  background blur, a camera spotlight (one camera big, like a watched stream), stream quality
  settings, and a TURN server for
  networks that block UDP 7882 and
  TCP 7881; Watch Together: a party surviving an API restart, other sites than YouTube,
  playlists, start times from links (`t=`). Phones: a PWA's audio stops when it's in the background (iOS also when locked; it
  rejoins when the app is back, see Lost connections). Staying in while locked needs a native
  app: background audio, and voice through LiveKit's native SDK (iOS also pauses microphone
  capture in a Capacitor WebView).

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
`/admin/voice-regions`), each a flag (an emoji), a name, its LiveKit address for the apps
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
  shows the menu only with two or more.
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
- **Not done yet:** screen sharing in calls, and the incoming
  call screen of a native app (a closed PWA only gets the notification).
