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
- `test/helpers/authFlow.js` (`registerUser` / `loginUser`) runs the real OPAQUE + key-wrapping
  client flow (importing `client/src/services/encryptionService.js`) — use it to get authenticated
  users rather than forging tokens.
- WebSocket handling is not covered: it only exists when `index.js` is run directly (see below).

Client tests sit next to their source files (`src/**/*.test.{js,jsx}`). The default environment is
`node`; component tests opt into DOM with a `// @vitest-environment jsdom` header on the first
line. `vitest.config.js` pins `VITE_API_BASE_URL`/`VITE_WS_URL`, and `src/test/setupTests.js`
stubs `ResizeObserver` (needed by react-virtuoso). Component tests mock `../utils/api`,
`../utils/ws-client`, and `../services/dmService` with `vi.mock`.

### Server environment

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
by username, cleaned up on successful login.

On successful login/register, the server issues a JWT (`generateToken`, 1-day expiry, see
`server/index.js`) which the client stores in `localStorage` and sends as `Authorization: Bearer
<token>` (see `client/src/utils/api.js`). `authenticateJWT` middleware protects all `/api/*`
routes except config/login/register.

### End-to-end encryption of DMs

Each user has an ECDH P-256 keypair (PEM-encoded). The public key is stored server-side
(`users.public_key`); the private key is stored server-side too, but **encrypted** with a key
derived from the user's password via PBKDF2 (`users.private_key`) — the server can never decrypt
it. All of this lives in `client/src/services/encryptionService.js`:
- `generateECDH_P256_PEM()` — keypair generation at registration
- `encryptPrivateKey` / `decryptPrivateKey` — PBKDF2(password) + AES-GCM wrapping of the private
  key for server storage
- `deriveSharedKey(myPrivateKey, theirPublicPEM)` — ECDH shared secret → AES-GCM key, used to
  encrypt/decrypt DM content between exactly two users (`myPrivateKey` is a `CryptoKey` or PEM)
- `encryptMessage` / `decryptMessage` — AES-GCM with a random IV, base64-encoded
- `decryptMessagesBatch` — bulk-decrypts fetched message pages, tolerating individual failures

After login/registration the unwrapped private key is kept on the device by
`client/src/services/keyStore.js` as a **non-extractable** `CryptoKey` in IndexedDB
(`storePrivateKey` / `loadPrivateKey` / `clearPrivateKey`) — never as a PEM in `localStorage`.
`loadPrivateKey` migrates any legacy `localStorage.privateKey` PEM on first use. Never log
plaintext, session keys, tokens or `OPAQUE_SERVER_SETUP` — server logs end up in pm2.

The server stores and relays only ciphertext (`direct_messages.content`); message length limits
(`MAX_MESSAGE_LENGTH` server-side, `/api/config` client-side) are computed on the encrypted
(base64) length via `getMaxEncryptedLength`, not the plaintext length.

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

Web Push (`web-push` + VAPID) is a separate, independent notification channel from the WebSocket
connection — subscriptions are stored per-user in `push_subscriptions` and triggered alongside
`new_dm` socket events for offline delivery.

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
client uploads the file straight to S3, bypassing the app server. Profile pictures are unencrypted.

### DM attachments (encrypted, uploaded on send)

Attachments are never uploaded when attached. The composer (`Dm.jsx`) keeps them as local drafts
and inserts a markdown placeholder `![name](attachment:ID)` (`utils/attachmentMarkup.js`); the tray
(`AttachmentTray.jsx`) previews drafts still referenced from the text. On send, each referenced
draft is encrypted with its own AES-GCM key (`services/attachmentCrypto.js`), uploaded as
`application/octet-stream` (`services/attachmentUpload.js`; server names it `<uuid>.bin`), and its
placeholder is replaced with `<fileUrl>#v=1&k=<key>&t=<mime>&s=<size>`. The fragment is never sent
to S3 and the URL only exists inside the E2EE message. `Attachment.jsx` renders every markdown image:
placeholders (pending messages, from local blob URLs), encrypted attachments (fetched, decrypted,
cached in `services/attachmentCache.js`; images/videos inline, anything else a download box), and
plain URLs (legacy unencrypted uploads, external images) as `<img>`. Because placeholders are
shorter than final URLs, the send-time length check uses same-length stand-in URLs.

### Client structure

- `AuthProvider.jsx` — fetches `/api/profile` on mount to restore session (id, username, JWT,
  encrypted private key, VAPID public key) into React context
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
