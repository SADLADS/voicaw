# Desktop app, Android app and info site

## Desktop app (Electron)

`electron/` wraps the client for Windows, macOS and Linux, adding only what a browser can't do.
Electron can't start on this server (no display): its main-process
logic has unit tests (`electron/test/`), and `e2e/desktop.mjs` checks the page side in Chrome
with a stand-in for the bridge. Check real behaviour on a desktop.
- **The page ships inside the app** (`protocol.js`): the client build (`npm run
  build:electron`, into `build/`, packaged as the `app` resource) is served at `voicaw://app/`, a
  privileged standard scheme, so it has a real origin (in the API's `allowedOrigins`), web
  security stays on, and routes are real paths (`BrowserRouter`; unknown paths get
  `index.html`, missing files 404, nothing outside the folder). The code holding the keys is
  what was installed, not what a server sends that day. No service worker there.
- **Window** (`main.js`): one instance (a second start focuses it), size and place remembered,
  no menu (a minimal one on macOS for copy/paste), dev tools only in a development run
  (Ctrl+Shift+I). Links to other sites open in the browser; the window never leaves
  `voicaw://app`. Only the app's pages get permissions (microphone and camera; notifications;
  screen capture, only of what was picked).
  `backgroundThrottling` is off so ringing and voice work from the tray.
  The only other windows the page may open are popped out (`windowOpen.js`, by name): a
  screen share (a blank window named `voicaw-stream`; see Screen sharing in
  `docs/voice-and-calls.md`) and Watch Together's player (`voicaw-watch-together`, only on
  `voicaw://app/popout.html`, which YouTube's player needs for its Referer; see Watch Together),
  both drawn into by the page itself: the app's icon, no menu, never navigate, open nothing,
  and may only go full screen. They stay open while the main window is in the tray. The app's
  own other window is the in-game overlay (below).
- **YouTube players** (`youtube.js`): YouTube refuses to play an embed without a Referer
  ("Error 153: Video player configuration error"), and Chromium sends none from `voicaw://`
  pages, so requests for youtube(-nocookie).com `/embed/` pages get `https://app.voicaw.com/`,
  what the web app sends anyway (see YouTube links in `docs/messages.md`).
- **Right-click and spellcheck** (`spellcheck.js`): the page draws its own right-click menus and
  checks spelling itself, as in a browser (see Spellcheck and Right-click menus in
  `docs/client.md`), so Electron shows no menu. Its own checker (set to the system's languages
  that have a dictionary, else `en-GB`; Electron downloads dictionaries on first use, macOS uses
  the system's) still underlines plain text boxes, and everything when the page has no
  dictionary for the language; the page then asks it for suggestions (`spelling.isMisspelled` /
  `suggestions`, webFrame in the preload) and keeps its custom dictionary to the account's words
  (`setSpellingWords` → `syncSpellingWords`). The menu's Paste is Electron's own (`paste`).
- **Bridge** (`preload.js` → `window.voicawDesktop`, wrapped by `client/src/utils/desktop.js`
  `desktop`, null in a browser): `notify`, `setUnread`, `getSettings` / `updateSettings`,
  `checkForUpdates` / `installUpdate`, `getScreenSources` / `chooseScreenSource`, `paste`,
  `spelling` / `setSpellingWords`, `fetchPage` (a linked page for an encrypted chat's link
  preview, `pageFetch.js`; see Link previews in `docs/messages.md`), `saveFile` (start / append /
  finish / cancel: a big attachment written to where the Save dialog says as it's decrypted,
  `fileSave.js`; see Big files in `docs/uploads.md`), `getActivities` / `onActivities` (Rich
  Presence, below), `setOverlayVoice` (the in-game overlay, below), `onNavigate`, `onShortcut`,
  `onUpdateReady`. The main process only answers the app's own frames (`fromApp`: the main
  page's, never the overlay's, which shares its origin) and checks what it's given
  (`cleanNotification`, `cleanChanges`, `cleanVoiceState`).
- **Notifications** (`notifications.js`): the server sends what would be a web push over the
  websocket (see Push notifications); `hooks/useDesktopApp.js` (in `Layout`) turns it into
  text with the service worker's `notificationFromPush` (DM previews decrypted on the device,
  same previews setting) and a data-URL picture, and the app shows it, one per tag (taken down
  by `closeNotification(tag)` when the chat is read anywhere; see Clearing read chats in
  `docs/realtime.md`). A click
  shows the window and navigates to its `url`. They're `silent`: the page plays the app's own
  sounds (see Sounds). On/off is Settings → Notifications
  (`pushService` treats the app as always permitted).
- **Screen sharing** (`screenShare.js`): Electron has no picker of its own for
  `getDisplayMedia`, so the share button opens ours (`voice/ScreenPicker.jsx`: Screens and
  Windows tabs with thumbnails from `desktopCapturer`, refreshed every 4 s, the app's own
  window left out; double click or Go Live). The page then says which (`chooseScreenSource`)
  and calls `getDisplayMedia` as a browser would; the session's display media handler answers
  with that source, once, within a minute, only for a source just listed and only for the
  app's own page; anything else is refused (the page gets an AbortError, shown as nothing).
  **Sound** ("Share sound", on by default) only on Windows: Electron's only option is the
  whole system's sound (`loopback`); the page asks with `restrictOwnAudio` (see Screen
  sharing in `voice-and-calls.md`) and Electron (44+) then captures it without the app's own
  sound, so viewers don't hear themselves, like Discord.
  macOS needs Screen Recording permission (the picker says where); Wayland goes through the
  system's portal picker.
- **Tray and badge** (`tray.js`): Open / Quit menu, and what's unread the way Discord counts
  it (`unreadSummary`: unread DMs and group messages plus guild mentions; guild messages that
  don't mention you don't count): a red dot on the tray icon, the count as the macOS dock
  badge, a red dot overlay on the Windows taskbar, or on Linux the launcher count (Unity, KDE)
  and a red dot on the window's own icon (what most taskbars show). The browser tab's
  favicon gets the same dot (see Favicon dot in `docs/client.md`).
- **Settings → Desktop App** (`DesktopAppSettings.jsx`, only in the app; stored by
  `desktopSettings.js` as `desktop-settings.json` in the app's data folder): keep running in
  the tray when closed (default on; macOS always), start at login (default on, as Discord's, since 2026-10-12; installs from before that got it
  turned on once, `startAtLoginChosen` marking a choice made in the box; `autoStart.js`: login
  items, or `~/.config/autostart/voicaw.desktop` on Linux; starts in the tray with `--hidden`), and
  global shortcuts for toggle mute / toggle deafen and the overlay's (`shortcuts.js`,
  `globalShortcut`; recorded from a key press with a modifier, `acceleratorFromEvent`; a key
  another app holds is reported), Activity's "Share what I'm playing" (Rich Presence, default
  on), and In-game overlay's "Show the overlay in games" (default on) and its corner.
- **Rich Presence** (`richPresence.js`, `gameLookup.js`, `gameActivities.js`; built 2026-10-09):
  games that show what you're doing in Discord tell the app instead, unchanged, and everyone
  sees it (see Activities in `docs/realtime.md`). Games talk to a local socket,
  `$XDG_RUNTIME_DIR` (else `TMPDIR`...) `/discord-ipc-N` or the pipe `\\?\pipe\discord-ipc-N`,
  in Discord's RPC protocol (frames of opcode, length, JSON: HANDSHAKE with the game's Discord
  application id, then SET_ACTIVITY; answered with READY and a stand-in user, PING/PONG,
  SUBSCRIBE said yes to, anything else an error), using the first one that answers. The app
  takes the first free slot of 0-9 (removing a dead socket file left behind), so a Discord
  started first keeps slot 0 and the games; started after Voicaw, it gets slot 1 and Voicaw
  gets them (as arRPC). An activity lasts until it's set to null or the game disconnects.
  **Nothing is asked of Discord** (decided 2026-10-09): the application id means nothing
  without Discord's catalogue, so the game's name and picture are found from the process id the
  game sends (`gameLookup.js`): first Steam, from `SteamAppId`/`SteamGameId`/`STEAM_COMPAT_APP_ID`
  in the process's environment (Linux, `/proc`; Proton games too) or the program's or an
  argument's path under a library's `steamapps/common/<dir>` (Wine's `Z:\` paths too) matched
  to that library's `appmanifest_<id>.acf` (libraries from `libraryfolders.vdf`; Steam's own
  tools such as Proton skipped), giving the name and the cover from Steam's
  `appcache/librarycache` (`<id>_library_600x900.jpg`, newer Steam's `<id>/` folder; else the
  header, else the icon). Games behind anti-cheat (Easy Anti-Cheat, BattlEye: Rust...) refuse to
  let other programs open their process, so on Windows `Get-Process` gives no path (2026-10-12:
  Rust showed as "a game"): then WMI's `ExecutablePath` is tried, and failing that the process
  name alone ("RustClient") is matched to the Steam game whose install folder holds that
  program (`steamGameForProgram`, its top or one folder down). Otherwise the program: Windows' product name or description (one
  PowerShell call; engine names like "Unity Player" skipped), a macOS `.app`'s name, a Wine
  program's `.exe`, a runner's script (python, java...), else the file name (all lower case capitalised:
  `feishin` → Feishin); its icon on
  Windows and macOS (`app.getFileIcon`; Linux only has the theme's generic ones). Nothing found:
  no name (people see "a game") and a gamepad. Pictures are cropped square and made at most
  128 px (`pictureFrom`: covers JPEG, icons PNG), looked up once per game. A game whose big
  picture (`assets.large_image`) is a web address (`https://…`, or Discord's
  `mp:external/<hash>/https/host/path`, turned back into the address) gets that picture instead:
  music players do this with album covers on the person's own server (Feishin's "Serve Discord
  images from server" with Navidrome or Jellyfin, added 2026-10-09). The main process downloads
  it (`fetchPicture`: Node's fetch, 8 s, at most 10 MB, an `image/*` that nativeImage can read,
  so PNG or JPEG; private addresses allowed, since it's the person's own computer asking, so a
  home server works, unlike in Discord), caches the last 50 addresses, and shares only the small
  copy: viewers and the server never see the address (it can hold a token) or ask that server.
  Anything else in that field is a Discord asset key, which only Discord can look up, so the
  program's picture is used. The page gets the
  cleaned activities (`gameActivities.js`: Discord's types Playing, Listening, Watching,
  Competing; details, state, start/end in ms, party size, the big picture's hover text) and
  shares them (`setOwnActivities` in `ws-client.js`). A small picture (`assets.small_image`/
  `small_text`) that says playing or paused (`playing`/`play`, `paused`/`pause`: Feishin's keys)
  becomes `smallIcon` 'playing' | 'paused' (2026-10-09), drawn by the page as its own play or
  pause badge on the picture's corner with `smallText` as the hover text. Games' asset-key
  pictures (only Discord can resolve them), other small pictures and buttons aren't shown; games that don't use Rich Presence aren't
  detected. Turning it off closes the socket. Checked for real in `e2e/richpresence.mjs`.
- **In-game overlay** (`overlay.js`, `overlayPreload.js`, `runningGames.js`; client
  `overlay.html`, `src/overlay/`, `hooks/useGameOverlay.js`, `utils/overlay.js`; built
  2026-10-19, as Discord's): while you're in a voice channel or call **and** a game is running,
  a small window over the game lists who's there (you first, then in the order they joined;
  the green ring while they talk, mute and deafen icons; the others dimmed while locked) and
  shows the app's notifications as toasts (6 s, three at most) instead of the system's.
  - **A game** is a Rich Presence activity that's Playing or Competing (not music or videos),
    or a Steam game among the running programs (`runningGames.js`, so games without Rich
    Presence count): on Linux any of our processes with Steam's `SteamAppId`/`SteamGameId` in
    its environment (Proton games too) or a `steamapps/common` path among its arguments; on
    Windows WMI's paths under `steamapps\common` (one PowerShell call); on macOS `ps`. Steam's
    tools (Proton, the runtime) and app id 0 don't count; the installed apps are listed again
    every 10 minutes. Looked for every 15 s, and at once on joining voice or turning it on, only
    while it could show (in voice, overlay on); nothing about it leaves the computer. With
    "Share what I'm playing" off, Steam games are still found, but other games aren't (they
    can only say so through Rich Presence's socket, which is then closed).
  - **The window**: transparent, frameless, `focusable: false`, out of the taskbar, always on
    top at the `screen-saver` level (macOS: on every Space, over full-screen apps), the mouse
    going through it (`setIgnoreMouseEvents`). It goes on the screen the pointer is on when it
    appears, 16 px from the chosen corner (Settings or the overlay itself; default top left),
    exactly the size of its content (the page reports it, `size`; 360×720 at most), so a
    Linux desktop without a compositor (no transparency) only gets a small dark box. Made when
    it's needed and destroyed when it isn't (a renderer costs memory). Never in Gaming Mode
    (gamescope shows one app at a time). It draws over windowed and borderless games; a
    Windows game in exclusive full screen keeps it out (Discord gets in by injecting into the
    game's drawing, which we don't), and so may a Wayland session's own windows.
  - **Unlocking**: the overlay's shortcut (Settings → Desktop App → Keyboard shortcuts, "Use
    the overlay", default **Ctrl+Shift+O**, ⌘⇧O on macOS; Discord's is Shift+\`) is only taken
    while the overlay is up, so other apps have it the rest of the time (otherwise it's only
    checked, `applyShortcuts`' `checkOnly`, so a key another app holds is still reported). It
    unlocks it: the window covers the screen, takes the mouse and focus and dims the game; the
    panel adds the channel's name, mute, deafen and disconnect (sent to the main page as
    shortcuts, `onShortcut`: 'toggleMute' / 'toggleDeafen' / 'disconnect'), the corner, Open
    Voicaw (the main window) and Close. The shortcut again, Escape, Close or a click on the
    dimmed part locks it; clicking a toast opens its chat in the main window. "Press Ctrl +
    Shift + O to use the overlay" shows for 6 s when it appears.
  - **What it knows**: only what the main page sends it, through the main process: the voice
    state (`useGameOverlay` in `Layout`, made by `overlayVoiceState`: the voice bar's title,
    each person's display name, picture address (`avatarUrl`), talking, muted, deafened (from
    the guild channel's voice states; calls have none)) whenever it changes, and the
    notifications as the app would show them (previews decrypted by the main page, or "New
    message"). It has no login, keys or API access; its bridge (`window.voicawOverlay`) only
    receives `overlay:state` / `overlay:toast` and sends `overlay:message`, which the main
    process checks (`handle`: only those message types, a corner from the list, a chat path).
    The voice snapshot's `participants` (`voiceClient.js`) is who's in the room.
  - Checked for real in `e2e/overlay.mjs` (the app under Xvfb, a stand-in Steam game, the
    shortcut pressed through XTest).
- **Splash window** (`splash.js`, `assets/splash.html`, `splashPreload.js`; built 2026-10-08, as
  Discord's): a small frameless window (square on Linux, which has no transparent windows without
  a compositor) with the bird in a ring, shown while the app starts. It looks for an update
  (`updater.js` `launch`, up to 5 s; offline or slow, the app just opens) and, if there is one,
  downloads it with the ring filling and restarts onto it before the app opens (decided the same
  day: everyone starts on the latest version, page included). After 10 s of downloading it
  offers "Start anyway" (the download carries on and the page offers it once ready; the main
  window re-announces a ready update when its page loads). Then "Starting" until the main
  window is on screen. Started at login (`--hidden`), there's no splash: the app opens to the
  tray and updates in the background as below. `e2e/desktopsplash.mjs` draws each state and
  starts the real app under Xvfb.
- **Steam Deck Gaming Mode** (`gamingMode.js`, `appImageInstall.js`; 2026-10-13): Gaming Mode
  runs the AppImage, added to Steam as a non-Steam game, as one full-screen "game" under
  gamescope: no taskbar, no tray, no window manager, and Steam counts the game as over once the
  process it started exits. A friend's report (it crashed there, and couldn't be quit, while
  Desktop Mode was fine) wasn't reproducible here; what's below fixes the causes found by reading
  the code. Detected by `XDG_CURRENT_DESKTOP=gamescope` or `GAMESCOPE_WAYLAND_DISPLAY` (Linux only;
  Desktop Mode is plain KDE and is unchanged). There: closing the window quits (closing to a tray
  that isn't there left it running invisibly, Steam still thinking the game ran, and the
  single-instance lock made every new start quit at once); no splash, so no update-and-restart at
  launch (the restarted copy is outside Steam's view); updates download in the background
  without the page being told (no "Restarting…" banner), installing when the app quits, and
  Settings' "Update now" quits without restarting; `--ozone-platform=x11` (gamescope shows X11
  apps through its Xwayland). Settings → Desktop App's tray box still shows but does nothing
  there. **AppImage updates keep the file's name** (everywhere, not only on the Deck):
  electron-updater moved the download in under the new version's name (`Voicaw-1.0.1.AppImage`)
  and deleted the old file, so a Steam shortcut or menu entry pointing at it launched nothing
  after the first update; `keepAppImageName` replaces its install with the same steps writing
  over `$APPIMAGE`. The update that brings this still renames once (the old version installs
  it), so a shortcut made before then needs pointing at the new file once.
  `e2e/desktopgamingmode.mjs` fakes Gaming Mode under Xvfb; not yet tried on a real Deck.
- **Windows installer** (`installer/installer.nsh`, electron-builder's `nsis.include`): the
  one-click installer shows a borderless window like the splash instead of electron-builder's grey
  box: `installer/splash.bmp` / `splash@2x.bmp` (drawn from the splash page by
  `installer/render-art.mjs`: rerun it after changing the splash's look), "Installing Voicaw" or
  "Installing update" (an update runs the same installer) and a flat purple progress bar. It's
  DPI aware, taking the 2x art from 150%. It hooks electron-builder's template: the install
  page's show function restyles NSIS's window, and `customCheckAppRunning` (run just after the
  template's `SpiderBanner::Show`, which shrinks the window into its own box) puts it back, then
  runs the template's own running-app check. Check it after upgrading electron-builder: README
  "Desktop app" (trying the installer under wine).
- **Updates** (`updater.js`, electron-updater): the installed app looks for a new version at
  start (the splash, above) and every 4 hours on the generic feed in `builder.config.js` (`https://updates.voicaw.com/desktop/`: its own static
  site, `/opt/voicaw-updates`, nginx config in `updates/nginx/`, a download page from
  `updates/site/`, filled by `node updates/publish.mjs`; README "Desktop app"), downloads it, and the page offers "Update now" (UpdateBanner,
  Settings → App version, which also shows the app's version); that restarts onto it. It keeps
  looking once one is ready, and "Update now" looks once more first (up to 5 s), so the app
  restarts onto the latest release, not the first one it noticed; electron-updater keeps only one
  download, so a newer one replaces the ready one and "Update now" waits for it, showing its
  progress (`onUpdateProgress`), and offers it again if it fails. A
  development run or an unsigned macOS app can't update itself ('unsupported'). An AppImage
  keeps its file name across updates, and in the Steam Deck's Gaming Mode nothing restarts (both
  above). Releases are
  only as trustworthy as that server (no signature of our own on the feed yet).
- **Releases built by GitHub** (`.github/workflows/desktop-release.yml`, run by `release_all.sh`;
  README "Desktop app"): a pushed `desktop-vX.Y.Z` tag builds the Linux and Windows installers
  on GitHub's machines from that commit (the version stamped in by `VOICAW_VERSION` in
  `builder.config.js`, `electron/package.json` untouched), attests each file and feed
  (`actions/attest-build-provenance`: Sigstore, in its public log) and makes a GitHub Release.
  The host downloads it, refuses anything whose attestation doesn't name that workflow, tag and
  commit (`gh attestation verify`), then publishes as before. So anyone can check an installer
  against the public source, and nothing built on the host is shipped. The app itself doesn't
  check attestations before installing an update yet: until it does, updates.voicaw.com is
  still trusted for automatic updates.
- **Turning updates off** (Settings → Desktop App → Update automatically, `autoUpdate` in
  `desktopSettings.js`, on by default): off, the app never looks by itself, not at launch (the
  splash just opens it) nor every 4 hours; only Settings → App version's "Check for updates"
  asks the feed, and what it finds is downloaded and offered as usual. Turning it back on looks
  at once. For people who build the app themselves to know what runs (the server would otherwise
  replace their build with the published one): `VOICAW_AUTO_UPDATE=off` at build time
  (`builder.config.js` writes `voicawAutoUpdate` into the packaged `package.json`) makes it off
  from the first launch.
- **Not done yet:** push-to-talk (held key), screen share sound on macOS and
  Linux (Electron's loopback is Windows only), streaming videos (no
  service worker: they download whole on Play; `protocol.js` could serve them instead), code
  signing (Windows SmartScreen warns about unsigned installers). Notifications while the app
  isn't running aren't wanted (decided 2026-10-01).

## Android app (Capacitor)

`mobile/` wraps the client for Android (Capacitor 8, Java), like the desktop app, adding only
what a browser can't do: notifications and ringing while the app is closed, call buttons, and
keeping a call going with the screen off. Android can't run on this server either: the native
side has JUnit tests (`mobile/android/app/src/test/`, run by the build), `mobile/test/` checks
the packages agree, and `e2e/android.mjs` checks the page side in Chrome with a stand-in for the
native bridge. Check real behaviour on a phone.
- **Build** (`npm run dist:android`, README "Android app"): the client's Android build
  (`ANDROID=true vite build --mode android` into `build-android/`, with `notify.html` as a second
  page), `cap sync` copies it into the APK, Gradle runs in Docker (`mobile/dist-android.sh`,
  image from `mobile/Dockerfile`). Min Android 8.0.
- **Releases** (`./build-android.sh`, README "Android app"): versions follow the update site
  (`updates/publish-android.mjs next`: one higher than published), stamped into the build
  (`VOICAW_VERSION` → Gradle's versionName / versionCode X·10000 + Y·100 + Z, and the user agent
  in the config `cap sync` generated), never into tracked files. Signed with the release key
  (`mobile/make-release-key.sh`, `~/.voicaw-android-keys`, mounted read-only into the build;
  the same key forever, or phones refuse updates). Published as
  `updates.voicaw.com/android/voicaw-<version>.apk` (cached for good), `releases.json` and
  `voicaw.apk` (the newest; neither cached), but no longer offered anywhere (2026-10-06): only the
  copies already installed from there use them, to update themselves. New people get the app from
  Google Play's closed test (see Info site). Each release also builds the same version as the
  `play` flavour's App Bundle (`dist-android/voicaw-<version>-play.aab`, `bundlePlayRelease`,
  same key; README "Android app": Play uses our own signing key, so the two builds can replace
  each other). `release_all.sh` releases Android with the desktop app, as the same version:
  GitHub's release workflow builds both files unsigned and attests them, the host signs them
  (`mobile/sign-android.sh`, so the key never goes to GitHub), publishes the APK, adds it to the
  GitHub Release (anyone can check it's the attested build plus a signature, `apksigcopier
  compare`), uploads the bundle to Google Play's closed-testing track
  (`updates/publish-play.mjs`, the Play Developer API with a service account; by hand while
  there's no key) and pushes the `android-vX.Y.Z` tag. `build-android.sh` alone builds and
  publishes on the host and tags locally; desktop releases are `desktop-vX.Y.Z`.
- **Two builds** (Gradle flavours): `direct`, the APK above, which updates itself, and `play`,
  for Google Play, which mustn't (Play's rules: an app from Play updates only through Play, and
  the permission to install packages is restricted). The updater and that permission live only in
  `src/direct/`; `src/play/` has an `AppUpdater` that says it's unsupported. `dist-android.sh`
  builds `direct` and only compiles `play` (making Play's bundle comes with publishing there).
  Both are signed with the same key, so either can replace the other (README "Android app").
- **Updating itself** (`direct` only, `AppUpdater.java`, `UpdateStatusReceiver.java`; the page's
  side is `utils/appUpdate.js` `watchAndroidUpdates`): the app reads `releases.json`
  (`BuildConfig.UPDATE_URL`, `VOICAW_UPDATE_URL` at build time) when it starts, every 4 hours and
  on coming back after 30 minutes (still, once one is offered, so a newer release replaces it),
  and if its versionCode is higher, `UpdateBanner` and Settings → App Version offer it with its
  size; "Update" reads `releases.json` again, so it downloads the latest. Nothing is downloaded until the person taps Update (tens
  of MB, maybe on mobile data). Then the APK goes into the app's cache with its progress shown,
  and is checked against `releases.json` (size, SHA-256, file name) and the installed app (same
  package, that version, signed with the same key), then handed to Android's `PackageInstaller`.
  Android always asks the person to confirm (and the first time, to allow installs from Voicaw).
  Cancelled or failed, the banner offers it again. Installing closes the app, so the new version
  posts an "updated, tap to open" notification (`MY_PACKAGE_REPLACED`, only after an update the
  app started). The hash only catches a broken download, since it comes from the same server as
  the APK. What stops a swapped APK is Android refusing an update signed with another key; the
  app checks the signature first only to fail with a clear reason.
- **The page ships inside the app**: Capacitor serves the build at `https://localhost/` (in the
  API's `allowedOrigins`), so the code holding the keys is what was installed. No service worker
  (`main.jsx`; no streamed videos either, as in the desktop app). Backups are off
  (`allowBackup`, `data_extraction_rules.xml`): the page's storage holds the encryption keys.
  Back goes back in the app's history, and from the first page leaves the app running. Its
  user agent ends in `VoicawAndroid/<version>` (`appendUserAgent`, the same as `versionName`;
  a test checks), so Settings → Devices calls it "Voicaw Android app".
- **Bridge**: the `Voicaw` plugin (`VoicawPlugin.java` → `client/src/utils/android.js`
  `android`, null elsewhere): `checkNotifications` / `requestNotifications` (Android's
  permission; whether calls may ring full screen, which Android 14 lets people turn off; whether
  the build has Firebase), `getPushToken`, `setOngoing` / `clearOngoing`, `stopRinging`,
  `openSettings`, `checkForUpdate` / `installUpdate` (Updating itself), `setSystemBars`
  (System bars), `keepScreenOn` (while recording a voice message, see Voice messages in
  `docs/uploads.md`), `saveFileStart` / `saveFileAppend` / `saveFileFinish` / `saveFileCancel`
  (Saving files), `showToast`, `mediaAccess` / `requestMediaAccess` / `listMedia` /
  `mediaThumbnail` (the + panel's photos, `Media.java`, see The + panel in `docs/uploads.md`;
  `openSettings({ which: 'app' })` when photos were refused), `fetchPage` (a linked page for an
  encrypted chat's link preview, `PageFetch.java`; see Link previews in `docs/messages.md`); events `navigate` (a
  tapped notification), `callAction` (`answer` with a call id, `mute`, `unmute`, `hangUp`),
  `updateProgress` and `updateResult`, kept until the page listens, so a notification that
  started the app still counts (and `Layout`'s landing on /dm, opening the latest
  conversation, gives way to it; `e2e/notificationtap.mjs`). `hooks/useAndroidApp.js` (in
  `Layout`) is the page's side.
- **System bars** (`MainActivity` `keepClearOfSystemBars`): the page never goes under the status
  bar, the navigation bar, a camera cutout or the keyboard, on any Android version. The window
  is edge to edge (as Android 15+ makes every app targeting it), the app pads itself by the bars
  at the top and sides and by the keyboard or the navigation bar (whichever is taller) at the
  bottom, and the WebView is told of no insets at all, so `env(safe-area-inset-*)` is 0 there and
  the WebView simply shrinks for the keyboard, as Chrome does with `resizes-content`. Capacitor's
  own handling is off (`SystemBars.insetsHandling: "disable"`, a test checks): with a WebView
  140+ it draws the page under the status bar for the page to pad itself (the page doesn't:
  people's Android 15 phones had the chat header under the clock), and what it tells the page
  while the keyboard is up depends on the WebView's version (the likely cause of a gap people
  saw between the message box and the keyboard, 2026-10-06). What
  shows behind the bars is the theme's `--vc-bg-base`, with dark or light icons to match:
  `utils/theme.js` `applyTheme` calls `setSystemBars` (`android.js` `setAndroidSystemBars`), and
  `MainActivity` puts it back after every configuration change (Capacitor's SystemBars resets
  it to the system theme's, a rotation too).
- **Saving files** (`Downloads.java`, `android.js` `saveToDownloads`, used by
  `utils/saveFile.js`): Android's WebView ignores `<a download>`, and the page's files
  (decrypted attachments, pictures, the recovery code) are `blob:` URLs no other app can read,
  so Download / Save sends the bytes to the app in 512 KB base64 pieces, written straight into
  the phone's Downloads folder (MediaStore on Android 10+, no permission; on 8 and 9 the folder
  itself, asking for `WRITE_EXTERNAL_STORAGE`, `maxSdkVersion` 28), then a toast says so.
  "Open in new tab" on a `blob:` saves the file the same way and opens it in the app for its
  type. Guilds' plain file links (https) still open in the phone's browser, which downloads them.
- **Notifications** (`PushService.java`, `Notifications.java`): Firebase Cloud Messaging, the
  only way to wake a closed Android app. The phone registers its FCM token with a 256-bit key
  it made (`PushCrypto.deviceKey`) as a push subscription (`{ endpoint: 'fcm:<token>', fcm:
  { token, key } }`, `/save-subscription`; `pushService.js` asks Android instead of the browser);
  `sendPushToUser` sends it the same payloads as web push through `server/fcm.js` (HTTP v1 API,
  service account in `FCM_SERVICE_ACCOUNT`), each sealed with that key (AES-256-GCM over
  deflated JSON) because FCM, unlike web push, doesn't encrypt to the device. Google sees when a
  phone gets something and its size, as with Chrome's web push. The words come from the app's
  hidden page (`NotifyRenderer.java` loads `notify.html` → `src/android/notifyPage.js` in an
  invisible WebView at the same origin, so the same storage): it runs the service worker's
  `notificationFromPush`, so DM and group previews are decrypted with the keys the app already
  keeps, the same previews setting applies, and nothing of the encryption is written twice. The
  push's own text if the page can't (8 s), except a reaction in an encrypted chat, dropped then
  (and whenever the page answers `skip`: a poll vote; see Reaction notifications in
  `docs/realtime.md`). Channels (each with its own sound in Android's
  settings): Messages, Mentions, Incoming calls, Missed calls, Ongoing call. One notification per
  conversation (its tag), cancelled by a `notification_clear` push once that chat is read on any
  device (see Clearing read chats in `docs/realtime.md`); silent while the app is in front (the
  page plays its sounds). A token
  Firebase drops is forgotten (`UNREGISTERED`); a new token is registered the next time the app
  opens.
- **Calls ringing**: a call's push carries `callId` and `ringing`. The phone rings with a
  CallStyle notification (Answer / Decline, the ringtone until it stops, 45 s at most) and a
  full-screen ringing screen over the lock screen (`IncomingCallActivity`: name, picture, two
  buttons; Answer asks to unlock first, so nothing of the app shows on the lock screen). Answer
  opens the app, which answers once the call reaches it (`answerWhenRinging`); Decline is sent
  by the hidden page with the app's login, the app needn't open. The page itself doesn't ring
  when the phone does (`callClient.js`). Ringing stops on `call_stop` (the server sends it to
  Android apps only, `sendToAndroidApps`, when the call is answered or declined on another
  device, or they're out of it), on the "Missed call" push (which replaces it), or when the
  page sees the call stop ringing.
- **Ongoing call** (`CallService.java`): while in a call or voice channel, a foreground service
  (microphone type, with a wake lock) keeps the app and its audio running with the screen off
  (not the camera: Android stops a camera in the background, so others see yours freeze until
  the app is back; the `CAMERA` permission is asked for by the WebView when you first turn
  yours on, and the camera isn't required to install);
  its notification shows what the voice bar shows (`utils/voiceTitle.js`) with Mute / Unmute and
  Hang up (Disconnect in a voice channel).
- **Settings → Android App** (`AndroidAppSettings.jsx`): whether calls ring over the lock screen
  (a button to Android's setting when not), Android's notification settings, and Recent
  notifications: the last 20 pushes and what became of each (`PushLog.java`: shown, shown
  silently, ringing, channel off, couldn't open, the page couldn't word it, an error), only
  times and outcomes, to find where one got stuck without the phone's logs. The test
  notification (Settings → Notifications) always alerts, even with the app open.
- **Not done yet**: Google Play for everyone (it's a closed test, 2026-10-06), Bluetooth headset
  buttons and phone calls interrupting ours (Android's Telecom API), replying from a
  notification, the unread count on the icon, push-to-talk, screen sharing, iOS.

## Info site (voicaw.com)

The app is at app.voicaw.com; voicaw.com is a static info and download page (`website/`,
README "voicaw.com and app.voicaw.com"). `website/build.mjs` fills `website/src/index.html`'s
`{{PLACEHOLDERS}}` with the newest desktop version and installer links (from the update site's
`desktop/releases.json`, linking to updates.voicaw.com), so the page needs no script for them;
a small inline one offers the visitor's own system first, tells a home screen icon from
before the move that the app has moved, and sends the Android test's form.

**Look** (2026-10-16): plain and editorial rather than a template's centred hero and grid of
icon cards: a big left-aligned headline, real pictures of the app (`screenshot-desktop.png`
with `screenshot-phone.png` over its corner; phones see only the phone's), then sections
with their title on the left under a rule. Its type is Schibsted Grotesk (OFL), served from
voicaw.com itself (`schibsted-grotesk.woff2`), so no font service sees visitors; the docs and
policies share it through `style.css`. The pictures are taken by `e2e/sitescreenshot.mjs`
(a made-up guild in the throwaway app): run it again when the app's look changes.

**Android: Google Play's closed test** (2026-10-06). The Android row, and the button phone
visitors get first, lead to the page's `#android-test` section: how to join, links to the test's
opt-in page and the Play listing (`PLAY_TEST_URL`, `PLAY_URL` in `build.mjs`), and a form (Google
account email, optional name and note, a hidden field that catches bots) posting to
`/api/tester-requests` through voicaw.com's `/api/` (`server/routes/testerRequests.js`: no
account, 5 an hour per IP, at most 1000 waiting; the same email again replaces the name and note).
Admins see the requests in Settings → Admin → Android testers (live, over the websocket),
copy the waiting emails, add them to the test's tester list in the Play Console by hand, then
mark them added and delete them when done. Nothing tells the person: Play lets them in once
they're on the list. When the app is open to everyone, link the card to Play and drop the form. `updates/publish.mjs` rebuilds it after publishing (not
for a try-out folder, unless `VOICAW_SITE_DIR` is set), so `desktop-release/release.sh` keeps it
current. nginx (`website/nginx/voicaw.com`) keeps voicaw.com's `/api/` (installed desktop apps,
older builds and copied webhook URLs use it) and redirects any other unknown path to the same
one on app.voicaw.com; `website/src/service-worker.js` replaces the old app's service worker
in browsers that installed it there, and removes itself. Keep the page's claims true to what
the app does (e.g. guilds aren't end-to-end encrypted).

The bot API's documentation (`/developers/docs/`, see `docs/bots.md`) is part of the site:
`website/src/developers/` holds a shared `template.html` (side menu, "On this page") and one
fragment per page, listed in `build.mjs` `DOCS` and written as `developers/docs/<slug>/index.html`
(nginx: `try_files $uri $uri/index.html @app`). Keep it true to `server/routes/botApi.js` and
`server/gateway.js` when they change.

**Policies** (`/privacy/`, `/terms/`, `/delete-account/`; Google Play needs all three, and the
privacy policy linked inside the app too: Settings → About): fragments in `website/src/legal/`
in a shared `template.html`, listed in `build.mjs` `LEGAL` with the date each last changed,
written as `<slug>/index.html` like the docs. Who runs Voicaw, the contact address, the governing
law and the minimum age are `LEGAL_FACTS` in `build.mjs`; while one is empty its pages show
"[… not set]" and the build warns. Every claim was checked against the code (2026-10-05): keep
them true (CLAUDE.md, Privacy policy). Logins forgotten after 30 days unused is
`auth.js` `startSessionCleanup` (hourly), which the policy relies on.
