# Desktop app and info site

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
  `voicaw://app`. Only the app's pages get permissions (microphone, not camera; notifications;
  screen capture, only of what was picked).
  `backgroundThrottling` is off so ringing and voice work from the tray.
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
  **Sound** ("Share sound", off by default) only on Windows: Electron's only option is the
  whole system's sound (`loopback`); the page asks with `restrictOwnAudio` (see Screen
  sharing in `voice-and-calls.md`) and Electron (44+) then captures it without the app's own
  sound, so viewers don't hear themselves, like Discord.
  macOS needs Screen Recording permission (the picker says where); Wayland goes through the
  system's portal picker.
- **Tray and badge** (`tray.js`): Open / Quit menu, a red dot on the icon while anything is
  unread, the count (`unreadSummary`: unread DMs and group messages plus guild mentions) as
  the macOS dock badge, a Windows taskbar overlay, or the Linux launcher count.
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
  Settings → App version, which also shows the app's version); that restarts onto it. A
  development run or an unsigned macOS app can't update itself ('unsupported'). Releases are
  only as trustworthy as that server (no signature of our own on the feed yet).
- **Not done yet:** push-to-talk (held key), screen share sound on macOS and
  Linux (Electron's loopback is Windows only), streaming videos (no
  service worker: they download whole on Play; `protocol.js` could serve them instead), code
  signing (Windows SmartScreen warns about unsigned installers). Notifications while the app
  isn't running aren't wanted (decided 2026-10-01).

## Info site (voicaw.com)

The app is at app.voicaw.com; voicaw.com is a static info and download page (`website/`,
README "voicaw.com and app.voicaw.com"). `website/build.mjs` fills `website/src/index.html`'s
`{{PLACEHOLDERS}}` with the newest desktop version and installer links (from the update site's
`desktop/releases.json`, linking to updates.voicaw.com), so the page needs no script for them;
a small inline one only offers the visitor's own system first and tells a home screen icon from
before the move that the app has moved. `updates/publish.mjs` rebuilds it after publishing (not
for a try-out folder, unless `VOICAW_SITE_DIR` is set), so `desktop-release/release.sh` keeps it
current. nginx (`website/nginx/voicaw.com`) keeps voicaw.com's `/api/` (installed desktop apps,
older builds and copied webhook URLs use it) and redirects any other unknown path to the same
one on app.voicaw.com; `website/src/service-worker.js` replaces the old app's service worker
in browsers that installed it there, and removes itself. Keep the page's claims true to what
the app does (e.g. guilds aren't end-to-end encrypted).
