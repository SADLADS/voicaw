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
  generated OPAQUE setup / VAPID keys), so no `.env` or S3 is needed.
- Each test file must `import './helpers/mockS3.js'` **before** requiring `../index.js`. `s3.js`
  hits the network at require-time, and because `index.js`/`s3.js` are plain CommonJS, `vi.mock`
  can't intercept them — the helper pre-seeds Node's `require.cache` instead.
- `test/helpers/authFlow.js` (`registerUser` / `loginUser`) runs the real OPAQUE + key backup
  client flow (importing `client/src/services/encryptionService.js`). Use it to get authenticated
  users (and their keys) rather than forging tokens.
- WebSocket handling is not covered: it only exists when `index.js` is run directly (see below).

Client tests sit next to their source files (`src/**/*.test.{js,jsx}`). The default environment is
`node`; component tests opt into DOM with a `// @vitest-environment jsdom` header on the first
line. `vitest.config.js` pins `VITE_API_BASE_URL`/`VITE_WS_URL`, and `src/test/setupTests.js`
stubs `ResizeObserver` (used by `MessageList`). Component tests mock `../utils/api`,
`../utils/ws-client`, and `../services/dmService` with `vi.mock`.

### Server environment

`sqlite3` 6's prebuilt binary needs glibc >= 2.38. On older hosts (this server runs Debian 12,
glibc 2.36) `npm install` succeeds but the server then crashes loading it. Such hosts need a
git-ignored `.npmrc` at the repo root containing `build_from_source=sqlite3` (compiles just
sqlite3, about 1.5 min, needs gcc/make/python3). After changing it, run
`npm rebuild sqlite3 --build-from-source`.

`server/index.js` fails fast at startup if any of these env vars are missing (set them in
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
The websocket `user_status` broadcast only goes to identified sockets.

On successful login/register, the server issues a JWT (`generateToken`, 1-day expiry, see
`server/index.js`) which the client stores in `localStorage` and sends as `Authorization: Bearer
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
  derivation. The backup also contains the public keys. On login (`Login.jsx`) the client refuses
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

Never log plaintext, session keys, tokens or `OPAQUE_SERVER_SETUP`; server logs end up in pm2.
The server stores and relays only ciphertext. Message length limits (`MAX_MESSAGE_LENGTH`
server-side, `/api/config` client-side) are computed on the envelope length via
`getMaxEncryptedLength` (`v1.` + base64 of IV + ciphertext + tag).

### Realtime: WebSocket for push, REST for fetch/mutate

`server/index.js` exports the Express `app`; only when run directly (`require.main === module`)
does it bind `PORT` (default 3000) and attach a `ws` server to the same HTTP server. Code that
needs the socket server (`wss`, heartbeat, connection handlers) lives inside that block, while
`clients` and `sendToUserSockets` stay at module level so routes can push events. Clients
identify themselves post-connect with `{ type: 'identify', token }` (JWT); the server maps
`userId -> [sockets]` in an in-memory `clients` Map (a user can have multiple open sockets/tabs).
Server -> client push events: `new_dm`, `delete_dm`, `edit_dm`, `user_status`. A 30s heartbeat
(ping/pong) prunes dead connections and broadcasts `offline` status.

Client side, `client/src/utils/ws-client.js` wraps this with `connectWebSocket`/`closeWebSocket`
and a pub/sub listener API (`onNewDm`, `onDeleteDm`, `onEditDm`, `onUserStatus`), auto-reconnecting
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
(`CREATE TABLE IF NOT EXISTS`) in `server/db.js` on require. All queries in `server/index.js` use
the plain callback-style `sqlite3` API (no ORM, no migrations). Note: the schema includes
`guilds`/`categories`/`channels`/`messages`/roles/permissions tables for a Discord-like
multi-channel model, but only the `direct_messages` / `dm_unread` / `users` / `push_subscriptions`
/ `login_states` tables are actually used by current routes — guild/channel features aren't
implemented in `index.js` yet.

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

Attachments are never uploaded when attached. The composer (`Dm.jsx`) keeps them as local drafts
and inserts a markdown placeholder `![name](attachment:ID)` (`utils/attachmentMarkup.js`); the tray
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
  so keep the attribution in Settings.
- `EmojiProvider` (in `App.jsx`) loads the index. `rehypeTwemoji` turns emoji in rendered
  messages into `<img class="emoji">` (skipping code). `MessageList`'s `MarkdownImage` passes
  those through (not to `Attachment`), and emoji-only messages get `.emoji-only` (large).
- Composer (`Dm.jsx`): `EmojiPicker` (search, categories, frequently used and skin tone, both in
  localStorage via `emojiUsage.js`), `:sm` autocomplete (`EmojiSuggestions`), and a completed
  `:shortcode:` turns into the emoji as you type. `remark-emoji` still renders any leftover
  `:shortcode:` text.
- Mobile: the picker is `docked` in the on-screen keyboard's place, at its height
  (`utils/keyboardHeight.js` measures it via `visualViewport` and remembers it per device). It and
  the keyboard are never open together: opening it blurs the message box, and the button (⌨️ while
  open) or focusing the message box swaps back. There's no search box when docked (typing `:name`
  in the composer searches instead), and picks don't close it. `MessageList` keeps the chat pinned
  to the bottom when the list's own height changes (a `ResizeObserver` on the scroller, plus
  ignoring the browser's scroll-anchoring nudge during that resize).
- Planned: custom per-guild emoji, as plain (unencrypted) images written `<:name:id>` in message
  text (currently left as text), shown as extra picker sections. Reactions in encrypted chats
  must be encrypted with the conversation key.

### DM message list and history loading

`MessageList` is deliberately **not virtualized**: every loaded message is rendered in a plain
scroll container. Virtualized lists (react-virtuoso was used before) must guess the height of
rows they haven't rendered and correct afterwards, which showed as the chat jumping while
scrolling up. Measured in headless Chrome, the plain list has no such jumps. The browser's CSS
scroll anchoring (`overflow-anchor`) keeps visible messages still when older pages are prepended
or content above resizes. Where that's unsupported (Safari), `MessageList` does the same manually
by tracking the first visible row's `offsetTop` (layout effect + ResizeObserver, both before paint).
It also keeps the view pinned to the bottom while the user is there.

`Dm.jsx` loads a conversation in exactly one effect (keyed on `id` + the other user's public key,
ignoring late responses after a chat switch). Older pages (`PAGE_SIZE`, sent as `limit`, server
clamps 1–100, default 10) are only ever prepended by `loadMoreMessages`, which guards against
overlapping loads and drops ids already present. Rows are keyed by `clientKey ?? id`
(`clientKey` carries a sent message's temp id). react-markdown's `components` must be a stable
object, or attachments remount on every render. Image/video attachments carry their dimensions so
their box is reserved before they load.

### Client structure

- `AuthProvider.jsx` — fetches `/api/profile` on mount to restore the session (id, username, JWT)
  into React context; the keys come from IndexedDB (`keyStore`)
- `App.jsx` — top-level routing; swaps `BrowserRouter` for `HashRouter` when running inside
  Electron (detected via user-agent sniffing); provides `ConfigContext` (fetched from
  `/api/config`) and `InteractionContext` (mobile vs. desktop interaction mode, persisted to
  `localStorage`, auto-detected via user-agent unless overridden)
- `components/Dm.jsx` / `MessageList.jsx` / `DmSidebar.jsx` — DM view, message list/composer, and
  conversation list
- Desktop vs. mobile layouts are two separate CSS files (`assets/css/desktop.css` /
  `mobile.css`) toggled via body classes rather than component-level responsive branches
- PWA support via `vite-plugin-pwa` (`injectManifest` strategy, custom `src/service-worker.js`) —
  service worker handles push notifications and posts `navigate` messages back to the app, which
  `SWMessageHandler` in `App.jsx` listens for
