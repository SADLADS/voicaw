# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Voicaw is a Discord-style chat web app: end-to-end encrypted direct messages and group DMs
(with calls), and guilds
(servers with text and voice channels, roles and private channels; not encrypted, see Guilds). It's an npm workspaces monorepo with
three packages: `client` (React/Vite SPA, also packaged as an Electron desktop app), `server`
(Express + ws API), and `electron` (thin desktop shell wrapping the built client).

## Working on Voicaw (read first)

Each feature is worked on in its own chat, on its own branch, in its own worktree. The rules:

- **`dev` is the deploy branch.** A push to it makes the webhook (`~/code/gitWebhookListener.js`,
  not in git) pull `/home/otto/git/voicaw`, run `npm install` if the lockfile changed, and
  restart pm2 `voicaw-api` (the live API on :3002, with the real database) and `voicaw-test`
  (test.voicaw.com: `vite dev` on :5173, using the live API). voicaw.com itself is a static build
  in `/opt/voicaw-client`, only updated by running `npm run build` by hand. Voice runs on a
  self-hosted LiveKit server, pm2 `voicaw-livekit` (`~/livekit`, not in git; the webhook doesn't
  touch it).
- **Never commit to, merge into, push, reset or otherwise move `dev`.** Branch off it
  (`feature-name`), commit there; the user reviews and merges. Don't push branches unless asked.
- **Never work in `/home/otto/git/voicaw`.** It's the live checkout: switching its branch
  changes what test.voicaw.com serves and stops deploys. Use a worktree per feature:
  ```
  git -C ~/git/voicaw worktree add ~/git/voicaw-<feature> -b <feature> dev
  cp ~/git/voicaw/.npmrc ~/git/voicaw-<feature>/    # git-ignored; needed on this host (see below)
  cd ~/git/voicaw-<feature> && npm install          # compiles sqlite3, ~1.5 min
  ```
  Chats running at the same time each need their own worktree (and their own e2e ports, see
  Browser checks). Check `git branch --show-current` before committing. Once the user has
  merged a branch, its worktree can go: `git -C ~/git/voicaw worktree remove ~/git/voicaw-<feature>`
  (ask before deleting branches).
- **Don't touch production** unless asked: no pm2 restarts, no edits to nginx, `server/.env`,
  `~/livekit/livekit.yaml`, the real database or `/opt/voicaw-client`. Never run `pm2 update` (on 2026-09-29 it left every
  app on the host stopped; `pm2 resurrect` brought them back). The host also runs other
  projects' apps under the same pm2 and Node.
- **Done means:** server and client tests pass, `npm run lint` (in `client/`) is clean, UI
  changes are checked in a real browser (Browser checks below), and this file is updated when
  something it describes changes. When a change affects how a new host is set up (a new env
  var, service, port, bucket, nginx site, build step or dependency on the host), update
  `README.md`'s "Initial setup" in the same branch: it's the only setup guide. Then commit on the branch with a message saying what and why.
- **Secrets:** never log or commit plaintext messages, keys, tokens, `OPAQUE_SERVER_SETUP`,
  anything from `server/.env` or the LiveKit API secret.

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

### Browser checks (real Chrome, throwaway server)

Unit tests can't see layout, scrolling, focus, touch or the editor. For those, `e2e/` runs the
real app against a throwaway API (in-memory database, fresh secrets, rate limits off, and a
stand-in object store in memory, so uploads, profile pictures and emoji work) and drives it with Playwright (`playwright-core`, using the system Chrome
at `/usr/bin/google-chrome`, headless):
```
node e2e/serve.mjs &     # web :5199, API :3099, object store :3100, LiveKit :3101-3103;
                         # E2E_WEB/API/S3/LIVEKIT_PORT
node e2e/smoke.mjs       # two users, one message delivered live; an example to copy
node e2e/guilds.mjs [dir] # guilds end to end (desktop + phone); screenshots into dir
node e2e/roles.mjs [dir]  # roles, colours, private channels, channel permissions
node e2e/emoji.mjs [dir]  # custom emoji (upload, picker, :name:, reactions, DM), rail order
node e2e/voice.mjs [dir]  # voice: join, hear, speaking ring, mute/deafen, phone, leave
node e2e/calls.mjs [dir]  # DM calls: ring, answer, encrypted (asks LiveKit), mute, decline, phone
node e2e/groups.mjs [dir] # group DMs: create, add (no old messages), remove, group call, owner leaves
node e2e/presence.mjs [dir] # online status: idle, mobile, no flicker on reload, last seen
node e2e/recovery.mjs [dir] # change password, recovery code reset, new code, code on old login
kill %1                  # stops all the servers (kill the serve.mjs process itself)
```
For voice, `serve.mjs` also runs its own LiveKit (the binary at `LIVEKIT_BIN`, default
`~/livekit/livekit-server`; skipped with a note if missing) on 127.0.0.1 with fresh keys and its
webhook pointed at the throwaway API. `fakeMicArgs()` (helpers) gives Chrome a fake microphone
playing a made-up speech-like sound: Chrome's own fake mic is a steady beep, which the browser's
noise suppression removes, so it never counts as talking. `serve.mjs` also leaves its LiveKit's
address and keys where `livekitInfoPath()` says (scripts that ask LiveKit itself need
`E2E_API_PORT` too).
Scripts need the same `E2E_WEB_PORT` as `serve.mjs` when not using the default.
Never use ports 5173 or 3002 (the live test site and API) or 7880-7882 (the live LiveKit);
`serve.mjs` refuses them. Kill test
processes by PID, never `pkill -f` with a pattern that's in your own command line (it kills your
shell). `e2e/helpers.mjs` has `signUp` (registers a user in its own browser context, unique
name; returns its `password` and `recoveryCode` too), `openChat`, `send`, `launchChrome`, and `devices` (e.g. `devices['Pixel 7']` for a phone).
Vite re-optimises its dependencies (and reloads the page) on its first start after the lockfile
changes; if the first check fails that way, run it again.
The message box is a contenteditable: `page.fill('#dm-input', …)` and `page.keyboard.type` work.
Tips:
- Headless Chrome hides scrollbars in screenshots; launch with
  `ignoreDefaultArgs: ['--hide-scrollbars']` to see them.
- After a tap, Playwright moves its mouse back, so hover-dependent UI vanishes; real phones keep
  the hover. Long press: CDP `Input.dispatchTouchEvent` start, wait, end.
- Measure layout after paint (post a `MessageChannel` message from `requestAnimationFrame`), not
  inside rAF, or you see states before `ResizeObserver` corrections.
- Firefox and WebKit builds are cached in `~/.cache/ms-playwright` (firefox-1522, webkit-2287),
  which match `playwright-core@1.60.0`: install that version in a scratch directory to use
  them. That WebKit build crashes when the emoji picker opens (also without any recent change).

### Server layout

`server/index.js` only assembles the app: CORS, `/api/config`, the routers, and the error handler.
Express 5 sends rejected async handlers to that handler, so routes don't need try/catch for
unexpected errors. The rest:
- `config.js`: loads `.env` (required first), checks it, message length limits.
- `db.js`: schema, plus promise helpers `db.get` / `db.all` / `db.run` (`run` resolves to
  `{ lastID, changes }`). Use these, not the callback API. The raw handle is `db.db`.
- `auth.js`: `generateToken`, `verifyToken`, the `authenticateJWT` middleware (attach it per
  route, not with `router.use`, since every router is mounted at `/api`).
- `sockets.js`: the `clients` map, `sendToUserSockets`, online status (`getStatus`, see Online
  status), `isViewingConversation`, and
  `attachWebSocketServer` (the ws server).
- `push.js`: web push sending and the DM push payload.
- `s3.js`: pre-signed upload URLs. Bucket setup at startup logs and carries on if the store is down.
- `guilds.js`: shared guild helpers (membership checks, `getGuildLayout`, `sendToGuild`).
- `voice.js`: voice channels (who's in which, LiveKit tokens and webhooks; see Voice channels).
- `calls.js`: DM and group DM calls (ringing, answering, hanging up; see DM calls).
- `groupDms.js`: group DMs (membership log checks, epochs, summaries; see Group DMs).
- `routes/`: `auth.js` (OPAQUE register/login, profile), `dms.js` (conversations, send, edit,
  delete, unread; `DM_SELECT` is the shared message query), `reactions.js`, `guilds.js` (guilds,
  members, invites, bans, categories, channels), `guildMessages.js` (channel messages, reactions,
  read state), `voice.js` (join token, mute/deafen, leave, LiveKit webhook), `calls.js` (DM
  calls), `groupDms.js` (group DMs), `push.js`
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
`VAPID_PRIVATE_KEY`, `S3_ENDPOINT`, `S3_ROOT_USER`, `S3_ROOT_PASSWORD`. Voice channels also need
`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (and `LIVEKIT_API_URL` to reach LiveKit
directly); without them voice is just off. `README.md` "Initial setup" has the whole list. VAPID keys are generated
via `webpush.generateVAPIDKeys()` (see root `README.md`). `S3_*` vars point at an S3-compatible
object store (e.g. MinIO) used for uploads and profile pics.

## Architecture

### Auth: password-authenticated key exchange (OPAQUE), not plain password auth

Login/registration use `@serenity-kit/opaque` (OPAQUE PAKE protocol) on both client and server —
the server never sees the plaintext password. The flow is split into two round trips per
operation:
- Register: `POST /api/initiateregister` → `POST /api/finaliseregister`
- Login: `POST /api/initiatelogin` → `POST /api/finaliselogin`
- Change password (logged in, Settings): `/initiatelogin` with the current password, `GET
  /api/key-backup`, `/initiateregister` for the new one, then `POST /api/change-password` with the
  login's `finishLoginRequest` + session key (proof of the current password, checked by
  `checkLoginProof`) and the new record and re-encrypted backup. Other devices stay logged in.
- Recovery code: see End-to-end encryption.

Server-side login state is stored transiently in the `login_states` table (5-minute expiry) keyed
by username, cleaned up on successful login (expired rows are purged on each login attempt).

Logged-out visitors must not be able to tell which usernames exist. `/api/initiatelogin` answers an
unknown username with OPAQUE's dummy response (`registrationRecord: null`), so it fails at the end
exactly like a wrong password. Logged-in users can see every user (intentional: the app is for groups
where everyone knows each other). The client must never send its `clientLoginState` to the server.

Password guessing can only happen online (through the server), so `routes/auth.js` rate limits
it (`rateLimit.js`, in memory): login starts per IP (30 / 15 min) and per username (20 / 15 min,
applied whether or not the account exists; cleared by a successful login), registrations per IP,
recovery attempts per IP and username.
Refusals are 429 with `Retry-After` and a message the login form shows. `req.ip` comes from
nginx's `X-Forwarded-For` (`trust proxy: 'loopback'`). test.voicaw.com goes through vite's proxy
to the public API, so its visitors all share one address there. The websocket `user_status`
broadcast only goes to identified sockets.

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
  to continue if the server publishes different ones. Changing the password re-encrypts it on the
  device (the current password is needed to open it; device keys are non-extractable).
- **Recovery code** (the only way back from a forgotten password; there's no email or admin
  reset): 25 random Crockford base32 characters (125 bits, `generateRecoveryCode`, shown as five
  groups; `normalizeRecoveryCode` accepts lower case, spaces, O/I/L). Made at registration and
  shown once (`RecoveryCodeDisplay`), or (re)made in Settings (`AccountSecuritySettings`, needs the
  password; `PUT /api/recovery-code` with a login proof; the old code stops working). HKDF from
  the code gives a key for a second backup (`users.recovery_backup`, `wrapRecoveryBackup`) and an
  auth value; the server stores only its SHA-256 (`recovery_verifier`). "Forgot password?" on the
  login page: `POST /api/recover/start {userIdentifier, recoveryAuth}` returns the recovery backup
  (unknown user, no code and wrong code all get the same 401), the client opens it, checks the
  published public keys, registers the new password and sends `POST /api/recover/finish` (auth
  again, new record + backup), which logs in. The code keeps working. Rate limited per IP and
  username. The code is generated on the device. `hasRecoveryCode` comes with login/profile.
  Logging in to an account without one (made before codes existed) shows a new code first and
  stores it (`saveRecoveryCode`, a second login proof with the password just typed) only once the
  user confirms they've kept it; closing the page stores nothing, so the next login asks again.
  Sessions restored without a login get `RecoveryPrompt` (dismissible banner in the DM view). Without a code, a forgotten password means the history
  is lost, by design.
- **On the device** (`keyStore.js`): non-extractable private `CryptoKey`s plus the user's *own*
  public keys (from the backup, never from the server) in IndexedDB. `clearUserKeys` runs on
  logout.
- **Contacts** (`contactKeys.js`, IndexedDB, per logged-in account): trust on first use. Never
  use a contact key straight from the server. `checkContactKeys` verifies the signature, pins the
  identity key, and returns `'changed'` (the conversation is blocked until the user accepts,
  `ContactKeyWarning`) or `'invalid'`. Users compare 60-digit safety numbers (`safetyNumber.js`,
  `SafetyNumberDialog`) and can mark contacts verified. That badge and dialog are
  hidden for now (`SHOW_SAFETY_NUMBERS` in `Dm.jsx`: too confusing for non-technical users); the
  pinning and the key-changed block still apply.
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
`user_status` and `presence_snapshot` (see Online status), and for guilds (see Guilds) `guild_add`, `guild_update`, `guild_remove`,
`guild_member_add`, `guild_member_remove`, `guild_message_new` / `_edit` / `_delete`,
`guild_reaction_add` / `_remove`, `guild_member_update` (roles), `guild_emojis_update`,
`guild_order` (your server rail order, to your other devices), `guild_voice_state` (someone
joined, left or (un)muted in a voice channel), for calls `call_incoming`, `call_update`,
`call_end`, and for group DMs `group_dm_add` / `_update` / `_remove` / `_epoch` /
`_message_new` / `_message_edit` / `_message_delete` / `_reaction_add` / `_reaction_remove`. A 30s heartbeat
(ping/pong) prunes dead connections.

Client side, `client/src/utils/ws-client.js` wraps this with `connectWebSocket`/`closeWebSocket`
and a pub/sub listener API (`onNewDm`, `onDeleteDm`, `onEditDm`, `onReactionAdd`, `onReactionRemove`, `onGuildEvent`,
`onCallEvent`, `onGroupEvent`), auto-reconnecting
every 3s on close. All non-realtime DM operations (fetch history, send, mark read) go through the
plain REST API in `client/src/services/dmService.js` / `client/src/utils/api.js` instead.

### Online status

Four states: `online` (active on a computer), `mobile` (active only on a phone or tablet),
`idle` (connected, nothing active) and `offline` (no sockets). The server works it out from all
of a user's sockets (`sockets.js` `statusOf`): any active computer wins, then any active phone.
- Each socket's `presence` message (sent before `identify`, on focus/visibility/chat changes and
  every 15s) carries `mobile` (the device, `isMobileDevice()` in `utils/presence.js`, not the
  chosen layout) and `idleIn`: ms until that device counts as idle (10 min after its last input
  in the app: pointer, keys, wheel, focus; a phone's is 0 as soon as the app is hidden). The server
  turns that into `activeUntil` (capped at 10 min); a 15s sweep catches it passing. Input after
  going idle sends presence at once.
- Only changes are broadcast (`user_status { userId, status }`, to every logged-in socket).
  Losing the last socket starts a 15s grace period before `offline`, so reloads, blips and API
  restarts don't flicker. Going offline saves `users.last_online` (unix s) and puts it in the
  event (`lastOnline`); it's also saved for everyone online once a minute, so a crash loses at
  most that. NULL means never seen since this was added.
- Each identify gets `presence_snapshot { statuses: { id: status } }` (everyone not offline), so a
  device that was disconnected catches up. `/dms-list` and guild members also carry `status` and
  `last_online`.
- Client: `utils/presence.js` is the store (snapshot + changes; before the first snapshot, a
  user's own `status` from the API), `hooks/usePresence.js` returns `presenceOf(user)` →
  `{ status, lastOnline }`. `StatusIcon` draws it (dot; a phone for `mobile`; a moon for idle in
  the member list). The DM header and the member card show the status or "Last seen …". Idle and
  mobile members count as online in the member list.

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
in `db.js` (no ORM: a new column on an existing table needs an `ALTER TABLE ... ADD COLUMN`
whose "duplicate column" error is ignored, as `guilds` does). Changes to existing data that must
run exactly once are numbered with SQLite's `PRAGMA user_version` at the end of the guild block
(1: @everyone gets Connect and Speak; 2: clear `users.last_online`, which had only ever held the
sign-up time); add the next one as 3. Guild
tables are `guilds` plus `guild_*`. An earlier sketch left unused, empty tables in old databases
(`roles`, `user_roles`, `categories`, `channels`, `channel_permissions`, `messages`); nothing
creates or reads them any more, and they can be dropped.

### Guilds

Discord-style servers. **Not end-to-end encrypted**, on purpose: the server reads guild
messages, so it can do mentions, search and moderation. Encryption stays for DMs and (planned)
group DMs. Anyone can create a guild; its creator is the owner (`guilds.owner`).
- **Permissions** (`server/permissions.js`, copied in `client/src/utils/permissions.js`; a
  test checks they match) are Discord's model with a bit field: View Channel, Send Messages,
  Add Reactions, Manage Messages, Manage Channels, Manage Roles, Manage Server, Create Invite,
  Kick, Ban, Administrator, Manage Emoji, Connect, Speak (voice). Every guild has an `@everyone`
  role (`is_everyone`, position 0, default: view, send, react, invite, connect, speak) plus orderable roles (`guild_roles`: name, colour
  0xRRGGBB or null, `hoist` = shown separately in the member list, position: higher ranks
  higher), given out in `guild_member_roles`. Guild permissions are @everyone's plus the
  member's roles'; the owner and Administrator get everything.
- **Channel overrides** (`guild_channel_overrides`, per role or member, `allow`/`deny` of the
  channel permissions: View, Send, React, Manage Messages, Connect, Speak; the editor shows a
  text channel's or a voice channel's) apply in order: @everyone's, the member's roles' (all denies, then
  all allows), the member's own. A **private channel** is @everyone denied View Channel. A
  channel you can't view doesn't exist for you: left out of your layout, 404, no events
  (`sendToChannel`), not in unread counts.
- **Hierarchy:** you only manage roles, and kick, ban or change the roles of members, below
  your own highest role (the owner is above all; `outranks`), only reorder roles below yours,
  and never give a permission (to a role or an override) you don't have yourself.
- `server/guilds.js` has the member context (`getMember`: roles, `permissions`, `highest`),
  `getChannelAccess`, the per-member layout and the send helpers; `routes/guildRoles.js` the
  role, member-role and override routes. Guilds from before roles get their @everyone on start.
- Non-members get 404 for a guild, its channels and messages (it doesn't reveal what exists).
- A new guild gets a "Text Channels" category with `#general`. Channel names are normalised
  Discord style (lower case, spaces to `-`). Channels with no category sit above the
  categories; deleting a category keeps its channels, uncategorised. `PUT /guilds/:id/layout`
  sets the whole order at once (every category id, every channel `{id, categoryId}`).
- `GET /guilds/:id` (and the `guild_update` event, sent to every member on any change) is the
  layout as that member sees it: guild, `my_permissions`, `my_role_ids`, every role (highest
  first), and the `categories` and `channels` they can see, in order, each channel with its
  `my_permissions` and `private`.
- Invites: 8-character codes, optional expiry (`maxAge` s, up to 30 days) and `maxUses`,
  claimed atomically. Joining marks existing history read. Bans remove and block rejoining.
  The owner has to transfer ownership before leaving.
- Messages have the DM row shape (`sender_*`, `parent_*`, `reactions`, `edited`) so
  `MessageList` can show both; content is plain text up to `maxPlaintextLength` characters.
  Authors edit; authors or Manage Messages delete. Reactions are plain emoji, one of each per
  person.
- Unread: `guild_channel_reads` holds each member's last read message per channel;
  `GET /guild-unread` counts newer messages by others. Sending marks your own channel read.
- Icons: `GET /upload_guild_icon` (Manage Server, image, 8MB) signs `guild-icons/<guild id>`; then
  `PATCH /guilds/:id {iconUploaded: true}` bumps `icon_version` (use it as `?v=` to bust caches).
- **Client:** routes `/guild/:guildId/:channelId?` (`guild/GuildView.jsx`; without a channel it
  opens the last one viewed there, `localStorage guildChannel:<id>`, or the first text one) and
  `/invite/:code` (`guild/InvitePage.jsx`; logged out, that URL shows the login form, then the
  invite). `hooks/useGuildList.js` (in `Layout`, exposed as `LayoutContext.guildList`) holds the
  guild list, the layouts opened so far, and unread counts, kept current by `onGuildEvent`
  (`ws-client`, every `guild_*` event). `Sidebar` is the server rail (guild icons with unread
  pills, `+` → `AddGuildDialog`: create or join). `guild/GuildSidebar.jsx` is the channel column
  (header menu: invite, settings, create channel/category, leave; collapsible categories,
  remembered in `localStorage collapsedCategories`; edit buttons for Manage Channels; what's
  offered follows `my_permissions`). Private channels show a lock (`guild/ChannelIcon.jsx`).
  `hooks/useChannel.js` is `useConversation` for a channel (plain text, same shape), and both
  DMs and channels render through `ChatPane.jsx` (message list, composer, reactions, action
  sheet; `useReactions` takes `saveReaction`/`deleteReaction`, so DMs encrypt and guilds
  don't). Names take the colour of the member's highest coloured role (`memberColor`; none:
  the normal colour), in chat (`nameColors`) and the member list. A channel without Send
  Messages shows a notice instead of the composer. `guild/MemberList.jsx`: grouped under
  hoisted roles, then Online, Offline; click for a card with roles (add/remove below your
  rank), Message / Make owner / Kick / Ban (a panel over the chat on mobile). Server Settings
  (`GuildSettingsDialog`) has tabs by permission: Overview, Roles (`RolesSettings`: drag or
  arrows to reorder, colour swatches, permissions), Emoji (`EmojiSettings`), Invites, Bans. A channel's settings have a
  Permissions tab (`ChannelPermissions`: private toggle, ✕ / / ✓ per role or member). Dialogs use `guild/Modal.jsx`; styles are
  `assets/css/guilds.css`. Attachments in channels still go through the encrypted upload (the
  key is in the plain message, so anyone in the channel can open them); plain uploads can come later.
- **Server rail order** is per member (`guild_members.position`; `PUT /guilds-order` with every
  guild id, top first; new guilds go at the bottom). `GET /guilds` and `GET /emojis` follow it.
  In the rail, servers are dragged into order (`hooks/useDragReorder.js`: a mouse drag after a
  few pixels, a touch drag after holding still, so swiping still scrolls).
- **Custom emoji** (`routes/guildEmojis.js`, `guild_emojis`): per guild, plain images (not
  encrypted) in the public `emojis` bucket at `emojis/<id>`, written `<:name:id>` in messages
  (DMs too, inside the encryption). Rendering only needs the id (`emoji/customEmoji.js`
  `customEmojiUrl`), so it never waits for a list; a deleted one's image is removed and it shows
  as `:name:`. Adding is two steps: `POST /guilds/:id/emojis {name, type, size}` makes an
  unavailable row and returns a signed URL for the original (`emojis/src/<id>`, up to 10 MB);
  after the upload, `POST .../ready` has the server shrink it (`server/emojiImage.js`, `sharp`:
  at most 128×128, never enlarged, WebP; animated GIF/WebP stay animated; limits on pixels and
  frames so a small file can't decode into something huge), store it as `emojis/<id>`, delete
  the original and send `guild_emojis_update`. Not an image: the emoji is dropped (400).
  Unfinished uploads (and their originals) are cleared after an hour. Limits: 200 per guild,
  PNG/GIF/WebP/JPEG/AVIF, names 2–32 of `[A-Za-z0-9_]`, unique per guild. Manage Emoji (`MANAGE_EMOJIS`) adds, renames and deletes; members of a guild can use
  its emoji anywhere. The client keeps them in `useGuildList` (`emojis`), and `Layout` provides
  `CustomEmojiContext` (`emoji/customEmojiContext.js`: by guild in rail order, and by id).
- **Not done yet:** drag-and-drop reordering of channels (the API exists; roles and servers can
  be dragged), category-level permissions (overrides are per channel), mentions and guild
  notifications (no push for guild messages yet), server folders in the rail. Voice: see
  Voice channels.

### Voice channels (LiveKit)

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
  and a voice channel in the layout has `voice: [{ user_id, username, self_mute, self_deaf }]`.
  Without `LIVEKIT_*` settings voice is off: `/api/config` says `voiceEnabled: false`, joins 503.
- **Client** (`voice/voiceClient.js`, read with `hooks/useVoice.js`): one connection per
  device, a module-level store like `ws-client`. `livekit-client` is loaded on the first join
  (it's big). Joining must come from a click (browsers play sound only after one). Muted, the
  mic is released (`stopMicTrackOnMute`, the browser's recording light goes off); deafened, the
  `<audio>` elements are muted and you're muted too; unmuting undeafens (Discord's rules). Mute
  and deafen are remembered per device (`localStorage voicePrefs`) and work outside a call.
  `speaking` is LiveKit's active speakers. A lost connection, being removed, or joining the same
  channel elsewhere ends it with a message in the voice bar.
- **Microphone chain** (`voice/voiceChain.js`): the browser captures with echo cancellation,
  noise suppression, auto gain and `voiceIsolation` (Chrome's stronger suppression, where it has
  it); then our own LiveKit audio processor runs the mic through a list of Web Audio stages
  (none yet: it passes through). **Voice isolation goes in here** as a stage (RNNoise, then
  DeepFilterNet, each an AudioWorklet). The processor is set on the track after the mic is on
  (LiveKit applies capture-time processors before the track has its AudioContext), and it
  keeps the AudioContext from `init`, because LiveKit calls `restart` (after an unmute or a mic
  change) without one.
- **UI:** in the channel list, people in a voice channel are listed under it (ringed while
  talking, when you're in there too). Clicking a voice channel joins it on desktop; on mobile a
  tap only opens it and you join from its page (`guild/VoiceChannelView.jsx`: tiles, Join Voice,
  mute/deafen/disconnect). `voice/VoiceBar.jsx` sits above the user panel while connected
  (status, channel link, disconnect, errors); `UserPanel` has mute and deafen
  (`voice/VoiceControls.jsx`). A guild reopens on its last *text* channel.
- **Not done yet:** device selection, per-user volume, push-to-talk and voice activity
  settings, server mute/move (Mute Members, Move Members), the Electron global push-to-talk key,
  voice isolation stages, screen share, and a TURN server for networks that block UDP 7882 and
  TCP 7881. Phones: a PWA's audio stops when it's in the background (iOS also when locked).

### DM calls

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
  Web Audio (`voice/ringtone.js`). Reloading or leaving the page leaves the call.
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
- **Not done yet:** calls in the chat history (missed/ended entries), video, and the incoming
  call screen of a native app (a closed PWA only gets the notification).

### Group DMs

End-to-end encrypted chats of up to 10 people (`MAX_MEMBERS`), with calls (see DM calls). Anyone
in a group adds people; only the owner (the creator) removes them; anyone leaves; an owner who
leaves leaves the group without an owner (nobody can remove anyone then); the last one out
deletes it. The group name isn't encrypted (like guild names); messages, reactions, edits and
call keys are.
- **Membership log** (`group_dm_log`): every change is a record (`makeRecord`: `{ v, group, seq,
  prev, type, actor, target, targetIdentityKey, at }`, JSON in a fixed order) that its author
  signs with their identity key (`voicaw/group-log/v1`); `prev` is the previous entry's hash, so
  it's a chain. Types: `create` (seq 0, the creator's own identity key), `add` (the added
  person's identity key), `remove` (owner only), `leave` (yourself). Group ids are UUIDs made by
  the creator. The server checks every record like a client would (sequence, chain, rules,
  identity key = the user's, signature) before storing it; clients check the whole log again
  (`verifyGroupLog` in `services/groupCrypto.js`), and each current member's log identity key
  against the key this device pinned for them (`checkContactKeys`, as for DMs). A mismatch
  blocks sending in the group (a changed key can be accepted, like in a DM; a key that doesn't
  match the log needs the person removed and re-added).
- **Epochs** (`group_dm_epochs`, `group_dm_epoch_keys`): a key period, for the members after log
  entry `log_seq`. Its key is 32 random bytes, wrapped for each member (`wrapGroupKey`: ECDH
  between the creator's and the member's encryption keys, HKDF `voicaw/group-key-wrap/v1`,
  bound to group, epoch, `log_seq`, creator and member). Clients only wrap for members from the
  checked log, with the encryption key their log identity key signed, and only open epochs whose
  creator was a member at `log_seq`. A new epoch is needed after every membership change; the
  person adding or removing makes it with the change, otherwise (after a leave) the next member
  to send one does (`currentEpoch` in `services/groupKeys.js`). The server only takes a message
  for the newest epoch when that's for the current membership (else 409 `stale_epoch`), and only
  one epoch per number (the loser of a race gets 409 and uses the winner's).
- **Who reads what:** the server only returns messages (and reply previews) of epochs you have a
  key for, and unread counts only count those. So someone added never sees what was said before
  (they never get those keys), someone removed never gets new keys, and someone re-added keeps
  their old keys: they see the times they were a member, not the gap (decided 2026-09-30;
  "fresh start on rejoin" would be deleting their old `group_dm_epoch_keys` rows on re-add).
- **Messages** (`group_dm_messages`, `_reactions`, `_reads`): like DMs, encrypted with the
  epoch key, additional data `groupMessageContext(groupId, epoch, senderId)` (reactions:
  `groupReactionContext(groupId, messageId, reactorId)`, padded like DM reactions); edits keep
  the message's epoch. Messages aren't signed: within a group, who sent a message rests on the
  server's login (a member working with the server could forge one; signing them is a possible
  next step). Pushes say "New message from <name>" (no preview: the service worker has no epoch
  keys).
- **API** (`routes/groupDms.js`): `GET/POST /group-dms`, `GET /group-dms/:id` (summary, the
  whole log, everyone's public keys, your epoch keys, `latest_epoch`, the group's `call`),
  `PATCH` (rename), `POST /:id/log { entry, epoch? }`, `POST /:id/epochs`, `GET/POST
  /:id/messages`, `PUT/DELETE /group-dm-messages/:id` (author), `POST
  /group-dm-messages/:id/reactions`, `DELETE /group-dm-reactions/:id`, `POST /:id/read`.
  Non-members get 404 for everything.
- **Client:** route `/dm/g/:groupId` (`group/GroupDm.jsx`: header with call and members
  buttons, `GroupCallPanel`, key warnings, `ChatPane`, `GroupMembers`: add people, remove
  (owner), rename, leave). `hooks/useGroupConversation.js` is `useConversation` for a group
  (decrypting with each message's epoch key; membership changes as `system` rows in the
  timeline, which `MessageList` draws as centred lines, from the time you joined).
  `hooks/useGroupList.js` (in `Layout`, `LayoutContext.groupList`) feeds `DmSidebar`, which
  mixes groups in with people by latest message and has the "New group" button
  (`group/NewGroupDialog.jsx`).


### File uploads (S3-compatible object store)

`server/s3.js` wraps `@aws-sdk/client-s3` against `S3_ENDPOINT` (`forcePathStyle: true`, so this
targets a self-hosted/MinIO-style endpoint, not raw AWS). It auto-creates and makes public four
buckets on startup: `uploads`, `profile-pics`, `guild-icons`, `emojis`. Uploads are client-direct: the server only
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

Clicking an image opens `ImageViewer` (full screen, from `ImageViewerProvider` in `App.jsx`
via `ImageViewerContext`, portalled to `<body>` so its touches don't reach the message's long
press). It shows the already-decrypted blob URL: zoom by wheel, pinch, double click/tap,
buttons or `+ - 0` keys (geometry in `utils/imageZoom.js`), drag to pan, save and open in a new
tab (`utils/saveFile.js`). It steps through the other images in the same message (arrows,
← → keys, swiping an unzoomed image, a thumbnail strip): each image registers itself on its
element (`utils/imageGallery.js` `galleryItemRef`, including ones still decrypting), and
`MessageList` marks the message content `data-image-gallery`; opening collects them in reading
order. Its keys are caught at the window's capture phase, so Escape doesn't
also cancel a reply. Opening it pushes a history entry (keeping the router's state), so the
back button closes it.

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
  draft attachments are chips (so are a sent message's attachments while editing it, kept as
  their exact `![name](url)`, so the link and its key never show), custom emoji `<:name:id>` are inline images. Unicode emoji stay text, drawn by the Twemoji font, so
  typing, autocorrect, IME and copy/paste stay plain. Pasting is always plain text (files go to
  attachments); edits past the length limit are refused. Saving an edit left empty or
  only whitespace cancels it (`ChatPane`). Enter sends on desktop, Shift+Enter is a
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
- Custom (guild) emoji (see Guilds): the picker shows each of your servers' emoji after Frequently
  Used and before the standard categories, in your rail order, with the server's icon in the
  category bar; search, `:name` suggestions and a typed `:name:` include them (standard
  shortcodes win a name clash). Picking gives `<:name:id>` (Frequently Used keeps them as
  `custom:<id>`). `rehypeTwemoji` renders them in messages (`data-custom-emoji`, which
  `MarkdownImage` turns into `CustomEmojiImage`), reactions show them too (a reaction's 64
  padded bytes fit one), and plain-text places (reply previews, copying, notifications) show
  `:name:` (`customEmojiToText`). Emoji-only messages count them.
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

## Decisions, plans and known issues

- **Group DMs** (built 2026-09-30, see Group DMs): removed members don't read new messages and
  new members don't read old ones: per-group epoch keys, renewed after every membership change,
  each member getting a copy wrapped for them (ECDH + HKDF; WebCrypto has no HPKE); membership
  changes signed with identity keys. Re-added members see the times they were in, not the gap.
  Group messages aren't signed yet. Don't change identity keys or the safety-number derivation
  casually: every contact would get a "key changed" warning. The server delivering the web app's code stays the
  unfixable gap until native apps.
- **Guilds aren't encrypted** (decided 2026-09-29): encrypted channels inside guilds were
  considered and dropped (who may add members to one, when roles are server-controlled, had no
  good answer). Encryption is for DMs and group DMs.
- **Voice** (decided 2026-09-29): a self-hosted LiveKit SFU (setup in `README.md`), not
  peer-to-peer mesh, so channels scale past a handful of people. The API only checks permissions
  and hands out short-lived LiveKit tokens. Guild voice isn't end-to-end encrypted (like guild
  text). DM calls are (LiveKit's E2EE with a per-call key sent inside the DM encryption). Build the microphone
  path as a Web Audio chain (capture with echo cancellation → processing slot → gain/voice
  activity → published track), so voice isolation (RNNoise, then DeepFilterNet, in an
  AudioWorklet) drops into the slot later. Krisp needs LiveKit Cloud or a licence, so it's out.
- **Custom emoji** are per guild and unencrypted (like profile pictures). As in Discord, a guild's
  members can use them anywhere, DMs included; unlike Discord, no paid tier is needed for that.
- **Everyone sees everyone** once logged in (the app is for groups who know each other); only
  logged-out visitors must not learn usernames.
- **Known issues:**
  - Keycap emoji (1️⃣) and Unicode 15.1+ emoji (🙂‍↔️) show in the system font while typing
    (digits are kept out of the Twemoji font; 15.1 isn't in Twemoji 15).
  - The Playwright WebKit build crashes opening the emoji picker (see Browser checks); not yet
    checked on a real iPhone.
  - nginx doesn't compress JS/CSS/SVG (`gzip_types` is commented out in
    `/etc/nginx/nginx.conf`); first visits download the 1.6 MB main bundle uncompressed.
  - npm 11 warns about `build_from_source` in `.npmrc` (see Server environment), and that the
    install scripts of `sqlite3` and `esbuild` aren't in an `allowScripts` list yet. They still
    run today; a future npm will need them approved (`npm install-scripts approve`).
