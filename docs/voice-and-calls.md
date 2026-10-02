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
  microphone, and only with Speak. One voice channel per user: getting a token for another
  removes you from the first. Who's actually in comes from LiveKit's **webhooks** (`POST
  /livekit/webhook`, signed with the API key): joined/left/room finished. The state is in memory
  (`states`), rebuilt from LiveKit's room list when the API starts (`restoreFromLiveKit`, only
  when run as the server). A "left" only counts for the session (sid) that's in, since joining
  from a second device replaces the first. After any guild change (`announceGuildUpdate`) and
  when a member is removed, `enforceGuild` disconnects whoever lost View/Connect and gives or
  takes away Speak live. Self mute/deafen: `PUT /voice/state` (kept in LiveKit participant
  attributes too, so a restart keeps them); `DELETE /voice` leaves. Everyone who can see the
  channel gets `guild_voice_state { guildId, channelId, userId, state }` (`state` null: left),
  and a voice channel in the layout has `voice: [{ user_id, username, self_mute, self_deaf,
  self_stream }]`.
  Without `LIVEKIT_*` settings voice is off: `/api/config` says `voiceEnabled: false`, joins 503.
- **Client** (`voice/voiceClient.js`, read with `hooks/useVoice.js`): one connection per
  device, a module-level store like `ws-client`. `livekit-client` is loaded on the first join
  (it's big). Joining must come from a click (browsers play sound only after one). Muted, the
  mic is released (`stopMicTrackOnMute`, the browser's recording light goes off); deafened,
  everyone's playback volume is 0 and you're muted too; unmuting undeafens (Discord's rules). Mute
  and deafen are remembered per device (`localStorage voicePrefs`) and work outside a call.
  `speaking` is LiveKit's active speakers. Being removed, or joining the same channel
  elsewhere, ends it with a message in the voice bar.
- **Playback** (`voiceClient`): others' voices play through Web Audio, LiveKit's `webAudioMix`
  in our own AudioContext (`playback`, one per connection, its `setSinkId` the chosen speakers;
  LiveKit's own context would miss the speakers chosen before joining): each remote track gets
  its own GainNode (`track.setVolume`), so volumes can go past 100%. Its `<audio>` element
  stays attached but muted (Chrome only feeds a remote stream to Web Audio while it plays). Where
  the browser can pick speakers for elements but not for an AudioContext (Firefox) it plays
  from the elements instead, capped at 100%. `applyVolumes` sets every track to
  `playbackVolume` (`userVolumes.js`: 0 deafened, else output volume × the person's volume
  (microphones only, not a screen share's sound)) on any change, and again after LiveKit
  restarts the audio (it rebuilds a gain and forgets a volume of 0).
- **Per-user volume** (like Discord's User Volume; `voice/userVolumes.js`, per device,
  `localStorage userVolumes`, by user id, 0–200%, the same for channels and calls): click (or
  right-click, Enter) someone else in a voice channel's list in the sidebar, their tile, or the
  DM/group call panel, once you're in that channel or call (`hooks/useVolumeMenu.js`), for
  `voice/UserVolumeMenu.jsx`: a slider and Reset, floating on a computer (placed like
  `ContextMenu`, `utils/menuPlacement.js`), a sheet on a phone. Applied live.
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
  `screen_share` and `screen_share_audio` only with Video (`publishPermission`), and
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
  plays it in a `<video>`). The stream's sound plays like the others' (deafen mutes it). UI: a
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
  per device, `localStorage audioSettings`; video settings go in the same section later):
  input and output device (output only where the browser has `setSinkId`), input volume
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
  (`levelOf`), played back through the chosen speakers. The app's sounds play
  through the chosen speakers too (`AudioContext.setSinkId`). Browsers name devices only once
  the page may use the microphone ("Allow it"). Each remote voice's `<audio>` element is kept
  per track (`audioElementsByTrack`): LiveKit has often detached it already by the time it
  says the track is gone, so `detach()` alone left empty elements behind.
- **UI:** in the channel list, people in a voice channel are listed under it (ringed while
  talking, when you're in there too). Clicking a voice channel joins it on desktop; on mobile a
  tap only opens it and you join from its page (`guild/VoiceChannelView.jsx`: tiles, Join Voice,
  mute/deafen/share screen/disconnect). `voice/VoiceBar.jsx` sits above the user panel while
  connected (status, channel link, share screen, disconnect, errors); `UserPanel` has mute and deafen
  (`voice/VoiceControls.jsx`). A guild reopens on its last *text* (or list) channel.
- **Not done yet:** a per-user local mute and a separate volume for someone's stream sound (Discord
  has both), push-to-talk, output volume above 100%, server mute/move (Mute Members, Move Members), a global
  push-to-talk key in the desktop app (it has global mute/deafen toggles; holding a key needs a
  native keyboard hook), noise suppression and the gate on the other side (for people whose
  app doesn't, like Discord's "suppress others' noise"), screen share in DM/group calls (LiveKit's E2EE
  would cover the video too), webcam video, stream quality settings, and a TURN server for
  networks that block UDP 7882 and
  TCP 7881. Phones: a PWA's audio stops when it's in the background (iOS also when locked; it
  rejoins when the app is back, see Lost connections). Staying in while locked needs a native
  app: background audio, and voice through LiveKit's native SDK (iOS also pauses microphone
  capture in a Capacitor WebView).

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
  only members of that epoch can open it; members added during a call join the next one.
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
- **Not done yet:** video, and the incoming
  call screen of a native app (a closed PWA only gets the notification).
