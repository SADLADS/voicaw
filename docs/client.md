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
  `#account-security`). Add a new setting as a section there; a section may have an `icon`
  (Font Awesome; shown in the column, its card draws it in its heading).
- **Privacy** (Settings → Privacy, the puzzle piece, `PrivacySettings.jsx`): choices that give
  the server (or another site) a little more for convenience, per device (`utils/privacy.js`,
  `localStorage privacy`, JSON; never sent to the server). **Each defaults to the convenient
  (less private) option**; turning it off is for whoever wants the private one. So far:
  `inviteEmbedsInEncrypted`, invite cards in DMs and group DMs load without Show (see
  docs/guilds.md, Invite embeds). New privacy trade-offs go here.
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
- **Right-click menus** (and touch and hold on a phone) are ours, Discord style:
  `components/ContextMenu.jsx` draws them (items with icons, hints, ticks and submenus;
  floating by the pointer with submenus beside it on a computer, hover/click/arrow keys; a
  bottom sheet on a phone where a submenu replaces it, with Back). Channels, categories, the
  channel list's empty space and guild icons have one (see `docs/guilds.md`), and so do
  conversations in the DM list (`DmMenu.jsx`: Mark As Read, Start/Join Call, Pin / Unpin,
  Mute ▸ / Unmute). **The browser's own menu is off** everywhere else
  (`utils/nativeContextMenu.js`, from `main.jsx`) except in text boxes (spellcheck, paste), on
  selected text, and on links in messages and embeds (copy link, open). Pictures have ours
  (see Image menu in `docs/uploads.md`).
- **Pinned and muted conversations** (`server/conversationSettings.js`, table
  `conversation_settings`; `GET /conversation-settings`, `PUT /conversation-settings/:kind/:target
  { pinned?, mute?: { duration } | false }`, kind `dm` (the other person's id) or `group`; the
  `conversation_settings` event to your other devices; `hooks/useConversationSettings.js` in
  `Layout`, `LayoutContext.conversationSettings`): each person's own, so they follow you
  between devices. Pinned conversations come first in the DM list, in the order pinned (50 at
  most), with a pin. A muted one (15 min to 24 h, or until unmuted) doesn't push or play the
  Message sound (calls still ring), is dimmed with a crossed-out bell and no unread dot, and
  doesn't light the rail's DMs icon or the desktop app's badge. The server already knows who
  talks to whom, so this tells it nothing new.
- Text can't be selected except where it's useful (`voicaw.css`, TEXT SELECTION): inputs and
  editors everywhere, and on desktop the chat's messages, names, times, reply previews and the
  channel topic. So dragging things (channels, guilds) doesn't highlight text. On mobile a long
  press on a message opens its actions instead.
- **Themes** (`utils/theme.js`, Settings → Appearance, `ThemeSettings.jsx`): Dark (default),
  Light, Ol' Familiar or Match system (follows `prefers-color-scheme` live, light or dark),
  **per device only**
  (`localStorage theme`; never sent to the server). It's `<html data-theme>` (and Bootstrap's
  `data-bs-theme`); a copy of the logic inline in `index.html` sets it before the CSS loads, so a
  light page never starts dark. Colours are the `--vc-*` tokens on `:root` in `voicaw.css`
  (COLOURS there), set again in full under `:root[data-theme="light"]` (THEMES): **use tokens,
  not literal colours**, in new CSS (literal black/white is only for scrims and controls over
  images and video; the Appearance previews copy each theme's values on purpose). The scheme
  (2026-10-02) has two brand colours and fixed meanings:
  - **Purple (`--vc-accent`) marks what you can do:** primary buttons, selection, focus rings,
    toggles and checkboxes, links (one link colour, `--vc-accent-text`, everywhere), your own
    reactions and poll votes, the active settings tab.
  - **Bird yellow (`--vc-action`, the logo's `#d8b930`, the same in every theme) marks what
    wants your attention:** the rail's marker (open guild, unread), unread pills and mention
    counts, mentions (`@you` and the highlighted message), pins, the owner crown, the poll
    trophy, idle. Never an error; text on it is dark (`--vc-on-action`).
  - **Status colours only for status:** green for online and done (`--vc-online`, indicators
    only; `--vc-success` is the green button), orange for warnings and "connecting"
    (`--vc-warning`), red for errors and destructive actions (`--vc-danger`). There's no third
    brand colour (the old teal is gone).
  - Neutrals have a slight purple tint (hue about 260°). Hover: a coloured fill goes one shade
    darker (its `-hover` token, never `filter: brightness`), a neutral surface one step towards
    the foreground.
  - Each colour comes as a fill (`--vc-accent`), `-hover` (and `-strong`, pressed), `-text` (as
    text on the background: the fills don't read as text), `-soft` (a tinted background) and
    `--vc-on-*` (text on the fill: white on purple, red and green, dark on yellow and dark's
    orange). Bootstrap's buttons, links and selects are mapped onto the tokens (BOOTSTRAP in
    `voicaw.css`); `.btn-secondary` is a neutral button.
  - Besides the brand colours, a theme sets three roles of its own: `--vc-link` (links),
    `--vc-unread` (the rail's marker, unread pills and dots) and `--vc-mention-badge` /
    `--vc-on-mention-badge` (unread mention counts). Dark and Light give them the purple text
    colour and the bird yellow.
  - **Ol' Familiar** (`data-theme="familiar"`, added 2026-10-02) is Discord's default dark
    theme: the 2025 refresh's "Dark" (`.theme-darker` in Discord's CSS), its values read from
    discord.com's stylesheets on 2026-10-02 (translucent hovers and borders flattened onto
    their surface). So it breaks Voicaw's colour meanings where Discord does: blurple accent,
    blue links, white unread markers, red mention counts, Discord's yellow for mentions. It's
    dark underneath (`BASES` in `utils/theme.js`): Bootstrap's `data-bs-theme="dark"`, dark
    form controls and code highlighting. Nothing is loaded from Discord; only the colour
    values are copied.
  - **Another colour scheme** later: a `:root[data-theme="<name>"]` block setting every colour
    token (copy the light one) and its `color-scheme`, the name in `THEMES` and `BASES`
    (`utils/theme.js`) and in `index.html`'s copy, and a preview in `ThemeSettings.jsx`
    (`e2e/colours.mjs` with `THEMES=<name>` shoots it). Since
    nothing outside the token blocks has a theme colour of its own, a user-made scheme could
    be applied by setting the tokens inline on `<html>`. Keep `manifest.json`'s and
    `index.html`'s `theme-color`, `electron/main.js`'s `backgroundColor` and `website/` in step
    with the default scheme. Each theme sets CSS
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
- Safe areas (notch, rounded corners, home indicator): the viewport meta has
  `viewport-fit=cover`, without which iOS reports every `env(safe-area-inset-*)` as 0 (yet the
  Home Screen app still draws under the home indicator). `#root` pads by the left and right
  insets (a landscape notch); whatever sits at the bottom edge pads by the bottom inset itself
  (the user panel with `max(8px, inset)`, composers, sheets). The insets are 0 on computers and
  phones without them, so nothing moves there. `e2e/safearea.mjs` checks this with insets made
  up through CDP; Chrome's override ignores `viewport-fit`, so the meta itself only shows on a
  real iPhone.
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
- Precaching skips any file over 2 MiB (Workbox's `maximumFileSizeToCacheInBytes`), and the build
  then fails: keep the main bundle (`assets/index-*.js`, 1.7 MB in October 2026) under it by
  loading big, rarely needed code with `import()`, as OPAQUE is (`authService.js` `loadOpaque`,
  ~400 kB, only for logging in, signing up and checking a password), the document editor and
  DeepFilterNet. When a build fails this way, `/opt/voicaw-client` has already been replaced, and
  its service worker precaches everything but that file.

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
