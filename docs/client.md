# Client structure, profiles, sounds, admin settings

## Client structure

- Component files export only components (Vite hot reload needs that; lint enforces it).
  Contexts live in `contexts.js` (`ConfigContext`, `InteractionContext`, `LayoutContext`) and
  `hooks/useAuth.js`; logic lives in `hooks/` and `services/`.
- **Translations** (`i18n/`, i18next): every string the app shows comes from `t('area.key')`,
  so components don't change per language. British English (`en-GB/`) and Russian (`ru/`,
  a quick machine-made first pass from 2026-10-03, translated in batches from then on: new
  text is written in English only and shows in English until the next batch) and Japanese
  (`ja/`, a full machine-made translation from 2026-10-06, likewise translated in batches;
  Japanese has a single plural form, so its files only have `_other` keys). The text is in
  `i18n/<language>/<area>.json`, one file per area of the app (`settings`, `chat`, `guilds`,
  `guildAdmin`, `voice`...), each holding one top-level key named after the file; `common.json`
  has the everyday words (Cancel, Save, Close...). Files there are picked up automatically;
  a new language also goes in `LANGUAGES` (`i18n/index.js`).
  - **Choosing:** Settings → Language (`LanguageSettings.jsx`), on this device
    (`localStorage`); Automatic, the default, takes the browser's languages in order and
    falls back to British English. Changing it reloads the app. Anything missing from a
    language shows in British English (i18next's fallback, key by key; a plural form missing
    in Russian falls back to the English plural). The service worker can't read the choice,
    so notification text follows the browser's language.
  - `import { t } from '../i18n'` works anywhere (components, hooks, services, memoised
    parts): the strings are bundled and looked up synchronously. Changing language will
    reload the app, so there's no `useTranslation` hook to thread through.
  - One key per whole sentence, with `{{name}}` for what goes in it; never glue translated
    pieces together (word order differs). Counts use i18next plurals: `foo_one` / `foo_other`
    and `t('area.foo', { count })` (Russian will add `_few` / `_many`). A sentence with
    markup in it (bold, a link) uses react-i18next's `<Trans i18nKey components={{ b: <strong /> }}>`.
  - Not translated: names, message content, dates (`utils/dateFormat.js` follows the locale
    already), console messages, stored formats (poll and call-log markup), and errors the
    server sends (`err.response.data.error`, still English: they'd become codes when a second
    language arrives), and the group log's verification errors ("Entry 3 is out of place":
    `groupCrypto.js` is shared with the server's tests, which run outside Vite, so it can't
    import `i18n`; `encryptionService.js`, `contactKeys.js` and `permissions.js` likewise).
    Web workers and audio worklets don't import `i18n`. The service worker does, through
    notification previews (polls, mentions, spoilers): about 115 KB of its 157 KB.
  - Checks: ESLint's `i18next/no-literal-string` fails on text written straight into JSX or
    its `title`, `placeholder`, `aria-label`, `alt` and `label` attributes (plain `.js` files
    aren't checked: put their text through `t` by hand). `i18n/keys.test.js` fails when the
    code uses a key that isn't in the files (keys built at run time, like
    `` t(`guildAdmin.permissions.${name}.label`) ``, can't be checked there).
  - Still English in every language: server errors (they'd need to become codes), push
    notification text written by the server, and the desktop app's menus and tray.
    Translating a batch: compare a language's files with `en-GB/` for missing keys (nothing
    checks this automatically, since partial is allowed).
- `AuthProvider.jsx` — fetches `/api/profile` on mount to restore the session (id, username, JWT)
  into `useAuth`; the keys come from IndexedDB (`keyStore`). `services/authService.js` does the
  OPAQUE login/register (`Login.jsx` is just the form).
- `App.jsx` — top-level routing (`BrowserRouter`; `HashRouter` only for a page opened from a
  file); provides `ConfigContext` (fetched from
  `/api/config`, asked again until it loads, from 2 s doubling to 30 s and on `online`: without
  its `s3Endpoint` there are no profile pictures, guild icons or custom emoji) and `InteractionContext` (`isMobile`: the phone or computer layout, detected
  from the user agent; not a setting, since the wrong one is unusable, removed 2026-10-01)
- `Layout.jsx` — the logged-in shell: sidebars, users list and unread counts (`LayoutContext`),
  and the favicon dot (`useFaviconDot`, see Favicon dot).
  `DmSidebar` draws the unread dots from those counts. The rail's DM button (`Sidebar`
  `unreadFrom`) shows the picture of whoever sent the newest unread DM or group message
  (`utils/latestUnread.js`: `/dm-get-unread`'s `last_timestamp`, a group's
  `last_unread_sender_id` / `last_unread_timestamp`; muted ones and the open group left out),
  and its usual icon when nothing's unread. Clicking the DM button while on a DM page, or the
  open guild's icon, does nothing (as in Discord): following the link went to bare `/dm` or
  `/guild/:id`, which showed an empty page for a moment before redirecting (`e2e/samepage.mjs`).
  `SidebarWrapper` puts the sidebars in a
  row with `UserPanel` across the bottom: your picture, name, under it your custom status
  (`CustomStatus`, emoji and text) while connected, otherwise this device's connection state
  (`ws-client` `getConnectionState`/`onConnectionState`: online / connecting / offline; the dot
  on the picture always shows it), and the settings button. Clicking the picture and name opens `UserMenu` above it: your picture, name
  and custom status (its emoji button and text change it there), Edit Profile, Copy User ID and Log out.
  Neither the panel's picture and name nor the menu has a right-click menu (they call
  `preventDefault`, so PageMenus' Copy User ID doesn't open there either). It's shown under the DM list, a guild's channel list, and Settings' column on
  a computer (Layout adds an empty column, `settingsNavSlot` in `LayoutContext`, and `Settings`
  draws its column into it with a portal; on a phone the column stays in the page, without
  the panel).
  Uploading a profile picture calls `announceProfilePictureChange()` so it refreshes.
- Message actions: on desktop, a hover menu (react, pin, edit, reply, delete) and a
  right-click menu (`MessageMenu.jsx`, on `ContextMenu`): a row of five quick reactions, then
  Add Reaction (the full picker, by the pointer), Reply, Edit Message (your own), Pin / Unpin
  Message (`canPin`), Copy Text and Delete Message (your own, or `canModerate`). Right-clicking a
  link, selected text, the inline editor or a picture still gets the browser's menu or the
  image menu instead. There's no hover menu on mobile: a long press on a message
  (`hooks/useLongPress.js`, 450ms, cancelled by scrolling) opens `MessageActionSheet` with the
  same actions: quick reactions and `+` for the full picker, Reply, Edit, Pin / Unpin, Copy text
  and Delete (asks first). Both offer only Copy for a message still sending or failed. Quick
  reactions (`emoji/quickReactions.js`) are your most used emoji first, then 👍❤️😂😮😢🙏. Copying
  turns attachments into their names, never their key-carrying links. On desktop, Delete in
  either menu asks too (`ChatPane`: a "Delete message" dialog showing the message; Enter
  confirms), unless Shift is held while clicking. The hover menu follows `mouseenter`/`mouseleave`,
  which only fire when the mouse moves, so after the rows change or resize `MessageList` works out
  the hovered row again from where the pointer is (`rehover`): Shift+deleting from the hover menu
  leaves it on the next message, now under the pointer, ready to delete that one too. The sheet ignores the click Chrome fires when
  the holding finger lifts (it lands on the sheet); only clicks from a touch that started on
  it count. Messages aren't text-selectable on mobile, so the long press isn't taken by text
  selection. Rows highlight on hover only with a mouse (`@media (hover: hover)`): a touch
  screen keeps `:hover` on the last thing tapped, so there a tap flashes the row instead
  (`.tap-highlight`, the jump-to-message fade in the hover colour, `utils/flashRow.js`); the
  row a sheet or picker is open for stays highlighted (`.focused`).
- Swipe to reply (mobile, `hooks/useSwipeToReply.js`, like Discord): swiping a message to the
  left drags it with the finger and brings in a reply arrow from the right edge; past 64px the
  arrow fills in (a short vibration), the message resists, and letting go there sets the reply
  (as Reply does: reply bar, message box focused). It springs back either way. One listener
  on the message list, decided after 8px like the phone panes: only a clearly sideways,
  leftward swipe counts, so scrolling is untouched and a rightward swipe still goes back to
  the list. Not on messages still sending or failed, notices, the inline editor, sliders,
  videos or anything that scrolls sideways itself (code blocks), nor where you can't send
  (`ChatPane`'s `canSend`). The row's state is a `data-swipe` attribute, not classes (React
  owns its className). There's no swipe to edit.
- Editing on a phone (like Discord): Edit in the sheet doesn't open the inline editor (that's
  a computer's); `ChatPane` hands the message to `Composer` as `editing`, which puts its text in
  the message box, focused (the keyboard comes up), under an "Editing message" bar in place of
  the reply bar (starting an edit drops a reply, and Reply drops an edit). Send reads Save and
  edits it; the + menu, pasted files and "/" commands are off meanwhile. The bar's × (or
  Escape) stops editing and empties the box; it doesn't take the focus, so the keyboard stays
  up. Saving empties the box too; saving it emptied is cancelling, as inline. What was typed
  before the edit isn't kept, and the edited text is never saved as a draft or sent as typing.
  The message being edited stays highlighted (`.focused`).
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
  page, `/settings/profile`; on a phone, where the column is on top, it scrolls down to the form); `/settings#<section id>` opens scrolled there (e.g. `RecoveryPrompt`'s
  `#account-security`). Add a new setting as a section there; a section may have an `icon`
  (Font Awesome; shown in the column, its card draws it in its heading).
- **Privacy** (Settings → Privacy, the puzzle piece, `PrivacySettings.jsx`): choices that give
  the server (or another site) a little more for convenience, per device (`utils/privacy.js`,
  `localStorage privacy`, JSON; never sent to the server). **Each defaults to the convenient
  (less private) option**; turning it off is for whoever wants the private one. So far:
  `inviteEmbedsInEncrypted`, invite cards in DMs and group DMs load without Show (see
  docs/guilds.md, Invite embeds); `sendTyping`; `youtubeEmbeds`, YouTube players load without
  Play (see docs/messages.md, YouTube links); `gifs`, GIFs load without Show and the GIF picker
  doesn't warn first (see docs/messages.md, GIFs); `linkPreviews`, other sites' pictures and
  videos in link previews and embeds load without Show / Play (see docs/messages.md, Link
  previews); `showLinkPreviews`, links to other sites get previews at all (same section).
  "Show message text in notifications" is here too, though it's kept in
  `services/settingsStore.js` (IndexedDB) for the service worker (see docs/realtime.md, Push
  notifications). New privacy trade-offs go here.
- Dates and times all go through `utils/dateFormat.js` (`formatDate`, `formatTime`,
  `formatDateTime`; components call `useDateFormat()` so they redraw): Settings → Date & time
  picks the date format (automatic from the browser, DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD) and
  12/24-hour time, per device (`localStorage dateFormat`). Don't call `toLocaleString` directly.
  "Automatic" (and anything else that needs the user's language) uses `utils/locale.js`
  `userLocale()`: the browser's language, else British English (`en-GB`). The app's own text
  is British English (`<html lang="en-GB">`).
- **Spellcheck** is ours, the same in every browser and the desktop app (`spellcheck/`):
  [nspell](https://github.com/wooorm/nspell) (Hunspell in JavaScript) in a Web Worker
  (`spellWorker.js`; a dictionary takes a moment to read), with British and American English
  (`dictionaries.js`, wooorm's `dictionary-en-gb` / `dictionary-en`, about 550 KB each,
  self-hosted with the build and fetched only when an editor first needs one; never precached).
  `checker.js` caches each word's answer and batches the rest to the worker; `words.js` says
  which words count (not links, emails, @mentions, #channels, :emoji:, words with digits or
  underscores, ACRONYMS, mixedCase or single letters); `rankSuggestions.js` puts nspell's
  suggestions closest first. The editors (message box, edits, documents) draw the underlines
  themselves (`spellcheckPlugin.js`, a ProseMirror plugin: decorations, skipping code, links,
  chips and the message box's markdown code, and the word being typed until the cursor leaves
  it) and set `spellcheck="false"`, so the browser's checker doesn't add its own. Plain text
  boxes (titles, bio, task fields) can't be drawn in, so they keep the browser's underlines;
  right-clicking a word there still gets our suggestions. Per device (`utils/spellcheck.js`,
  Settings → Spellcheck, not on a phone, whose keyboard checks spelling): on or off
  (`localStorage spellcheck`, on unless `'off'`, set on `<html spellcheck>`) and the language
  (`localStorage spellcheckLanguage`: Automatic picks from the browser's languages, any English
  but American being British). With no dictionary of ours for the language it's the browser's
  (or the desktop app's) own checker, as before; the desktop app's suggestions then come from
  Electron (`window.voicawDesktop.spelling`). **Your dictionary** (Add to Dictionary; listed with
  remove buttons in Settings) follows your account, end-to-end encrypted
  (`spellcheck/personalDictionary.js`, started by `hooks/useDictionarySync.js` in `Layout`; see
  Spellcheck dictionary in `docs/auth-and-encryption.md`); words match whatever their case, and
  the desktop app's own dictionary is kept to the same words.
- **Right-click menus** (and touch and hold on a phone) are ours, Discord style:
  `components/ContextMenu.jsx` draws them (items with icons, hints, ticks, disabled items and
  submenus, and an optional `header` above them;
  floating by the pointer with submenus beside it on a computer, hover/click/arrow keys; a
  bottom sheet on a phone where a submenu replaces it, with Back). Picking an item closes the
  menu as soon as it's done; Copy … items (text, links, pictures, ids) just close it, with no
  "Copied" message (only a failure shows, in the menu). Channels, categories, the
  channel list's empty space and guild icons have one (see `docs/guilds.md`), and so do
  conversations in the DM list (`DmMenu.jsx`: Mark As Read, Start/Join Call, Pin / Unpin,
  Mute ▸ / Unmute, Block / Report and Copy User ID; not for a group). Messages have one too (`MessageMenu.jsx`, see Message actions above).
  Everywhere else `components/PageMenus.jsx` (mounted in `App`, listening on the page; what a
  right-click is on: `utils/pageMenuTarget.js`) has one: a picture (see Image menu in
  `docs/uploads.md`); a text box (`utils/editActions.js`: spelling fixes for the word clicked,
  Add to Dictionary, Cut / Copy (with a selection, not in passwords), Paste, Select All, and a
  Spellcheck tick); a link to another site (Copy Link, Open Link); selected text (Copy); a
  person (anything marked `data-user-id`, which `Avatar` always is, and so are a message's
  author, user mentions, member list rows, voice channel members and profile cards): the
  person's menu (`utils/personMenu.js`, one menu wherever they're shown), Message (Layout
  registers how: a bot's conversation is its own kind), the friend item (Add Friend / Accept
  Friend Request / Cancel Friend Request / Remove Friend, which asks; not for bots, deleted or
  blocked accounts), in a guild (GuildView registers the open guild and its members) Make
  Owner (the owner, not to a bot) / Kick / Ban as permissions and rank allow, Block / Unblock
  and Report, then Copy User ID; only Copy User ID on yourself. Those that ask first open
  through `SafetyDialogs.jsx`. On a phone, holding a guild member row, or a message's picture,
  name or a mention (instead of the message's actions; `useLongPress` passes what was held),
  opens the same menu as a sheet (`openPersonMenu`); a webhook's name or picture on its
  message (Block Webhook, Copy Webhook ID). A message's own menu gives way to those (right-clicking its author or a mention gets
  the person's). The menu takes the focus, so each action puts it back
  in the box first. Paste in a browser asks to read the clipboard (the first time, the browser
  asks the person) and hands it to the editor as a paste (pictures attach); the desktop app
  pastes for real (`desktop.paste()`, Electron's own). **The browser's own menu is off**
  (`utils/nativeContextMenu.js`, from `main.jsx`, listening on the window so it runs last),
  except with **Shift** held (the browser's, e.g. its spelling in a language we have no
  dictionary for) and in text boxes on a phone, whose own selection handles and paste bar stay.
- **Pinned and muted conversations** (`server/conversationSettings.js`, table
  `conversation_settings`; `GET /conversation-settings`, `PUT /conversation-settings/:kind/:target
  { pinned?, mute?: { duration } | false }`, kind `dm` (the other person's id) or `group`; the
  `conversation_settings` event to your other devices; `hooks/useConversationSettings.js` in
  `Layout`, `LayoutContext.conversationSettings`): each person's own, so they follow you
  between devices. Pinned conversations come first in the DM list, in the order pinned (50 at
  most), with a pin. A muted one (15 min to 24 h, or until unmuted) doesn't push or play the
  Message sound (calls still ring), is dimmed with a crossed-out bell and no unread dot, and
  doesn't light the rail's DMs icon, the favicon dot or the desktop app's badge. The server
  already knows who talks to whom, so this tells it nothing new.
- **Favicon dot** (`hooks/useFaviconDot.js` in `Layout`, `utils/faviconDot.js`): the browser
  tab's icon gets a red dot while something's unread the way Discord counts it (unread DMs and
  group messages, guild mentions; `unreadSummary`, the same as the desktop app's tray and
  taskbar). Guild messages that don't mention you don't count. The dotted icon is drawn once
  on a canvas from `logo192.png` and swapped in as the `<link rel="icon">`'s href; the original
  comes back when read or logged out. Not in the desktop app (no tab).
- **Account preferences** (`server/preferences.js`, JSON in `users.preferences`, only those
  changed from the default; `GET /preferences`, `PUT /preferences { key: value }`; the
  `preferences` event to your other devices; `utils/preferences.js`, kept up to date by
  `hooks/usePreferencesSync.js` in `Layout`): settings that follow your account to every
  device, unlike the per-device ones in localStorage (Privacy, sounds, theme...). So far
  `blurNsfw` (Settings → Content, "Blur media in NSFW channels", on by default; see NSFW
  channels in `docs/guilds.md`), `adultConfirmed` ("I am 18 or over", off by default; the age
  gate, same place) and `botDms` ("Let bots message me", on by default; the server enforces it,
  see Bot DMs in `docs/bots.md`) and `reactionNotifications` (Settings → Notifications,
  "Reactions to your messages": `all` by default, `dms`, `off`; see Reaction notifications in
  `docs/realtime.md`). `usePreferencesLoaded()` says when the account's own have arrived (until
  then they're the defaults). A new one is a key in both files' `DEFAULTS` (and the
  server's `isValid`).
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
  - **Ol' Familiar** (`data-theme="familiar"`, added 2026-10-02) is Discord's Ash theme, its
    mid-grey dark one and the closest to Discord's classic look (Discord's code maps Ash to
    `.theme-dark`, Dark to `.theme-darker`, Onyx to `.theme-midnight`); values read from
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
  style a new scroll area's scrollbar locally. All of it is inside `@media (pointer: fine)`:
  touch screens keep the system's overlay bar, which shows while swiping and can't be tapped or
  dragged (a styled bar becomes a classic, grabbable one on Android browsers that don't know
  `scrollbar-color`). Hiding a bar (`scrollbar-width: none`) still applies everywhere.
- Phone panes (`hooks/useSwipePanes.js`, in `Layout`, DM and guild pages): the list (rail +
  conversations or channels) underneath, the chat on top, Discord style. A sideways swipe
  (decided after 8px, so scrolling never moves them; not in pickers, sheets, member panels or
  anything that scrolls sideways itself) drags the chat with the finger, and letting go
  finishes or undoes it by position and speed (a critically damped spring); the list moves a
  little and dims behind it. The chat showing is its own history entry (`history.state.voicawPane`),
  so back slides to the list; list rows navigate with `replace` on phones, so entries don't pile
  up. Back works as in Discord's app, never like a browser's: from a chat it shows the list,
  from the list it leaves the app. So on phones the router's history (`utils/phoneHistory.js`,
  `App.jsx`) turns every navigation from one chat page (`/dm…`, `/guild…`) to another into a
  replace, wherever it comes from (the rail, a link or mention in a message, Friends' Message,
  the voice bar); a thread or a voice channel's chat (same page, other search params), Settings
  and the developer portal keep an entry of their own, so Back closes them. Going back to the
  list's entry shows the list of the chat just left (a channel link from a DM: that guild's
  channels), since the useSwipePanes popstate handler replaces it with the chat's page (noted whenever the chat is shown, not only when the URL changes: a guild opened on the rail shows its channels, and swiping to its chat and back must keep that guild, not bring back the DM shown before; `e2e/guildswipe.mjs`). Every chat's header (DM, group DM, bot DM, notes, guild channel) starts with a back arrow
  on phones (`PaneBackButton`, like Discord's): it shows the chat can be swiped away, and
  pressing it slides to the list the same way (`showList()`); threads and voice channels' chat
  have their own, back to their channel. Open the chat from elsewhere with `showContent()`
  (`utils/mobilePanes.js`), after navigating: a tapped notification does (the web's
  `SWMessageHandler`, the Android app's `navigate`), or it would open behind the list. Called
  from a page without the panes (Settings), it's kept for a second and taken when the
  navigation turns them on. The panes only
  have a transform while moving (a transform would trap `position: fixed` children).
  Kept smooth (`e2e/panesperf.mjs` measures it): which pane shows is classes on the wrapper set
  by the hook when a slide comes to rest, not React state (letting go used to re-render the
  whole Layout just as the slide started); the pane off screen stays painted, covered by the
  chat or moved off to the right, and is `aria-hidden` rather than `visibility: hidden` or
  `inert`, which restyle the whole chat each time they change. The lists'
  rows (channels, threads, categories, DMs, members) colour on hover only with a mouse
  (`@media (hover: hover)`): a phone's Chrome sets `:hover` on the row a finger rests on before
  scrolling, and keeps it. Their links also pin their own colour under `:hover`, or the link
  colour every `a:hover` gets (`voicaw.css`) shows through there (`e2e/touchhover.mjs`).
- Desktop vs. mobile layouts are two separate CSS files (`assets/css/desktop.css` /
  `mobile.css`) toggled via body classes rather than component-level responsive branches
- On-screen keyboard (phones, `utils/keyboardViewport.js`, started in `App`): the app always
  ends where the keyboard starts, so the message box (and anything at the bottom) sits on top
  of it and can't be scrolled behind it. Android Chrome does it itself: the viewport meta's
  `interactive-widget=resizes-content` makes it shrink the page for the keyboard (its default
  lays the keyboard over the page and slides the page up to the focused box, which a box
  focused from code, like swipe to reply's, sometimes missed, and a drag could slide back).
  iOS ignores that, so while the keyboard is open `--vc-app-height` is set to the visible
  height (`visualViewport`) and any slide of the page is scrolled back (only then: no page
  scrolls the document). Everything screen-high uses `var(--vc-app-height)` (100svh
  otherwise), never 100vh/svh. The keyboard's height is the visible height's shortfall from
  the keyboard-free height (the tallest seen at that width, capped at `screen.height`), not
  from `innerHeight`, which shrinks with it on Android; `utils/keyboardHeight.js` (the docked
  emoji panel) and `useVisualViewport` use the same. Emoji search's
  `navigator.virtualKeyboard.overlaysContent` overrides the meta while it's on.
  The Send button never takes focus (its `mousedown` is cancelled), so after sending the
  keyboard stays up for the next message, and a tap on Send with the keyboard down doesn't
  bring it up. `e2e/keyboard.mjs` checks both with a made-up keyboard (headless Chrome has none).
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
  (at most once a minute), and keeps checking once one is waiting, so a newer deploy replaces it.
  "Update" looks once more first (up to 5 s, "Looking for a newer version…"), so it switches to
  the latest build, not the first one noticed. Settings (`AppUpdateSettings`) shows the build time
  (`VITE_BUILD_TIME`) and has "Check for updates". Other tabs, and pages whose lazily loaded chunks
  are gone from the server (`vite:preloadError`), are offered a reload. The desktop app has no
  service worker: `watchDesktopUpdates` offers its own updates the same way (see Desktop app).
- **Build size.** Devices precache the whole build (except DeepFilterNet's WebAssembly) and
  download it again on every update, so what matters is the total, which `npm run build` prints
  (4.2 MB in October 2026, warning over 6 MB: `PRECACHE_BUDGET` in `scripts/publish-web.mjs`).
  Workbox skips any single file over `maximumFileSizeToCacheInBytes` (raised from its 2 MiB
  default to 4 MiB in `vite.config.js`), and the build then fails. So that no file grows that
  big, the libraries loaded at startup have their own files (`VENDOR_CHUNKS` in
  `vite.config.js`: React, markdown, highlight.js, Font Awesome; the app's own code is about
  0.8 MB). Only list libraries all loaded at startup: one also used by lazily loaded code (e.g.
  ProseMirror, shared with the document editor) would drag that code into startup. Big, rarely
  needed code loads with `import()`: OPAQUE (`authService.js` `loadOpaque`, ~400 kB, only for
  logging in, signing up and checking a password), the document editor, LiveKit and DeepFilterNet.
- **Publishing.** `npm run build` builds into `build-web/` (not in the repo), then
  `scripts/publish-web.mjs` checks it (everything `index.html` loads is precached, every
  precached file exists) and copies it into `/opt/voicaw-client` (`VOICAW_WEB_ROOT` to publish
  elsewhere) with `rsync --delay-updates --delete-after`: the new files go in together at the
  end, and only then do the old build's go. A failed build or check changes nothing there.

## Profiles

Everyone has an optional display name (32 characters), custom status (a line of text, 128;
not an online status: those stay automatic) with an optional emoji before it, and bio (190), in
`users` (`display_name`, `custom_status`, `custom_status_emoji`, `bio`; `server/profiles.js`),
visible to everyone logged in. The username
stays the unique handle (logins, @username on the card).
- `PUT /api/profile { displayName, customStatus, customStatusEmoji, bio }` (null or "" clears
  one) saves and
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
  `profile-pics/src/<user id>/<upload id>`; `POST /profile/avatar/:uploadId/ready { crop }` has
  the server cut out the square chosen in the cropper (or the middle without one) and shrink it
  (`sharp`: 256×256 at most, never enlarged, WebP, animation kept, pixel/frame limits), store it as `profile-pics/<user id>/<avatar id>.webp` (a new name
  each time, so it's cacheable forever), delete the original and the previous picture, set
  `users.avatar` and send `user_profile`. `DELETE /profile/avatar` goes back to the default. Push
  images use `users.avatar` (no requests to the store). Client: the profile store has `avatar`,
  `avatarUrl(id)` gives the URL (null: default), and **`Avatar` (`components/Avatar.jsx`) draws
  every profile picture** (`voice/UserAvatar` adds the speaking ring); nothing builds picture
  URLs itself. Pictures from before (one unprocessed `profile-pics/<user id>` each) are converted
  when the server starts (`migrateLegacyAvatars`: lists the bucket's top level, converts,
  deletes; afterwards there's nothing to list).
- **Picture cropper** (`components/ImageCropper.jsx`, maths in `utils/imageCrop.js`): a picked
  profile picture (Edit Profile), guild icon (Guild Settings) or bot picture (Developer Portal)
  opens in a dialog first: the picture under a round hole, dragged into place and zoomed (slider,
  wheel, pinch, arrows and +/- on the frame; up to 5×, never leaving a gap). Apply gives the crop
  as fractions `{ x, y, width, height }` of the picture as shown (after EXIF rotation), which the
  server cuts out (`avatarImage.js` `parseCrop`), so animated pictures stay animated. Edit Profile
  previews it (`croppedPreview`, a still canvas copy) until Save; bot pictures, sent as data URIs,
  are cut in the browser before shrinking (`croppedPictureData`; GIFs go whole with `avatarCrop`).
  Escape closes only the cropper (caught before the dialog under it). Webhook pictures don't use
  it yet.
- `ProfileCard` (picture with status, names, custom status, bio) is the guild member card's top
  and `ProfilePopover`'s body (clicking a name or avatar in chat), which has no buttons:
  what can be done to someone is in their right-click menu (see Right-click menus). The DM list, the Friends
  page and your user panel show the custom status under names; a guild's member list
  deliberately doesn't (its rows already have role colours, levels, tags and the crown), only
  the member card does.
- **Custom status emoji**: a Unicode emoji or a guild's custom one (`<:name:id>`, which shows
  everywhere, as in messages: custom emoji aren't encrypted), checked like a reaction's (64
  characters, no spaces); the text and the emoji are each optional, so a status can be just an
  emoji. `CustomStatus` draws both wherever a status shows (`ReactionEmoji` for the emoji).
  `StatusEmojiButton` chooses it: a smiley (or the emoji) opening the floating `EmojiPicker`,
  and ✕ to remove it; the picker is drawn inside it, not portalled, so `UserMenu` counts
  clicks in it as inside. In `UserMenu` the emoji button is always beside the status text, so
  one click opens the picker and the pick saves at once; while the text is being edited, a pick
  goes with it instead (moving to the emoji button or picker doesn't end the edit; Enter or
  clicking away saves both) and the emoji's own ✕ shows; ✕ on the status clears both. In Edit
  Profile it's beside the text box, saved with the rest.
- Settings → Edit Profile is its own page (`/settings/profile`, `EditProfile.jsx`): picture
  (change or remove), display name, custom status and its emoji, bio, with a live preview; Save uploads the
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
  `message_sound`, whether you're in front or not. `playMessageSound` plays it, as Discord does,
  when the page is visible and focused, and on a computer also from a background tab or behind
  another window once the page's audio has started (a click since it loaded; Chrome's own
  notifications are often silent). Phones and the Android app ding only in front, leaving the
  rest to the phone's notification. The desktop app always dings, since its notifications are
  silent. Several tabs in one browser ding once (Web Locks, `voicaw-message-sound`).
  `handlesMessageSound` answers the service worker, which keeps the push notification silent when
  a page dings, so it doesn't sound twice. Until a page has had a click (or with no page open),
  the system notification makes the sound. Turning Message off in Settings → Sounds therefore
  also quiets message notifications while the app is open on a computer.
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
{ username }`, `DELETE /admin/admins/:id` (not yourself). Settings so far: the Klipy key,
who can sign up (`signupMode`), link previews (`linkPreviews`) and the screen share limits
(`streamMaxResolution`, `streamMaxFramerate`; see Stream quality in `docs/voice-and-calls.md`) and
the File size limit (`uploadLimit`, 500 MB by default; see Big files in `docs/uploads.md`). A setting with `choices` (and its `fallback`) takes only one of
them: the panel shows a menu (`ChoiceRow`, labels `settings.admin.choices.<key>.<value>`) and the
server refuses anything else. Add new app-wide keys to `SETTINGS` and read them with
`getSetting` rather than from `config.js`. The panel also lists sign-up requests and app invites
(see Sign-ups in `docs/auth-and-encryption.md`).

**Storage** (`StorageAdmin.jsx`, `GET /admin/storage[?fresh=1]`, built 2026-10-08): how full the
object store is: free of total (red under 10%), a bar and a list of Voicaw's four buckets (size
and file count), other buckets on the same store, and everything else on the drive (total − free
− buckets). `server/storageStats.js` reads MinIO's Prometheus metrics
(`/minio/v2/metrics/cluster`, and `/minio/v2/metrics/bucket` where newer MinIO moved bucket
usage) over the network at `S3_ENDPOINT`, with a token it signs from `S3_ROOT_USER`/`_PASSWORD`
(HS512, `iss: prometheus`, as `mc admin prometheus generate`), so it works wherever the store
runs and needs no setup. MinIO's free space is its drive's (statfs), so files put on that drive
any other way count (checked: 2 GB written beside it showed within 45 s; it rereads the drive
about once a minute); bucket usage comes from its scanner, a few minutes behind. Cached 30 s on
the server; Refresh skips that. Stores without these metrics (AWS S3, R2...) have no "space
left": `{ available: false }` and the panel says so.

## Friends

Built 2026-10-07, as Discord's. The DM list shows your friends and whoever you have a
conversation with (and the conversation open now), not everyone; friends are made by a request
the other person accepts.
- **Server** (`server/friends.js`, `routes/friends.js`): `friends` holds a friendship twice, once
  from each side; `friend_requests` those waiting. `GET /friends` → `{ friends: [{ id, since }],
  incoming, outgoing: [{ id, created_at }], admin }`; `PUT /friends/:id` asks (or accepts their
  request: asking someone who asked you makes you friends), `POST /friends { username }` the same
  by username, `DELETE /friends/:id` removes a friend, declines or cancels. Each answers with your
  lists plus `{ id, result }` ('requested', 'accepted', 'friends', 'removed', 'none'), and both
  people's devices get the `friends` event with their own lists. Bots, accounts waiting for
  approval and deleted accounts can't be friends (404); blocking either way (403 `code:
  'blocked'`, not saying who) stops requests, and blocking someone ends the friendship and any
  request (`routes/blocks.js`). Deleting an account deletes its friends and requests. Migration
  14 made every account at the time friends with every other (not bots, pending, deleted or
  blocked pairs), so nobody's list changed. No pushes for requests yet: the count in the app only.
- **Not a privacy boundary**: `/dms-list` still returns everyone (it's the app's directory:
  names, pictures and contact keys for guilds, calls and mentions; "Everyone sees everyone" in
  CLAUDE.md), and being friends isn't needed to DM someone (people meet in guilds, as in
  Discord). Friends only decide who's listed, and who can be put in a group DM (`NewGroupDialog`,
  `GroupMembers`' Add: friends only, in the app).
- **Client**: `utils/friends.js` (the store: `useFriends`, `addFriend`, `addFriendByName`,
  `removeFriend`, `relationOf`, `visibleInDmList`), kept by `hooks/useFriendsSync.js` in Layout.
  `DmSidebar` filters people with `visibleInDmList` and has a Friends row above Notes with how many
  requests wait (they also light the rail's DM button). A non-friend's first DM adds them to the
  list live (Layout marks `last_timestamp` on `new_dm`). Landing on `/dm` opens your latest
  conversation, or `/dm/friends` if you have none. `Friends.jsx` (`/dm/friends`): tabs Online, All,
  Pending (opens there when someone's asked), Add friend (by username), and for admins Everyone
  (every account, as the DM list used to be); a row opens the DM. A person's right-click menu
  (held on a phone; `utils/personMenu.js`) has Add Friend / Cancel Friend Request / Accept
  Friend Request / Remove Friend (asks). e2e: `e2e/friends.mjs`; `makeFriends` in `e2e/helpers.mjs` for
  scripts that need people in each other's list.

## Blocking, reports and suspensions

What Google Play's rules for apps with people's posts ask for (2026-10-05), and how the terms of
use (voicaw.com/terms/) say rules are enforced.
- **Blocking** (`server/blocks.js`, `user_blocks`; `GET /blocks`, `PUT` / `DELETE /blocks/:id`, the
  `blocks` event to your other devices; `utils/blocks.js` kept by `hooks/useBlocksSync.js` in
  Layout): neither person can DM, call or add the other to a group (403 `code: 'blocked'`, "Your
  message couldn't be delivered": never says who blocked whom), and the blocker isn't pushed
  about the other's group messages, guild mentions or group calls (`blockersAmong`). In the app,
  their messages are collapsed ("Blocked message · Show", `BlockedMessage.jsx` in `MessageList`),
  they don't show as typing, and a DM with them is closed ("You've blocked …" with Unblock in
  the header). Block / Unblock and Report are in the right-click menus of a person (anything
  marked `data-user-id`, PageMenus and `utils/personMenu.js`; held on a phone) and of the DM list (`DmMenu`, people and bots):
  `utils/safetyDialogs.js` makes the items, and since a menu closes on a pick, the confirmation
  and the report form are drawn by `SafetyDialogs.jsx` (in `App`). Not on yourself or a deleted
  account. Settings → Blocked users lists them. Deleting an account deletes its blocks both ways.
  Blocking also ends a friendship and any friend request either way (Friends).
- **Blocking webhooks** (`webhook_blocks`: who, the webhook, its guild and name then; `PUT` /
  `DELETE /blocks/webhooks/:id`, in the same `GET /blocks` / `blocks` event as `webhooks:
  [{ id, name, guild_id, guild_name }]`): right-click a webhook's name or picture on its message
  (`data-webhook-id`): Block Webhook (asks first) / Unblock Webhook, Copy Webhook ID; or "Also
  block" when reporting one of its messages. Its messages are collapsed like a blocked person's
  and its mentions aren't pushed (`webhookBlockersAmong` in `mentions.js`); nothing else (it has
  no DMs or calls). Only a webhook that has posted in a guild you're in (404 otherwise, so ids
  can't be probed for names). Kept after the webhook is deleted, since its messages stay (the
  list shows the name it had); deleted with the guild or your account. Settings → Blocked users
  lists them under the people, with their guild.
- **Reports** (`server/reports.js`, `routes/reports.js`, `reports` table): Report Message in the
  message menu and sheet (anyone else's message) and Report on a person (`ReportDialog.jsx`): a
  category, an optional note, "Also block". A guild message is copied into the report (the server
  has it anyway). A DM or group message is end-to-end encrypted: the report holds only who, where
  and when unless the reporter ticks "Let moderators see this message" (off by default), when the
  text they see goes along (`shared`: it can't be checked against the ciphertext). Webhook
  messages are reported against the guild's owner. At most 20 reports an hour each; resolved ones
  are deleted a year on (the hourly sweep in `auth.js`).
- **Settings → Admin → Reports** (`AdminReports.jsx`, global admins; `GET /admin/reports`): open
  reports (refreshed by `reports_changed`), Dismiss, Delete message (guild only, as a moderator:
  the guild's audit log says so), Suspend (with an optional reason); suspended accounts with Lift;
  recently resolved ones.
- **Suspension** (`server/suspensions.js`, `users.suspended_at` / `suspended_reason`): sessions and
  push subscriptions deleted, calls and voice ended, open apps told `account_suspended` (they log
  out, and the login page says why), every token refused (`verifyToken`), and logging in or
  recovering refused with 403 `code: 'suspended'` and the reason. Admins and yourself can't be
  suspended. Messages and memberships stay. Lifting it lets them log in again.
