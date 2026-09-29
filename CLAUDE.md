# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Voicaw is an end-to-end encrypted direct-messaging web app (Discord-style UI, DMs only — no
guild/channel messaging is wired up despite schema support). It's an npm workspaces monorepo with
three packages: `client` (React/Vite SPA, also packaged as an Electron desktop app), `server`
(Express + ws API), and `electron` (thin desktop shell wrapping the built client).

## Commands

Run from the repo root unless noted.

- `npm run dev` — start the client Vite dev server (port 5173, proxies `/api` to
  `https://api.voicaw.com`)
- `npm run build` — build the client for web deployment (outputs to `/opt/voicaw-client`)
- `npm run start:server` — start the Express/WebSocket server (`server/index.js`)
- `npm run start:electron` — build the client in Electron mode, then launch the Electron shell

Client-only (run inside `client/`):
- `npm run lint` — ESLint over `client/src`
- `npm run build:electron` — Vite build with `ELECTRON=true` (outputs to `../build`, relative
  base path, used by `electron/main.js`)

### Tests (Vitest)

- `npm test` (root) — runs server tests, then client tests
- `npm test` inside `server/` or `client/` — run one package's suite
- Single file / single test: `npx vitest run test/dm.test.js` (in `server/`) or
  `npx vitest run src/components/Dm.test.jsx -t "test name"` (in `client/`)

Server tests (`server/test/*.test.js`) are supertest integration tests against the real Express
app with an in-memory SQLite DB:
- `test/setupEnv.js` sets every required env var (including `DB_PATH=:memory:` and a freshly
  generated OPAQUE setup / VAPID keys), so no `.env` or S3 is needed. It also sets
  `DISABLE_RATE_LIMITS=1`, since suites register dozens of users from one address
  (`test/rateLimit.test.js` turns them back on).
- Each test file must `import './helpers/mockS3.js'` **before** requiring `../index.js`. `s3.js`
  hits the network at require-time, and because the server is plain CommonJS, `vi.mock` can't
  intercept it. The helper pre-seeds Node's `require.cache` instead (`mockWebPush.js` does the same
  for `web-push`).
- `test/helpers/authFlow.js` (`registerUser` / `loginUser`) runs the real OPAQUE + key backup
  client flow (importing `client/src/services/encryptionService.js`). Use it to get authenticated
  users (and their keys) rather than forging tokens.
- WebSocket handling is not covered: it only exists when `index.js` is run directly (see below).

### Server layout

`server/index.js` only assembles the app: CORS, `/api/config`, the routers, and the error handler.
Express 5 sends rejected async handlers to that handler, so routes don't need try/catch for
unexpected errors. The rest:
- `config.js`: loads `.env` (required first), checks it, message length limits.
- `db.js`: schema, plus promise helpers `db.get` / `db.all` / `db.run` (`run` resolves to
  `{ lastID, changes }`). Use these, not the callback API. The raw handle is `db.db`.
- `auth.js`: `generateToken`, `verifyToken`, the `authenticateJWT` middleware (attach it per
  route, not with `router.use`, since every router is mounted at `/api`).
- `sockets.js`: the `clients` map, `sendToUserSockets`, `isOnline`, `isViewingConversation`, and
  `attachWebSocketServer` (the ws server).
- `push.js`: web push sending and the DM push payload.
- `s3.js`: pre-signed upload URLs. Bucket setup at startup logs and carries on if the store is down.
- `routes/`: `auth.js` (OPAQUE register/login, profile), `dms.js` (conversations, send, edit,
  delete, unread; `DM_SELECT` is the shared message query), `reactions.js`, `push.js`
  (subscriptions), `uploads.js`.

Client tests sit next to their source files (`src/**/*.test.{js,jsx}`). The default environment is
`node`; component tests opt into DOM with a `// @vitest-environment jsdom` header on the first
line. `vitest.config.js` pins `VITE_API_BASE_URL`/`VITE_WS_URL`, and `src/test/setupTests.js`
stubs `ResizeObserver` (used by `MessageList`) and the Range measuring ProseMirror does. The message
box is an editor (contenteditable), which jsdom can't type into: tests drive it through its handle,
`editorFor(element)` from `editor/editorRegistry.js` (`insertText`, `setText`, `getText`...).
Component tests mock `../utils/api`,
`../utils/ws-client`, and `../services/dmService` with `vi.mock`.

### Server environment

The host runs Node 24 LTS (NodeSource apt package, shared by every pm2 app on it).
`sqlite3` 6's prebuilt binary needs glibc >= 2.38. On older hosts (this server runs Debian 12,
glibc 2.36) `npm install` succeeds but the server then crashes loading it. Such hosts need a
git-ignored `.npmrc` at the repo root containing `build_from_source=sqlite3` (compiles just
sqlite3, about 1.5 min, needs gcc/make/python3). After changing it, run
`npm rebuild sqlite3 --build-from-source`. npm 11 warns that `build_from_source` in `.npmrc` "will
stop working in the next major version of npm"; it still works, but will need replacing then.

`server/config.js` fails fast at startup if any of these env vars are missing (set them in
`server/.env`): `JWT_SECRET`, `OPAQUE_SERVER_SETUP`, `VAPID_EMAIL`, `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, `S3_ENDPOINT`, `S3_ROOT_USER`, `S3_ROOT_PASSWORD`. VAPID keys are generated
via `webpush.generateVAPIDKeys()` (see root `README.md`). `S3_*` vars point at an S3-compatible
object store (e.g. MinIO) used for uploads and profile pics.

## Architecture

### Auth: password-authenticated key exchange (OPAQUE), not plain password auth

Login/registration use `@serenity-kit/opaque` (OPAQUE PAKE protocol) on both client and server —
the server never sees the plaintext password. The flow is split into two round trips per
operation:
- Register: `POST /api/initiateregister` → `POST /api/finaliseregister`
- Login: `POST /api/initiatelogin` → `POST /api/finaliselogin`

Server-side login state is stored transiently in the `login_states` table (5-minute expiry) keyed
by username, cleaned up on successful login (expired rows are purged on each login attempt).

Logged-out visitors must not be able to tell which usernames exist. `/api/initiatelogin` answers an
unknown username with OPAQUE's dummy response (`registrationRecord: null`), so it fails at the end
exactly like a wrong password. Logged-in users can see every user (intentional: the app is for groups
where everyone knows each other). The client must never send its `clientLoginState` to the server.

Password guessing can only happen online (through the server), so `routes/auth.js` rate limits
it (`rateLimit.js`, in memory): login starts per IP (30 / 15 min) and per username (20 / 15 min,
applied whether or not the account exists; cleared by a successful login), registrations per IP.
Refusals are 429 with `Retry-After` and a message the login form shows. `req.ip` comes from
nginx's `X-Forwarded-For` (`trust proxy: 'loopback'`). test.voicaw.com goes through vite's proxy
to the public API, so its visitors all share one address there.
The websocket `user_status` broadcast only goes to identified sockets.

On successful login/register, the server issues a JWT (`generateToken`, 1-day expiry, see
`server/auth.js`) which the client stores in `localStorage` and sends as `Authorization: Bearer
<token>` (see `client/src/utils/api.js`). `authenticateJWT` middleware protects all `/api/*`
routes except config/login/register.

### End-to-end encryption

The goal is that a server admin can't read messages, including by swapping keys. All crypto is
WebCrypto, in `client/src/services/encryptionService.js`. Every format is versioned: messages
are `v1.<base64>`, key backups are `{v:1,...}`, and derivations/signatures are bound to
`voicaw/<purpose>/v1` strings.
- **Keys per user** (`generateUserKeys`): an **identity** key (ECDSA P-256) that *is* the user
  (safety numbers come from it), and an **encryption** key (ECDH P-256) for DMs, signed by the
  identity key (`verifyEncryptionKey`). Public keys are base64 raw points in `users.identity_key` /
  `encryption_key` / `encryption_key_signature`. The server checks the signature at registration.
  Future per-device or group keys should also be signed by the identity key, so safety numbers
  don't change.
- **Key backup:** both private keys are stored server-side only inside `users.key_backup`,
  encrypted (`wrapKeyBackup`, HKDF → AES-GCM) with OPAQUE's `exportKey`. That is argon2id-stretched,
  stable across logins, and never seen by the server. There is no PBKDF2 and no second password
  derivation. The backup also contains the public keys. On login (`services/authService.js`) the client refuses
  to continue if the server publishes different ones. A forgotten password means the history is
  lost, by design.
- **On the device** (`keyStore.js`): non-extractable private `CryptoKey`s plus the user's *own*
  public keys (from the backup, never from the server) in IndexedDB. `clearUserKeys` runs on
  logout.
- **Contacts** (`contactKeys.js`, IndexedDB, per logged-in account): trust on first use. Never
  use a contact key straight from the server. `checkContactKeys` verifies the signature, pins the
  identity key, and returns `'changed'` (the conversation is blocked until the user accepts,
  `ContactKeyWarning`) or `'invalid'`. Users compare 60-digit safety numbers (`safetyNumber.js`,
  `SafetyNumberDialog`) and can mark contacts verified.
- **DMs:** `deriveConversationKey` (ECDH → HKDF → AES-GCM) uses the *pinned* contact key.
  `encryptMessage`/`decryptMessage` take `dmContext(senderId, recipientId)` as AES-GCM additional
  data, so the server can't re-attribute or move messages. Replies and edits use the original
  message's sender/recipient.
- **Reactions** (`dm_reactions`): the emoji is encrypted (`encryptReaction`) with the conversation
  key, zero-padded to `REACTION_PLAINTEXT_BYTES` (64) so every envelope is 127 chars (the server
  rejects any other length) and its size doesn't reveal the emoji. `reactionContext(messageId,
  reactorId, senderId, recipientId)` is the additional data, so a reaction can't be moved or
  re-attributed. Which message was reacted to, by whom and when is deliberately visible, like reply
  links: hiding it would mean syncing every reaction in a conversation on each device (the server
  couldn't look them up per message). `GET /api/dm-messages` returns each message's `reactions`
  (`withReactions`); `POST /api/dm-reactions` / `DELETE /api/dm-reactions/:id` (own only, max 20
  per person per message) push `reaction_add` / `reaction_remove`. Deleting a message deletes its
  reactions. No push notifications for reactions.

Never log plaintext, session keys, tokens or `OPAQUE_SERVER_SETUP`; server logs end up in pm2.
The server stores and relays only ciphertext. Message length limits (`MAX_MESSAGE_LENGTH`
server-side, `/api/config` client-side) are computed on the envelope length via
`getMaxEncryptedLength` (`v1.` + base64 of IV + ciphertext + tag).

### Realtime: WebSocket for push, REST for fetch/mutate

`server/index.js` exports the Express `app`; only when run directly (`require.main === module`)
does it bind `PORT` (default 3000) and attach the `ws` server (`sockets.js`
`attachWebSocketServer`) to the same HTTP server. `clients` and `sendToUserSockets` are
module-level in `sockets.js`, so routes can push events (and tests can fake sockets through
`app.locals.clients`). Clients
identify themselves post-connect with `{ type: 'identify', token }` (JWT); the server maps
`userId -> [sockets]` in an in-memory `clients` Map (a user can have multiple open sockets/tabs).
Server -> client push events: `new_dm`, `delete_dm`, `edit_dm`, `reaction_add`, `reaction_remove`,
`user_status`. A 30s heartbeat
(ping/pong) prunes dead connections and broadcasts `offline` status.

Client side, `client/src/utils/ws-client.js` wraps this with `connectWebSocket`/`closeWebSocket`
and a pub/sub listener API (`onNewDm`, `onDeleteDm`, `onEditDm`, `onReactionAdd`, `onReactionRemove`, `onUserStatus`), auto-reconnecting
every 3s on close. All non-realtime DM operations (fetch history, send, mark read) go through the
plain REST API in `client/src/services/dmService.js` / `client/src/utils/api.js` instead.

### Push notifications (Web Push)

Web push (`web-push` + VAPID) is the **only** source of OS notifications; the page itself never
shows a `Notification`. Subscriptions live per device in `push_subscriptions` (an endpoint belongs to
one user at a time).
- Client (`services/pushService.js`): `getPushStatus()` covers each platform. On iOS/iPadOS, web push
  only works from the Home Screen app. `enableNotifications()` must be called directly from a tap
  (`requestPermission()` first, or iOS drops the gesture). It's used by `NotificationPrompt` (banner
  in the DM view) and `NotificationSettings` (Settings). `Layout` re-syncs the subscription on every
  start via `ensureSubscription()` when permission is granted and the user hasn't turned it off
  (`localStorage.pushDisabled`). Logout calls `disableNotificationsOnThisDevice()` *before* the token
  is cleared, so the server forgets the device.
- Server: `sendPushToUser()` (drops 404/410 subscriptions). New DMs are pushed unless
  `isViewingConversation()` says the recipient is looking at that chat. That uses `presence`
  websocket messages (`{visible, chatId}`) that `ws-client` sends on focus/visibility/chat changes
  and every 15s. The server ignores presence older than 35s.
- Previews stay end-to-end encrypted. The DM push carries the ciphertext (never a key) when it fits
  in a push (~4KB), plus `senderId`/`recipientId`. `service-worker.js` → `services/pushNotifications.js`
  decrypts it on the device with the sender's *pinned* key (`contactKeys`) and the user's key
  (`keyStore`). It falls back to "New message" when the message is too big, previews are off
  (`settingsStore`, IndexedDB, readable by the SW), this device has never checked the sender's
  keys, or the device is logged out. Notifications are tagged per conversation.
- `pushsubscriptionchange` posts to the unauthenticated `/api/update-subscription`, keyed by the
  old endpoint. `/api/test-push` sends a test notification to all of the caller's devices.
- The PWA manifest is `public/manifest.json` only (VitePWA `manifest: false`). The dev server also
  serves the real service worker (`devOptions`), so push works on test.voicaw.com.

### Database

SQLite via `sqlite3`, single file `server/voicaw.db` (overridable with `DB_PATH`), schema created idempotently
(`CREATE TABLE IF NOT EXISTS`) in `server/db.js` on require. Queries use the small promise helpers
in `db.js` (no ORM, no migrations). Note: the schema includes
`guilds`/`categories`/`channels`/`messages`/roles/permissions tables for a Discord-like
multi-channel model, but only the `direct_messages` / `dm_reactions` / `dm_unread` / `users` / `push_subscriptions`
/ `login_states` tables are actually used by current routes — guild/channel features aren't
implemented yet.

### File uploads (S3-compatible object store)

`server/s3.js` wraps `@aws-sdk/client-s3` against `S3_ENDPOINT` (`forcePathStyle: true`, so this
targets a self-hosted/MinIO-style endpoint, not raw AWS). It auto-creates and makes public two
buckets on startup: `uploads`, `profile-pics`. Uploads are client-direct: the server only
issues short-lived (60s) pre-signed PUT URLs (`/api/upload_file`, `/api/upload_profile_pic`); the
client uploads the file straight to S3, bypassing the app server. Both routes require a `size` query
param, which is signed into the URL together with the content type (`s3.js` `signableHeaders`), so
the object store rejects a body of any other length or type (verified against the live MinIO).
Limits: 100MB for attachments (nginx's cap on media.voicaw.com), 8MB for profile pictures, which must
be `image/*`. Profile pictures are unencrypted.

### DM attachments (encrypted, uploaded on send)

Attachments are never uploaded when attached. The composer (`Composer.jsx`, `hooks/useAttachmentDrafts.js`) keeps them as local drafts
and inserts a markdown placeholder `![name](attachment:ID)` (`utils/attachmentMarkup.js`; the editor
shows it as a "📎 name" chip); the tray
(`AttachmentTray.jsx`) previews drafts still referenced from the text. On send, each referenced
draft is encrypted with its own AES-GCM key (`services/attachmentCrypto.js`), uploaded as
`application/octet-stream` (`services/attachmentUpload.js`; server names it `<uuid>.bin`), and its
placeholder is replaced with `<fileUrl>#v=1&k=<key>&t=<mime>&s=<size>[&w=<px>&h=<px>]` (image/video
dimensions, read at attach time by `utils/mediaDimensions.js`, let the renderer reserve the final
box before the file loads). The fragment is never sent
to S3 and the URL only exists inside the E2EE message. `Attachment.jsx` renders every markdown image:
placeholders (pending messages, from local blob URLs), encrypted attachments (fetched, decrypted,
cached in `services/attachmentCache.js`; images/videos inline, anything else a download box), and
plain URLs (legacy unencrypted uploads, external images) as `<img>`. Because placeholders are
shorter than final URLs, the send-time length check uses same-length stand-in URLs.

### Emoji (Discord-style, default Unicode set)

Messages store plain Unicode emoji; there is no server-side emoji data. `client/src/emoji/`:
- `emojiIndex.js`: emoji data from `@emoji-mart/data` (`sets/15/twitter.json`, lazy-loaded) and
  Twemoji art from `@twemoji/svg` (both Unicode 15, so every emoji has an image; a test checks
  this). It provides search, a shortcode map, and a matcher for emoji in text. `twemojiFile()`
  gives Twemoji's file-naming rule.
- Images are **self-hosted** at `/emoji/<file>.svg` by the `twemojiAssets` plugin in
  `client/vite.config.js`: served from the npm package in dev, copied into the build otherwise,
  and not precached. There is no CDN and no setup for a new install. The artwork is CC-BY 4.0,
  so keep the attribution in Settings. The service worker caches them cache-first (cache
  `emoji-<twemoji version>`), so each is fetched once per device. The picker only sets an
  image's `src` once it's within a screen of the visible area (its own `IntersectionObserver`,
  not `loading="lazy"`, which queued hundreds of offscreen images ahead of the visible ones).
- Everywhere else (the message box while typing, names, previews, buttons) emoji are Twemoji
  too, via a colour font: `assets/css/twemoji-font.css` is first in the body font stack, limited
  by `unicode-range` to its emoji (not the digits, `#`, `*`, ©, ® it also has). A text box can't
  show images, so this is how typing looks right. Bundled into `/assets/`, loaded once an emoji
  is on screen. The font, `assets/fonts/twemoji-voicaw.woff2` (COLR, Twemoji 15, SIL OFL, credited
  in Settings), is generated from the `twemoji-colr-font` dev dependency by
  `client/scripts/patch-twemoji-font.py` (fonttools): Chrome and Safari drop U+FE0F before the
  font sees the text, so its ligatures for sequences containing FE0F (🏳️‍🌈, ❤️‍🔥, 🧔‍♂️…) never
  matched and showed as two emoji; the script adds FE0F-less copies. Re-run it after updating
  the package.
- `EmojiProvider` (in `App.jsx`) loads the index. `rehypeTwemoji` turns emoji in rendered
  messages into `<img class="emoji">` (skipping code). `MessageList`'s `MarkdownImage` passes
  those through (not to `Attachment`), and emoji-only messages get `.emoji-only` (large).
- The message box is `editor/MessageEditor.jsx`, a small ProseMirror editor (also used for editing a
  sent message). Its value is plain message text (`editor/messageDoc.js`): lines are paragraphs,
  draft attachments are chips, custom emoji `<:name:id>` are inline images (ready for guild
  emoji; nothing creates them yet). Unicode emoji stay text, drawn by the Twemoji font, so
  typing, autocorrect, IME and copy/paste stay plain. Pasting is always plain text (files go to
  attachments); edits past the length limit are refused. Enter sends on desktop, Shift+Enter is a
  new line; on mobile Enter is a new line. The ref handle (`focus`, `blur`, `insertText`,
  `replaceBeforeCaret`, `insertAttachments`, `removeAttachment`, `clear`...) is how `Composer`
  and `Dm` drive it.
- Composer (`Composer.jsx`): `EmojiPicker` (search, categories, frequently used and skin tone, both in
  localStorage via `emojiUsage.js`), `:sm` autocomplete (`EmojiSuggestions`), and a completed
  `:shortcode:` turns into the emoji as you type. `remark-emoji` still renders any leftover
  `:shortcode:` text.
- Mobile: the picker is `docked` in the on-screen keyboard's place, at its height
  (`utils/keyboardHeight.js` measures it via `visualViewport` and remembers it per device). It and
  the keyboard are never open together: opening it blurs the message box, and the button (⌨️ while
  open) or focusing the message box swaps back. Picks don't close it. Searching is the one
  exception: tapping its search box (never auto-focused, since iOS only opens the keyboard for a
  real tap) switches to full-screen search, sized to the visible area above the keyboard
  (`utils/useVisualViewport.js`, unrounded, plus 1px hidden under the keyboard so no seam shows).
  On Chromium (Chrome/Brave Android) the visual viewport height is wrong there: with the address
  bar at the bottom it comes out one toolbar short, leaving a gap. So during search only, the
  search box turns on `navigator.virtualKeyboard.overlaysContent` (on pointerdown, before the
  keyboard opens) and the picker runs to the keyboard's exact `boundingRect` top
  (`utils/virtualKeyboard.js`). It's switched off again on leaving search or closing. Add
  `?kbdebug` to the URL to show the numbers on screen.
  Picking (or Enter) or going back returns to the docked panel and dismisses the keyboard. If the
  keyboard closes some other way (search box blurred, or Android's back button with focus kept),
  it returns to the docked size and keeps the results. Result taps don't take focus from the
  search box, so the picker can't shrink mid-tap. `MessageList` keeps the chat pinned
  to the bottom when the list's own height changes (a `ResizeObserver` on the scroller, plus
  ignoring the browser's scroll-anchoring nudge during that resize).
- Planned: custom per-guild emoji, as plain (unencrypted) images written `<:name:id>` in message
  text (currently left as text), shown as extra picker sections. They fit in a reaction's 64
  padded bytes too.
- Reactions (see End-to-end encryption): `MessageReactions` chips under a message (grouped by
  emoji, each person counted once, yours highlighted; tap to toggle, `+` to add). The message
  menu's smiley opens `EmojiPicker` for it: floating by the button on desktop
  (`reactionPickerPosition`, a zero-size fixed `.reaction-picker-anchor`), docked in the keyboard's
  place on mobile, closing after the pick. Search matches several words ("thumbs up").

### DM message list and history loading

`MessageList` is deliberately **not virtualized**: every loaded message is rendered in a plain
scroll container. Virtualized lists (react-virtuoso was used before) must guess the height of
rows they haven't rendered and correct afterwards, which showed as the chat jumping while
scrolling up. Measured in headless Chrome, the plain list has no such jumps. The browser's CSS
scroll anchoring (`overflow-anchor`) keeps visible messages still when older pages are prepended
or content above resizes. Where that's unsupported (Safari), `MessageList` does the same manually
by tracking the first visible row's `offsetTop` (layout effect + ResizeObserver, both before paint).
It also keeps the view pinned to the bottom while the user is there.

`hooks/useConversation.js` loads a conversation in exactly one effect (keyed on `id` + the other user's public key,
ignoring late responses after a chat switch). Older pages (`PAGE_SIZE`, sent as `limit`, server
clamps 1–100, default 10) are only ever prepended by `loadMoreMessages`, which guards against
overlapping loads and drops ids already present. Rows are keyed by `clientKey ?? id`
(`clientKey` carries a sent message's temp id). react-markdown's `components` must be a stable
object, or attachments remount on every render. Image/video attachments carry their dimensions so
their box is reserved before they load.

### Client structure

- Component files export only components (Vite hot reload needs that; lint enforces it).
  Contexts live in `contexts.js` (`ConfigContext`, `InteractionContext`, `LayoutContext`) and
  `hooks/useAuth.js`; logic lives in `hooks/` and `services/`.
- `AuthProvider.jsx` — fetches `/api/profile` on mount to restore the session (id, username, JWT)
  into `useAuth`; the keys come from IndexedDB (`keyStore`). `services/authService.js` does the
  OPAQUE login/register (`Login.jsx` is just the form).
- `App.jsx` — top-level routing; swaps `BrowserRouter` for `HashRouter` when running inside
  Electron (detected via user-agent sniffing); provides `ConfigContext` (fetched from
  `/api/config`) and `InteractionContext` (mobile vs. desktop interaction mode, persisted to
  `localStorage`, auto-detected via user-agent unless overridden)
- `Layout.jsx` — the logged-in shell: sidebars, users list and unread counts (`LayoutContext`).
  `DmSidebar` draws the unread dots from those counts. `SidebarWrapper` puts the sidebars in a
  row with `UserPanel` across the bottom: your picture, name, this device's connection state
  (`ws-client` `getConnectionState`/`onConnectionState`: online / connecting / offline) and the
  settings button. It's only shown with the conversation list (DM pages), not on e.g. Settings.
  Uploading a profile picture calls `announceProfilePictureChange()` so it refreshes.
- Mobile message actions: there's no hover menu on mobile. A long press on a message
  (`hooks/useLongPress.js`, 450ms, cancelled by scrolling) opens `MessageActionSheet`: quick
  reactions (most used first, then 👍❤️😂😮😢🙏) and `+` for the full picker, Reply, Edit,
  Copy text (attachments become their names, never their key-carrying links) and Delete (asks
  first). The sheet ignores the click Chrome fires when the holding finger lifts (it lands on the
  sheet); only clicks from a touch that started on it count. Messages aren't text-selectable
  on mobile, so the long press isn't taken by text selection.
- DM view: `Dm.jsx` puts together `hooks/useConversation.js` (keys, history, paging, send/edit/
  delete, live websocket updates), `hooks/useReactions.js`, `MessageList.jsx` (+ `MessageReactions`,
  `UrlPreviews`) and `Composer.jsx` (message box, emoji, reply bar, attachments via
  `hooks/useAttachmentDrafts.js`). `Dm.jsx` owns what several of them share: reply target, edit
  state, the composer error line, and which emoji picker is open (never both).
- Scrollbars are styled once, in `voicaw.css` (SCROLLBARS): every scroll area inherits the pane
  look (like the message list); small boxes and pop-ups are listed there for the thin one. Don't
  style a new scroll area's scrollbar locally.
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
  are gone from the server (`vite:preloadError`), are offered a reload.
