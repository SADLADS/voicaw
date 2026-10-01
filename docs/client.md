# Client structure, profiles, sounds, admin settings

## Client structure

- Component files export only components (Vite hot reload needs that; lint enforces it).
  Contexts live in `contexts.js` (`ConfigContext`, `InteractionContext`, `LayoutContext`) and
  `hooks/useAuth.js`; logic lives in `hooks/` and `services/`.
- `AuthProvider.jsx` — fetches `/api/profile` on mount to restore the session (id, username, JWT)
  into `useAuth`; the keys come from IndexedDB (`keyStore`). `services/authService.js` does the
  OPAQUE login/register (`Login.jsx` is just the form).
- `App.jsx` — top-level routing (`BrowserRouter`; `HashRouter` only for a page opened from a
  file); provides `ConfigContext` (fetched from
  `/api/config`) and `InteractionContext` (`isMobile`: the phone or computer layout, detected
  from the user agent; not a setting, since the wrong one is unusable, removed 2026-10-01)
- `Layout.jsx` — the logged-in shell: sidebars, users list and unread counts (`LayoutContext`).
  `DmSidebar` draws the unread dots from those counts. `SidebarWrapper` puts the sidebars in a
  row with `UserPanel` across the bottom: your picture, name, this device's connection state
  (`ws-client` `getConnectionState`/`onConnectionState`: online / connecting / offline) and the
  settings button. Clicking the picture and name opens `UserMenu` above it: your picture, name
  and custom status (click to change it there), Edit Profile and Log out. It's shown under the DM list, a guild's channel list, and Settings' column on
  a computer (Layout adds an empty column, `settingsNavSlot` in `LayoutContext`, and `Settings`
  draws its column into it with a portal; on a phone the column stays in the page, without
  the panel).
  Uploading a profile picture calls `announceProfilePictureChange()` so it refreshes.
- Mobile message actions: there's no hover menu on mobile. A long press on a message
  (`hooks/useLongPress.js`, 450ms, cancelled by scrolling) opens `MessageActionSheet`: quick
  reactions (most used first, then 👍❤️😂😮😢🙏) and `+` for the full picker, Reply, Edit,
  Copy text (attachments become their names, never their key-carrying links) and Delete (asks
  first). On desktop the hover menu's delete asks too (`ChatPane`: a "Delete message" dialog
  showing the message; Enter confirms), unless Shift is held while clicking. The sheet ignores the click Chrome fires when the holding finger lifts (it lands on the
  sheet); only clicks from a touch that started on it count. Messages aren't text-selectable
  on mobile, so the long press isn't taken by text selection.
- DM view: `Dm.jsx` puts together `hooks/useConversation.js` (keys, history, paging, send/edit/
  delete, live websocket updates), `hooks/useReactions.js`, `MessageList.jsx` (+ `MessageReactions`,
  `UrlPreviews`) and `Composer.jsx` (message box, emoji, reply bar, attachments via
  `hooks/useAttachmentDrafts.js`). `Dm.jsx` owns what several of them share: reply target, edit
  state, the composer error line, and which emoji picker is open (never both).
- Settings (`Settings.jsx`, `/settings`): sections (each with a category, title and search
  keywords, in its `sections` list) under My Account, App Settings, Admin (only once
  `AdminSettings` finds you're an admin) and About. The side column (beside the rail, above
  the user panel, on a computer; on top of the page on a phone)
  searches them (non-matching sections are hidden, not unmounted, so their state stays) and
  jumps to one; above its search, a card with your picture and name opens Edit Profile (its own
  page, `/settings/profile`); `/settings#<section id>` opens scrolled there (e.g. `RecoveryPrompt`'s
  `#account-security`). Add a new setting as a section there.
- Dates and times all go through `utils/dateFormat.js` (`formatDate`, `formatTime`,
  `formatDateTime`; components call `useDateFormat()` so they redraw): Settings → Date & time
  picks the date format (automatic from the browser, DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD) and
  12/24-hour time, per device (`localStorage dateFormat`). Don't call `toLocaleString` directly.
  "Automatic" (and anything else that needs the user's language) uses `utils/locale.js`
  `userLocale()`: the browser's language, else British English (`en-GB`). The app's own text
  is British English (`<html lang="en-GB">`).
- Spellcheck (red underlines while typing, suggestions and "Add to dictionary" on right click)
  is the browser's own, with its dictionaries: nothing is bundled. `utils/spellcheck.js` puts
  the per-device choice (Settings → Spellcheck, `localStorage spellcheck`, on unless `'off'`) on
  `<html spellcheck>`, which every text box inherits; the message editor carries
  `lang={userLocale()}` (Firefox picks its dictionary by it; Chrome uses its own language
  settings). The desktop app has no right-click menu of its own, so `electron/spellcheck.js`
  adds one (suggestions, Add to dictionary, cut/copy/paste) and sets the checker to the
  system's languages that have a dictionary, else `en-GB` (Electron downloads dictionaries on
  first use; not on macOS, which uses the system's).
- Text can't be selected except where it's useful (`voicaw.css`, TEXT SELECTION): inputs and
  editors everywhere, and on desktop the chat's messages, names, times, reply previews and the
  channel topic. So dragging things (channels, guilds) doesn't highlight text. On mobile a long
  press on a message opens its actions instead.
- **Themes** (`utils/theme.js`, Settings → Appearance, `ThemeSettings.jsx`): Dark (default),
  Light or Match system (follows `prefers-color-scheme` live), **per device only**
  (`localStorage theme`; never sent to the server). It's `<html data-theme>` (and Bootstrap's
  `data-bs-theme`); a copy of the logic inline in `index.html` sets it before the CSS loads, so a
  light page never starts dark. Colours are the `--vc-*` tokens on `:root` in `voicaw.css`,
  overridden under `:root[data-theme="light"]` (THEMES there): **use tokens, not literal
  colours**, in new CSS (`--vc-on-accent` for text on coloured fills, `--vc-popup` for menus;
  literal black/white is only for overlays on images and video). Each theme sets CSS
  `color-scheme`, which makes the browser's own controls and scrollbars match. **Not the
  on-screen keyboard:** on iPhones and iPads it follows the system's light/dark mode whatever
  the page says (WebKit gives every field `UIKeyboardAppearanceDefault`; checked in its source
  and on a real iPhone, 2026-10-01), and Android keyboards follow the system or their own
  setting. Only a native app can choose, and only on iOS (`keyboardAppearance`; in a
  Capacitor wrapper, `@capacitor/keyboard` `setStyle`). Code highlighting is Atom One Dark plus
  `hljs-light.css` (Atom One Light under `[data-theme="light"]`).
- **Sidebar width and headers** (computer): the column beside the rail (DM list, a guild's
  channel list, Settings' sections) is one width, `--vc-sidebar-width` (default 260px), which
  `Layout` sets on `.main-wrapper` from `utils/sidebarWidth.js` (per device, `localStorage
  sidebarWidth`, 200–420px, synced between tabs). `SidebarResizer` is its right edge: drag
  (writes the variable directly while moving, saves on release), arrow keys, double click for
  the default. Every page's top header (guild name, channel, Direct Messages, a DM's or group's
  chat, Settings and its first category) is `--vc-header-height` (50px, borders included), so
  their lines meet; use both tokens for anything new there. DM banners (notifications, recovery
  code) go under the chat header. Phones: lists stay full width and Settings one screen.
- Scrollbars are styled once, in `voicaw.css` (SCROLLBARS): every scroll area inherits the pane
  look (like the message list); small boxes and pop-ups are listed there for the thin one. Don't
  style a new scroll area's scrollbar locally.
- Phone panes (`hooks/useSwipePanes.js`, in `Layout`, DM and guild pages): the list (rail +
  conversations or channels) underneath, the chat on top, Discord style. A sideways swipe
  (decided after 8px, so scrolling never moves them; not in pickers, sheets, member panels or
  anything that scrolls sideways itself) drags the chat with the finger, and letting go
  finishes or undoes it by position and speed (a critically damped spring); the list moves a
  little and dims behind it. The chat showing is its own history entry (`history.state.voicawPane`),
  so back slides to the list; list rows navigate with `replace` on phones, so entries don't pile
  up. Open the chat from elsewhere with `showContent()` (`utils/mobilePanes.js`). The panes only
  have a transform while moving (a transform would trap `position: fixed` children).
- Desktop vs. mobile layouts are two separate CSS files (`assets/css/desktop.css` /
  `mobile.css`) toggled via body classes rather than component-level responsive branches
- PWA support via `vite-plugin-pwa` (`injectManifest` strategy, custom `src/service-worker.js`) —
  service worker handles push notifications and posts `navigate` messages back to the app, which
  `SWMessageHandler` in `App.jsx` listens for
- Updates: `registerType: 'prompt'`. A new deploy's service worker precaches the new build and
  waits; `utils/appUpdate.js` (wired up in `main.jsx`) notices it and `UpdateBanner` offers
  "Update", which sends `SKIP_WAITING` (handled in `service-worker.js`), so the new worker takes
  over, `cleanupOutdatedCaches` drops the old build, and the page reloads. Browsers only look for
  a new worker on navigation, so it also checks every 30 min and when the app comes back into view
  (at most once a minute). Settings (`AppUpdateSettings`) shows the build time
  (`VITE_BUILD_TIME`) and has "Check for updates". Other tabs, and pages whose lazily loaded chunks
  are gone from the server (`vite:preloadError`), are offered a reload. The desktop app has no
  service worker: `watchDesktopUpdates` offers its own updates the same way (see Desktop app).

## Profiles

Everyone has an optional display name (32 characters), custom status (a line of text, 128;
not an online status: those stay automatic) and bio (190), in `users` (`display_name`,
`custom_status`, `bio`; `server/profiles.js`), visible to everyone logged in. The username
stays the unique handle (logins, @username on the card).
- `PUT /api/profile { displayName, customStatus, bio }` (null or "" clears one) saves and
  sends `user_profile { user }` to every logged-in socket. `GET /profile`, `/dms-list`, guild
  members and group details include the fields; message rows carry `sender_display_name`, used
  for push titles (DMs, guild pushes, group pushes, calls use `displayNameOf`).
- Client: `utils/profiles.js` is the store (by user id), fed by `Layout` (your profile and the
  users list, once per login), guild members, the DM list and `user_profile` events.
  **Draw names with `displayName(id, fallbackUsername)` / `nameOf(user)`** (components call
  `useProfiles()` to redraw), never `user.username` directly: messages, reply bars, DM list and
  header, member list, voice, calls, groups, mention names and suggestions (which match display
  names and usernames) all do. Admin lists (bans, invites, channel overrides) keep usernames.
- **Profile pictures** (`server/avatars.js`, `avatarImage.js`, `routes/avatars.js`): `POST
  /profile/avatar { type, size }` signs an upload of the original (image, up to 8 MB) to
  `profile-pics/src/<user id>/<upload id>`; `POST /profile/avatar/:uploadId/ready` has the server
  crop it square and shrink it (`sharp`: 256×256 at most, never enlarged, WebP, animation
  kept, pixel/frame limits), store it as `profile-pics/<user id>/<avatar id>.webp` (a new name
  each time, so it's cacheable forever), delete the original and the previous picture, set
  `users.avatar` and send `user_profile`. `DELETE /profile/avatar` goes back to the default. Push
  images use `users.avatar` (no requests to the store). Client: the profile store has `avatar`,
  `avatarUrl(id)` gives the URL (null: default), and **`Avatar` (`components/Avatar.jsx`) draws
  every profile picture** (`voice/UserAvatar` adds the speaking ring); nothing builds picture
  URLs itself. Pictures from before (one unprocessed `profile-pics/<user id>` each) are converted
  when the server starts (`migrateLegacyAvatars`: lists the bucket's top level, converts,
  deletes; afterwards there's nothing to list).
- `ProfileCard` (picture with status, names, custom status, bio) is the guild member card's top
  and `ProfilePopover`'s body (clicking a name or avatar in chat). The DM list and member list
  show the custom status under names.
- Settings → Edit Profile is its own page (`/settings/profile`, `EditProfile.jsx`): picture
  (change or remove), display name, custom status, bio, with a live preview; Save uploads the
  picture (if picked) or removes it, and saves the rest.

## Sounds

Discord's sound effects, for what Voicaw has (`client/src/sounds/`). `soundList.js` lists them
(`SOUNDS`): Message, Mute, Unmute, Deafen, Undeafen, User join, User leave, Voice disconnected,
Incoming ring, Outgoing ring. Each is a `tone` drawn with Web Audio oscillators (notes, volume,
wave, `bell` or `flat` shape); **a sound with a `file`** (e.g. `/sounds/message.ogg` in
`client/public/sounds/`) plays that instead, falling back to its tone if it can't load, so real
recordings can replace tones one at a time. `every` makes it a loop (rings), `minGap` stops
repeats (a burst of messages dings once).
- `sounds.js`: one shared `AudioContext`, started on the first click or key press (browsers
  refuse sound before one; until then sounds are skipped); `playSound(name, { preview })`,
  `startLoop` / `stopLoop` (one loop at a time, cut off at once). Prefs per device
  (`localStorage soundPrefs`: `volume` 0–1, `off` list), Settings → Sounds (`SoundSettings.jsx`:
  volume, a switch and a play button per sound). They play through the speakers chosen in
  Settings → Voice & video.
- Where they play: `voiceClient` (join on connecting; LiveKit participant joined/left; disconnect
  on leaving, a call ending or the connection lost; mute/deafen from `setSelfMute`/`setSelfDeaf`,
  not the automatic mute when the microphone fails), `callClient` (the rings). Message: the
  server decides (`sendPushToUser`, so it follows exactly what notifies: not the chat you're
  looking at, guild notification levels, no SUPPRESS_NOTIFICATIONS webhooks) and sends
  `message_sound`; `playMessageSound` plays it in a browser page only while it's visible and
  focused (that page's push notification is then silent; otherwise the system notification
  makes the sound), and always in the desktop app (whose notifications are silent).
- **Not done yet** (Discord has them; the features don't exist yet): push-to-talk on/off,
  stream started/ended and viewer join/leave, activities, stage, user moved.

## Admin settings

Global admins (`users.is_admin`; the first made with `npm run admin -- <username>` in
`server/`, then others from the panel) get an Admin card in Settings (`AdminSettings.jsx`; the
server's 403 hides it from everyone else). App-wide settings are declared in
`server/appSettings.js` (`SETTINGS`: label, description, `env` fallback, `secret`); a value saved
there (`app_settings` table, cached in memory) overrides the `.env` one, and clearing it goes
back. Secrets are write-only: the panel only shows where the value comes from and its last 4
characters. `GET /admin`, `PUT /admin/settings/:key { value | null }`, `POST /admin/admins
{ username }`, `DELETE /admin/admins/:id` (not yourself). Only the Klipy key for now; add new
app-wide keys to `SETTINGS` and read them with `getSetting` rather than from `config.js`.
