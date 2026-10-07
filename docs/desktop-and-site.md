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
  The only other window the page may open is a popped-out screen share (`windowOpen.js`: a
  blank window named `voicaw-stream`, which the page draws into itself; see Screen sharing in
  `docs/voice-and-calls.md`): the app's icon, no menu, never navigates, opens nothing, and may
  only go full screen. It stays open while the main window is in the tray.
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
  `spelling` / `setSpellingWords`, `onNavigate`, `onShortcut`, `onUpdateReady`. The main
  process only answers the app's own frames and checks what it's given (`cleanNotification`,
  `cleanChanges`).
- **Notifications** (`notifications.js`): the server sends what would be a web push over the
  websocket (see Push notifications); `hooks/useDesktopApp.js` (in `Layout`) turns it into
  text with the service worker's `notificationFromPush` (DM previews decrypted on the device,
  same previews setting) and a data-URL picture, and the app shows it, one per tag. A click
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
  the tray when closed (default on; macOS always), start at login (`autoStart.js`: login items,
  or `~/.config/autostart/voicaw.desktop` on Linux; starts in the tray with `--hidden`), and
  global shortcuts for toggle mute / toggle deafen (`shortcuts.js`, `globalShortcut`; recorded
  from a key press with a modifier, `acceleratorFromEvent`; a key another app holds is
  reported).
- **Updates** (`updater.js`, electron-updater): the installed app looks for a new version at
  start and every 4 hours on the generic feed in `builder.config.js` (`https://updates.voicaw.com/desktop/`: its own static
  site, `/opt/voicaw-updates`, nginx config in `updates/nginx/`, a download page from
  `updates/site/`, filled by `node updates/publish.mjs`; README "Desktop app"), downloads it, and the page offers "Update now" (UpdateBanner,
  Settings → App version, which also shows the app's version); that restarts onto it. It keeps
  looking once one is ready, and "Update now" looks once more first (up to 5 s), so the app
  restarts onto the latest release, not the first one it noticed; electron-updater keeps only one
  download, so a newer one replaces the ready one and "Update now" waits for it, showing its
  progress (`onUpdateProgress`), and offers it again if it fails. A
  development run or an unsigned macOS app can't update itself ('unsupported'). Releases are
  only as trustworthy as that server (no signature of our own on the feed yet).
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
  same key), uploaded to the Play Console by hand (README "Android app": choose to use our own
  signing key, so the two builds can replace each other).
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
  (System bars), `saveFileStart` / `saveFileAppend` / `saveFileFinish` / `saveFileCancel`
  (Saving files), `showToast`; events `navigate` (a
  tapped notification), `callAction` (`answer` with a call id, `mute`, `unmute`, `hangUp`),
  `updateProgress` and `updateResult`, kept until the page listens, so a notification that
  started the app still counts. `hooks/useAndroidApp.js` (in `Layout`) is the page's side.
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
  push's own text if the page can't (8 s). Channels (each with its own sound in Android's
  settings): Messages, Mentions, Incoming calls, Missed calls, Ongoing call. One notification per
  conversation (its tag); silent while the app is in front (the page plays its sounds). A token
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

**Android: Google Play's closed test** (2026-10-06). The Android card, and the button phone
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
