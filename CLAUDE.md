# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Voicaw is a Discord-style chat web app: end-to-end encrypted direct messages and group DMs
(with calls), and guilds
(Discord-style servers, always called guilds in the app: text, voice and list (task board)
channels, roles and private channels; not encrypted, see Guilds). It's an npm workspaces monorepo with
three packages: `client` (React/Vite SPA, also packaged as an Electron desktop app), `server`
(Express + ws API), and `electron` (the desktop app: the built client plus notifications, tray,
shortcuts and updates; see Desktop app).

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
  cd ~/git/voicaw-<feature> && npm install
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
- `npm run dist:electron` — the same build, then installers in `dist-desktop/` (electron-builder)

Client-only (run inside `client/`):
- `npm run lint` — ESLint over `client/src`
- `npm run build:electron` — Vite build with `ELECTRON=true` (outputs to `../build`, served by
  `electron/protocol.js`; uses `.env.production` unless there's a `.env.electron`)

### Tests (Vitest)

- `npm test` (root) — runs server tests, then client tests, then the desktop app's
- `npm test` inside `server/`, `client/` or `electron/` — run one package's suite
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
node e2e/auditlog.mjs [dir] # audit log: mod deletes a message, role change, details, filters, no access, phone
node e2e/emoji.mjs [dir]  # custom emoji (upload, picker, :name:, reactions, DM), rail order
node e2e/voice.mjs [dir]  # voice: join, hear, speaking ring, mute/deafen, phone, leave
node e2e/screenshare.mjs [dir] # screen share: own preview, Live, no download until Watch, phone watches, Video taken away
node e2e/calls.mjs [dir]  # DM calls: ring, answer, encrypted (asks LiveKit), mute, decline, phone
node e2e/groups.mjs [dir] # group DMs: create, add (no old messages), remove, group call, owner leaves
node e2e/presence.mjs [dir] # online status: idle, mobile, no flicker on reload, last seen
node e2e/notes.mjs [dir]  # notes: row under the header, send, pin, reload, not leaked to/from DMs, phone login
node e2e/recovery.mjs [dir] # change password, recovery code reset, new code, code on old login
node e2e/spoilers.mjs [dir] # spoiler images: mark in tray, blurred for both, tap/click reveals, reply preview
node e2e/mentions.mjs [dir] # @ suggestions, highlight, badges, @everyone, roles, private channel, notify level
node e2e/channel-mentions.mjs [dir] # # suggestions, #channel links (click opens), private = unknown, edit, DM, phone
node e2e/pins.mjs [dir]   # pins: DM (list, jump into unloaded history), guild permission, group, phone
node e2e/invites.mjs [dir] # invite embeds: channel (loads), DM (only after Show), Join Guild, phone
node e2e/webhooks.mjs [dir] # webhook made in the UI, posted to like Discord (embed, files), edit/delete, phone
node e2e/search.mjs [dir] # guild search: from:/in:/has:/mentions: suggestions, results, Jump into another channel, private channel, phone
node e2e/days.mjs [dir]   # day dividers between days and above the first message (desktop + phone)
node e2e/panes.mjs [dir]  # phone: swipe list <-> chat (flick, slow drag, vertical scroll), back button, guild
node e2e/account.mjs [dir] # delete account: owned guild blocks until ticked, logged out, "Deleted User" for contacts, phone
node e2e/desktop.mjs [dir] # desktop app page side (stand-in bridge): notifications, badge, shortcuts, settings
node e2e/lists.mjs [dir]  # list channels: add, subtask, drag to nest/reorder, assign, due date, comments, read-only, phone
node e2e/polls.mjs [dir]  # polls: + menu, emoji, Vote (phone), results, who voted, edits, duration, end early + result rows (DM, guild, group)
node e2e/embedperf.mjs [n] [dir] # speed: channel of n webhook embeds with big posters; open/hover/scroll timings, CPU profile with PROFILE=<prefix>
node e2e/sounds.mjs [dir] # sounds: Settings → Sounds, play buttons, mute/deafen, Message in another chat (not the open one, not when off), phone
node e2e/themes.mjs [dir] # light/dark: Settings → Appearance, at once, kept per device, no dark flash, Match system, color-scheme (keyboard), phone
KLIPY_API_KEY=… node e2e/gifs.mjs [dir] # admin sets the Klipy key, GIFs tab, search, favourites, send (real Klipy)
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
shell). In the throwaway API, anyone whose name starts with `admin` is a global admin
(`signUp(browser, 'admin')`). `e2e/helpers.mjs` has `signUp` (registers a user in its own browser context, unique
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
  `{ lastID, changes }`) and `db.transaction` (see Database). The raw `node:sqlite` handle is
  `db.db`.
- `auth.js`: `generateToken`, `verifyToken`, the `authenticateJWT` middleware (attach it per
  route, not with `router.use`, since every router is mounted at `/api`).
- `sockets.js`: the `clients` map, `sendToUserSockets`, online status (`getStatus`, see Online
  status), `isViewingConversation`, and
  `attachWebSocketServer` (the ws server).
- `push.js`: web push sending and the DM push payload.
- `s3.js`: pre-signed upload URLs. Bucket setup at startup logs and carries on if the store is down.
- `guilds.js`: shared guild helpers (membership checks, `getGuildLayout`, `sendToGuild`).
- `guildTasks.js`: list channels' tasks (tree helpers, limits, the assignment notification; see
  List channels); `routes/guildTasks.js` has their routes.
- `auditLog.js`: a guild's audit log (`logAudit`, `readAuditLog`; see Guilds); `routes/auditLog.js`.
- `voice.js`: voice channels (who's in which, LiveKit tokens and webhooks; see Voice channels).
- `calls.js`: DM and group DM calls (ringing, answering, hanging up; see DM calls).
- `groupDms.js`: group DMs (membership log checks, epochs, summaries; see Group DMs).
- `appSettings.js`: app-wide settings a global admin edits (see Admin settings).
- `pins.js`: pinning and unpinning a message, the same for every kind of chat (see Pinned messages).
- `polls.js`: reading guild polls, when they close, and what an edit may change (see Polls).
- `accounts.js`: deleting an account (see Deleting an account).
- `usernames.js`: usernames ignore capitals (`findUserByName`, `opaque_id`; see Auth).
- `pollTimers.js`: when every poll closes and its "poll ended" row (see Polls); `routes/polls.js`.
- `profiles.js`: display name, custom status and bio (limits, cleaning, `displayNameOf`; see Profiles).
- `avatars.js` + `avatarImage.js`: profile pictures (processing, storage, the one-off migration;
  see Profiles). `routes/avatars.js` has their routes.
- `routes/`: `auth.js` (OPAQUE register/login, profile), `dms.js` (conversations, send, edit,
  delete, unread; `DM_SELECT` is the shared message query), `reactions.js`, `guilds.js` (guilds,
  members, invites, bans, categories, channels), `guildMessages.js` (channel messages, reactions,
  read state), `guildSearch.js` (guild search; see Guild search), `voice.js` (join token, mute/deafen, leave, LiveKit webhook), `calls.js` (DM
  calls), `groupDms.js` (group DMs), `webhooks.js` (Discord-compatible webhooks), `push.js`
  (subscriptions), `uploads.js`, `gifs.js` (Klipy search proxy, GIF favourites), `admin.js`.

Client tests sit next to their source files (`src/**/*.test.{js,jsx}`). The default environment is
`node`; component tests opt into DOM with a `// @vitest-environment jsdom` header on the first
line. `vitest.config.js` pins `VITE_API_BASE_URL`/`VITE_WS_URL`, and `src/test/setupTests.js`
stubs `ResizeObserver` (used by `MessageList`) and the Range measuring ProseMirror does. The message
box is an editor (contenteditable), which jsdom can't type into: tests drive it through its handle,
`editorFor(element)` from `editor/editorRegistry.js` (`insertText`, `setText`, `getText`...).
Component tests mock `../utils/api`,
`../utils/ws-client`, and `../services/dmService` with `vi.mock`.

### Server environment

The host runs Node 24 LTS (NodeSource apt package, shared by every pm2 app on it). The
database is Node's built-in `node:sqlite`, so there's no native module to build.

`server/config.js` fails fast at startup if any of these env vars are missing (set them in
`server/.env`): `JWT_SECRET`, `OPAQUE_SERVER_SETUP`, `VAPID_EMAIL`, `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, `S3_ENDPOINT`, `S3_ROOT_USER`, `S3_ROOT_PASSWORD`. Voice channels also need
`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (and `LIVEKIT_API_URL` to reach LiveKit
directly); without them voice is just off. `KLIPY_API_KEY` turns on GIFs (also settable in
Settings → Admin, see Admin settings). `README.md` "Initial setup" has the whole list. VAPID keys are generated
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

**Usernames are lower case** and ignore capitals everywhere (login, recovery, making an admin;
`server/usernames.js` `findUserByName`). Signing up as "Alice" makes the username `alice` with
"Alice" as the display name. OPAQUE binds a record to the name it was registered under (the
server derives each account's OPRF key from it), so migration 5, which lower-cased existing
accounts (copying the old spelling into an empty display name), keeps that spelling in
`users.opaque_id` for `startLogin`; `/initiateregister` always uses the lower-case name, so a
password change or recovery clears it. An old account whose lower-case name was already taken
kept its capitals (an exact match wins at login).

Server-side login state is stored transiently in the `login_states` table (5-minute expiry) keyed
by (lower-case) username, cleaned up on successful login (expired rows are purged on each login attempt).

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

On successful login/register, the server issues a JWT (`generateToken`, see `server/auth.js`)
which the client stores in `localStorage` and sends as `Authorization: Bearer <token>` (see
`client/src/utils/api.js`). `authenticateJWT` middleware protects all `/api/*` routes except
config/login/register.
- **Sessions last while the app is used:** a token is good for 30 days (`SESSION_SECONDS`), and
  any authenticated request with one older than a day (`RENEW_AFTER_SECONDS`) gets a new one in
  the `X-Voicaw-Token` response header (exposed by CORS). `api.js` stores it, only if it renews
  the token that request was sent with (not after a logout or another login). So only a device
  unused for 30 days has to log in again. Tokens can't be revoked (logout just forgets it on
  the device); a server-side sessions table would be the way to add that.
- On start, `AuthProvider` only drops the session when `/profile` answers 401/403/404. With no
  answer or a server error (no network yet after boot, an API restart) it keeps the token and
  asks again every 3 s, while `App` shows "Can't reach Voicaw. Trying again…".

### Deleting an account

Settings → Delete account (`DeleteAccountSettings.jsx`, `authService` `deleteAccount`), like
Discord's: the person goes, what they wrote stays under "Deleted User".
- **Server** (`server/accounts.js`, `DELETE /api/account` in `routes/auth.js`, with a login
  proof of the password like change-password): `checkDeletion` checks everything first, so a
  refusal doesn't use up the proof. Guilds you own block it (409 `code: 'owns_guilds'` with
  `guilds`; `GET /account/owned-guilds`) unless `deleteOwnedGuilds: true`, which deletes them
  (`guilds.js` `deleteGuild`). Group DMs: only you can sign leaving, so the client signs a
  `leave` entry for every group (`groupKeys.js` `leaveEntry`) and sends `groupLeaves: { groupId:
  entry }`; each is checked with `checkEntry` (missing or stale: 409 `groups_changed`, the client
  signs again). Then: calls and voice ended, the leaves stored (a group left empty is deleted),
  notes deleted (with their reactions and poll timers), unread counts, push subscriptions, GIF
  favourites and mentions of them deleted, every other guild left (`removeMember`), the picture
  removed, `user_profile` to everyone, `account_deleted` to their sockets, which are closed.
- **The `users` row stays as a tombstone** (messages, reactions and group logs point at it):
  `deleted_at` set, username `Deleted-User-<id>` (sign-ups are lower case, so nobody can take
  it, and the old name is free), display name "Deleted User", password, key backups, recovery
  code, profile and admin cleared. The public keys stay, so contacts can still open the DMs
  they had. `verifyToken` refuses deleted accounts (every request and socket identify looks
  them up), `findUserByName` skips them, `/dm-send` and calls to them are 404, and a group can't
  add them. `/dms-list` only lists them to people who had a conversation with them, with
  `deleted_at`; the client's profile store keeps it (`isDeleted`), so their DM is read-only (no
  composer, no call button) and the group pickers leave them out.
- Guild messages, DMs and group messages they sent, and their reactions, are kept (the server
  can't delete what others' devices already decrypted anyway).

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
- **Notes** (`/dm/notes`, `Notes.jsx`): a DM to yourself (`direct_messages` with sender =
  recipient), first under the Direct Messages header in `DmSidebar`, with a line between it and
  the conversations, not scrolling with them (you aren't in `/dms-list`). The
  key is `deriveNotesKey`: ECDH of your own private and public encryption keys, HKDF with
  `voicaw/notes-key/v1` (so it's never a DM key), with your public key from `keyStore`, never
  the server. `useConversation({ notes: true })` skips the contact key check and marking
  read; the server never counts notes unread or pushes them, and sends each event once.
  Replies, edits, reactions, attachments and pins work as in any DM.

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
`dm_pin` (see Pinned messages),
`user_status` and `presence_snapshot` (see Online status), `user_profile` (someone changed their
profile, to every logged-in socket; see Profiles), `account_deleted` (to your own sockets: log
out; see Deleting an account), `message_sound` (play the Message sound; see Sounds), and for guilds (see Guilds) `guild_add`, `guild_update`, `guild_remove`,
`guild_member_add`, `guild_member_remove`, `guild_message_new` / `_edit` / `_delete` / `_pin` (a
webhook's edit also carries `embeds`, `attachments`, `flags`),
`guild_reaction_add` / `_remove`, `guild_member_update` (roles), `guild_emojis_update`,
`guild_order` (your guild rail order, to your other devices), `guild_voice_state` (someone
joined, left or (un)muted in a voice channel), `guild_mention` (only to whoever a new message
mentions, for their red counts), `guild_task_upsert` / `_delete` / `guild_tasks_move` /
`guild_task_comment_new` / `_edit` / `_delete` (to whoever can see the list channel) and
`guild_task_assigned` (only to whoever was just assigned; see List channels), for calls `call_incoming`, `call_update`,
`call_end`, and for group DMs `group_dm_add` / `_update` / `_remove` / `_epoch` /
`_message_new` / `_message_edit` / `_message_delete` / `_message_pin` / `_reaction_add` / `_reaction_remove`. A 30s heartbeat
(ping/pong) prunes dead connections.

Client side, `client/src/utils/ws-client.js` wraps this with `connectWebSocket`/`closeWebSocket`
and a pub/sub listener API (`onNewDm`, `onDeleteDm`, `onEditDm`, `onReactionAdd`, `onReactionRemove`, `onDmPin`, `onGuildEvent`,
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
  device that was disconnected catches up. `/dms-list`, guild members and a group DM's `users`
  also carry `status` and `last_online`.
- Client: `utils/presence.js` is the store (snapshot + changes; before the first snapshot, a
  user's own `status` from the API), `hooks/usePresence.js` returns `presenceOf(user)` →
  `{ status, lastOnline }`. `StatusIcon` draws it the same everywhere (DM list, member lists, group members, profile card) (STATUS ICONS in
  `voicaw.css`): on the bottom right corner of the picture, a diamond coloured by status, a phone
  for `mobile`. Picture and icon go in a `.status-avatar`, which cuts the icon's shape (plus a
  gap) out of the picture with a CSS mask, so it works on any background; sizes are CSS
  variables per place. The DM header shows only "Last seen …" (when offline; the icon says the rest);
  the profile card shows the status or "Last seen …". Idle and mobile members count as online in
  the member list.

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
  `isViewingConversation()` says the recipient is looking at that chat (group DMs: chat id
  `group-<id>`; guild channels: `channel-<id>`, and which guild messages push is in Mentions). That uses `presence`
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
- The desktop app has no web push: `sendPushToUser` also sends the payload to the user's sockets
  whose presence says `desktopNotifications` (the app, notifications on) as `notification
  { payload }`, so the same checks apply (viewing, levels, previews). See Desktop app.
- Message pushes (`dm`, `group`, `guild`) also send `message_sound` to every socket of the user
  (see Sounds). While a window of the app is focused, the service worker shows those
  notifications `silent` (the page plays the Message sound instead).
- The PWA manifest is `public/manifest.json` only (VitePWA `manifest: false`). The dev server also
  serves the real service worker (`devOptions`), so push works on test.voicaw.com.

### Database

SQLite through Node's built-in `node:sqlite` (synchronous; it replaced the `sqlite3` package on
2026-09-30), single file `server/voicaw.db` (overridable with `DB_PATH`) in WAL mode (reads never
wait for a write; `voicaw.db-wal` / `-shm` sit next to it and belong with it). Plenty for this
app's size: SQLite takes thousands of writes a second, and the move to Postgres was considered and
dropped (2026-09-30) until there's a real need (several API processes). Foreign keys are not
enforced (they never were). The schema is created idempotently (`CREATE TABLE IF NOT EXISTS`) in
`server/db.js` on require, in order, before anything else runs (no ORM: a new column on an
existing table goes through `addColumn`, which ignores "duplicate column"). Changes to existing
data that must run exactly once are `MIGRATIONS` at the end of `db.js`, numbered with SQLite's
`PRAGMA user_version`, each in its own transaction (1: @everyone gets Connect and Speak; 2: clear
`users.last_online`, which had only ever held the sign-up time; 3: roles and channel overrides
that allow or deny Manage Messages do the same for Pin Messages; 4: index existing guild messages
for search; 5: lower-case usernames, see Auth; 6: `guild_channels`' type CHECK gains `'list'`
(the table is copied into a new one, keeping its id counter) and @everyone gets Edit Tasks; 7: @everyone gets Video, for
screen sharing); add the next one at the end.
- Queries: `db.get` / `db.all` / `db.run` return promises, as with the old driver (rows are plain
  objects; `undefined` binds as NULL, booleans as 1/0). Prepared statements are cached.
- **Transactions:** anything that writes more than one row (or one row that depends on another)
  goes in `await db.transaction(async () => { ... })`: its writes are all kept, or all undone if it
  throws. While one is open, other requests' queries wait (the transaction's own code is told
  apart with `AsyncLocalStorage`), so keep it to database work: no S3, LiveKit, pushes or socket
  sends inside. A nested call is a savepoint (a failure inside undoes only its own writes, so the
  outer one can catch it and carry on, as posting a group log entry does with its epoch).
- Guild tables are `guilds` plus `guild_*`. An earlier sketch left unused, empty tables in old databases
(`roles`, `user_roles`, `categories`, `channels`, `channel_permissions`, `messages`); nothing
creates or reads them any more, and they can be dropped.

### Guilds

Discord-style servers, always called **guilds** in the app and its code (never "servers": that
word is kept for the app's own server). **Not end-to-end encrypted**, on purpose: the server reads guild
messages, so it can do mentions, search and moderation. Encryption stays for DMs and (planned)
group DMs. Anyone can create a guild; its creator is the owner (`guilds.owner`).
- **Permissions** (`server/permissions.js`, copied in `client/src/utils/permissions.js`; a
  test checks they match) are Discord's model with a bit field: View Channel, Send Messages,
  Add Reactions, Manage Messages, Manage Channels, Manage Roles, Manage Guild, Create Invite,
  Kick, Ban, Administrator, Manage Emoji, Connect, Speak, Video (`STREAM`: share your screen;
  voice), Mention Everyone (@everyone,
  @here and any role; not a default, guild-wide only), Pin Messages (not a default; split out of
  Manage Messages like Discord did, migration 3), Manage Webhooks (guild-wide only), View Audit
  Log (not a default, guild-wide only; see Audit log), Edit Tasks (list channels; see List
  channels). Every guild has an `@everyone`
  role (`is_everyone`, position 0, default: view, send, react, invite, connect, speak, edit tasks, video) plus orderable roles (`guild_roles`: name, colour
  0xRRGGBB or null, `hoist` = shown separately in the member list, `mentionable` = anyone may
  @mention it, position: higher ranks
  higher), given out in `guild_member_roles`. Guild permissions are @everyone's plus the
  member's roles'; the owner and Administrator get everything.
- **Channel overrides** (`guild_channel_overrides`, per role or member, `allow`/`deny` of the
  channel permissions: View, Send, React, Manage Messages, Pin Messages, Connect, Speak, Video, Edit
  Tasks; the editor shows a text, voice or list channel's) apply in order: @everyone's, the member's roles' (all denies, then
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
  categories; deleting a category keeps its channels, uncategorised. With Manage Channels,
  channels and categories are dragged into order in the channel list (`hooks/useChannelDrag.js`:
  a channel can go into another category or above them all, a line shows where; the layout
  changes at once, then saves): `PUT /guilds/:id/channels/:c/move { categoryId, beforeId }`
  (null `beforeId`: the end of that category) and `PUT /guilds/:id/categories/:c/move
  { beforeId }`. They only move the one item, so channels the mover can't see keep their places.
  `PUT /guilds/:id/layout` sets the whole order at once (every category id, every channel
  `{id, categoryId}`), so it only works for someone who sees every channel.
- `GET /guilds/:id` (and the `guild_update` event, sent to every member on any change) is the
  layout as that member sees it: guild, `my_permissions`, `my_role_ids`, every role (highest
  first), and the `categories` and `channels` they can see, in order, each channel with its
  `my_permissions` and `private`.
- Invites: 8-character codes, optional expiry (`maxAge` s, up to 30 days) and `maxUses`,
  claimed atomically. Joining marks existing history read. Bans remove and block rejoining.
  The owner has to transfer ownership before leaving.
- **Invite embeds:** an invite link in a message (`utils/inviteLinks.js`: this app's host or
  `*voicaw.com`, path `/invite/<code>`) gets a card under it (`guild/InviteEmbed.jsx`, from
  `UrlPreviews`): the guild's icon, name, member count, and Join Guild (joins, opens the guild)
  or Go to Guild; membership comes from `guildList`, so it flips as soon as you join. Data is
  `GET /invites/:code`, asked once per code per session (`fetchInvitePreview`). In guild
  channels it loads at once; in DMs and group DMs (`ChatPane` `encrypted`, default true) it
  waits for a tap on Show, since asking would tell the server which invite an encrypted
  message held.
- Messages have the DM row shape (`sender_*`, `parent_*`, `reactions`, `edited`) so
  `MessageList` can show both; content is plain text up to `maxPlaintextLength` characters.
  Authors edit; authors or Manage Messages delete. Reactions are plain emoji, one of each per
  person.
- Unread: `guild_channel_reads` holds each member's last read message per channel;
  `GET /guild-unread` counts newer messages by others. Sending marks your own channel read.
- Icons: `GET /upload_guild_icon` (Manage Guild, image, 8MB) signs `guild-icons/<guild id>`; then
  `PATCH /guilds/:id {iconUploaded: true}` bumps `icon_version` (use it as `?v=` to bust caches).
- **Client:** routes `/guild/:guildId/:channelId?` (`guild/GuildView.jsx`; without a channel it
  opens the last one viewed there, `localStorage guildChannel:<id>`, or the first text one) and
  `/invite/:code` (`guild/InvitePage.jsx`; logged out, that URL shows the login form, then the
  invite). `hooks/useGuildList.js` (in `Layout`, exposed as `LayoutContext.guildList`) holds the
  guild list, the layouts opened so far, and unread counts, kept current by `onGuildEvent`
  (`ws-client`, every `guild_*` event). `Sidebar` is the guild rail (guild icons with unread
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
  rank), Message / Make owner / Kick / Ban (a panel over the chat on mobile). Guild Settings
  (`GuildSettingsDialog`) has tabs by permission: Overview, Roles (`RolesSettings`: drag or
  arrows to reorder, colour swatches, permissions), Emoji (`EmojiSettings`), Invites, Bans. A channel's settings have a
  Permissions tab (`ChannelPermissions`: private toggle, ✕ / / ✓ per role or member). Dialogs use `guild/Modal.jsx`; styles are
  `assets/css/guilds.css`. Attachments in channels still go through the encrypted upload (the
  key is in the plain message, so anyone in the channel can open them); plain uploads can come later.
- **Audit log** (`server/auditLog.js`, `routes/auditLog.js`, `guild_audit_log`), like Discord's:
  who did what, to what, when. Routes call `logAudit` inside their transaction: message deletes
  (anyone's, own included; whose it was, who deleted it, channel, when it was sent, **never its
  text**; a webhook deleting its own with its token is the actor), pins/unpins, kicks, bans and
  unbans, member role changes, ownership transfer, roles (create/change/delete, with what
  changed), channels and categories (create/change/delete), channel overrides (before/after),
  invites (create/revoke), emoji, webhooks, guild name/icon. Not logged: reordering roles,
  channels and categories, joins and leaves, edits, reactions, voice. `details` keeps names as
  they were. Kept for good (deleted with the guild); the owner alone (not Administrator: they
  could hide their own doings) can clear entries older than 30/90/365 days or all (`POST
  /guilds/:id/audit-log/clear { olderThanDays }`, `clearAuditLog`), which logs an
  `audit_log_clear` entry.
  Reading (`GET /guilds/:id/audit-log?before&limit&actions=a,b&userId`, `{ entries, users,
  webhooks, next }`) needs View Audit Log (owner and Administrator have it); an entry about a
  channel shows only to those who can see it, and once the channel is deleted, only to
  administrators if it was private then (`private` column). Client: guild menu → Audit Log
  (`guild/AuditLogDialog.jsx`; wording in `utils/auditLog.js`), filters by who and what, rows open
  to show what changed, Load more.
- **Guild rail order** is per member (`guild_members.position`; `PUT /guilds-order` with every
  guild id, top first; new guilds go at the bottom). `GET /guilds` and `GET /emojis` follow it.
  In the rail, guilds are dragged into order (`hooks/useDragReorder.js`, on
  `hooks/usePointerDrag.js`, which channel dragging shares: a mouse drag after a few pixels, a
  touch drag after holding still, so swiping still scrolls; the click after a drop is swallowed).
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
- **Not done yet:** category-level permissions (overrides are per channel), server folders in the
  rail, search dates (see Guild search), per-channel notification settings and muting, a list of your recent mentions. Voice: see
  Voice channels.

### List channels (tasks)

Guilded's lists as a guild channel type, `list`: a board of tasks, each with a title (200),
description (4000, markdown like messages), assignees (up to 10), a due date (a day,
`YYYY-MM-DD`, no time zone), completion (who and when), subtasks (nested up to `MAX_DEPTH` 5
levels), and comments (2000). Not end-to-end encrypted, like the rest of a guild. A board holds
up to 2000 tasks.
- **Permissions are the board's** (the channel's overrides, per role or member); a task has none
  of its own. View Channel sees the board (without it: 404, no events, not assignable), **Edit
  Tasks** (`EDIT_TASKS`, a channel permission, on for @everyone by default) adds, edits,
  assigns, completes, reorders, nests and deletes tasks; Send Messages comments ("Comment on
  Tasks" in a list channel's Permissions tab) and Manage Messages deletes others' comments
  ("Manage Comments"). Managing the board itself (rename, permissions, delete) is Manage
  Channels / Manage Roles as for any channel. So a read-only board is @everyone denied Edit
  Tasks with a role or member allowed it, and a private one is View Channel as usual.
- **Server** (`server/guildTasks.js`, `routes/guildTasks.js`; tables `guild_tasks` (tree:
  `parent_id`, siblings ordered by `position`), `guild_task_assignees`, `guild_task_comments`):
  `GET/POST /channels/:id/tasks` (every task flat, with `assignees` and `comment_count`; the
  client builds the tree), `PATCH /tasks/:id { title, description, dueDate, assigneeIds,
  completed }`, `PUT /tasks/:id/move { parentId, beforeId }` (not into its own subtasks or past
  the depth limit; renumbers that parent's subtasks and sends them all), `DELETE /tasks/:id`
  (with its subtasks and their comments), `GET/POST /tasks/:id/comments`, `PATCH/DELETE
  /task-comments/:id`. Assignees must be able to see the board. Deleting the channel (or guild)
  deletes its tasks; leaving a guild unassigns you from its tasks. Not in the audit log.
- **Assignment notification:** whoever is newly assigned (never the person assigning) gets
  `guild_task_assigned` and a push (`type: 'task'`, "X assigned you a task (#board, Guild)", the
  task's title, url `/guild/<g>/<c>?task=<id>`, tag `task-<id>`; the desktop app shows it too),
  unless their notification level for the guild is 'none' or they're looking at the board
  (chat id `channel-<id>`, like a text channel).
- **Client:** `GuildView` shows `guild/ListChannelView.jsx` for a list channel (no member list
  there; the task details use that space). `hooks/useTaskBoard.js` loads and keeps the tasks
  (events, reload after a reconnect; moving and completing show at once and roll back if
  refused), `utils/taskTree.js` builds the tree and decides what shows (filters All / Open /
  Assigned to me keep a match's parents, dimmed; collapsed tasks in `localStorage
  taskCollapsed:<channel>`), where a drop lands and due-date urgency. Dragging a row (on
  `usePointerDrag`: mouse after a few pixels, touch after holding) onto a row's top or bottom
  30% puts it before or after, onto the middle makes it a subtask (last); below an open task
  with subtasks means its first subtask. `guild/TaskDetail.jsx` (beside the board; full screen
  on a phone; opened by `?task=<id>`, so links and notifications open it): completion, title,
  assignees (picker of the board's viewers, "Assign me"), due date, description, subtasks,
  comments. `TaskBits.jsx` has the checkbox and due chip; styles are `assets/css/tasks.css`.
- **Not done yet:** a list of everything assigned to you across boards (and unread/assigned
  badges in the channel list), notifications for comments, due-date reminders, recurring
  tasks, moving a task to another board, keyboard reordering, and tasks in guild search.

### Guild search

Server-side search of a guild's messages, like Discord's (guilds aren't encrypted, so the server
can; DMs and group DMs can't be searched this way).
- **Index** (`db.js`, `server/searchText.js`): an FTS5 table `guild_messages_fts` (rowid = the
  message id, `unicode61` with diacritics removed) holds each message's words (`searchText`:
  the text without mention ids, attachments by name (never their key-carrying links, GIFs
  left out), custom emoji by name, a poll's question and answers, a webhook's embeds and file
  names), and `guild_messages.search_has` its `has:` bits (`searchHas`: link, embed, file,
  image, video, sound, poll; uploads by the `t=` type in their fragment, GIFs count as images).
  **Anything that writes a guild message's content, embeds or attachments calls
  `db.indexGuildMessage(id)` inside its transaction** (sending, editing, webhooks); a trigger
  removes a deleted message's words. Migration 4 indexed the messages from before.
- **API** (`routes/guildSearch.js`): `GET /guilds/:id/messages/search` with Discord's
  parameters: `content` (every word matches a word starting with it, `"quoted"` an exact phrase;
  something with no letters or digits, like an emoji, is looked for in the text as typed),
  `author_id` and `channel_id` (any of them; comma separated or repeated), `has` and `mentions`
  (user ids written in the text as `<@id>`; all of them), `sort_order` (desc/asc), `offset`
  (pages of 25, up to 5000). Returns `{ total_results, messages }` (channel message rows).
  Only text channels the caller can view are searched; non-members get 404.
- **Client:** `guild/GuildSearch.jsx`, at the end of the channel header (on a phone a button that
  opens it full screen). `utils/searchQuery.js` parses the box (`from:user`, `mentions:user`
  by username or unique display name, `in:channel`, `has:thing`, quoted values with spaces)
  into those parameters and reports unknown names instead of searching; it also gives the
  suggestions (the four filters in an empty box, then members, channels or `has:` values;
  arrows, Tab or Enter pick; Enter searches once the word is complete). Results float under
  the box like the pinned list (Newest/Oldest, Load more) and stay open after Jump on a computer.
  Jump (`GuildView`) opens the message's channel and passes `ChatPane` a `jumpTo` once
  `useChannel`'s `loadedChannelId` is that channel; `ChatPane` then loads older pages until
  it's there, as the pinned list's Jump does.
- **Not done yet:** `before:`/`after:`/`during:`, `pinned:`, author type (webhooks), a
  "most relevant" order, and search in DMs and group DMs (it would have to run on the device).

### Webhooks (Discord's API)

A webhook posts into one text channel from anywhere, with its own name and picture, like
Discord's; **the API is Discord's** (`server/routes/webhooks.js`), so anything that posts to a
Discord webhook URL works with ours by changing the URL's start: `https://voicaw.com/api/webhooks/
<id>/<token>` (also `/api/v6`–`/api/v10/...`, and `api.voicaw.com`). Not end-to-end encrypted,
like the rest of a guild.
- **Table** `guild_webhooks` (guild, channel, name, avatar id, token: 68 random characters,
  stored as Discord does since the URL can be copied again; creator). Deleting a channel deletes
  its webhooks. Messages are `guild_messages` with `sender_id` 0 (no user; `MESSAGE_SELECT`
  LEFT JOINs users and uses `webhook_name` as `sender_username`), `webhook_id`, and the name
  and picture **as sent** (`webhook_name`, `webhook_avatar`: our picture's URL or the post's
  `avatar_url`), plus `embeds` and `attachments` (JSON, Discord's shapes), `flags` and
  `edited_at`. Old pictures are never deleted, so old messages keep theirs.
- **With the token** (no login): `POST` executes (JSON, a form, or multipart with
  `payload_json` and `files[n]`; `?wait=true` returns Discord's message object, else 204;
  `thread_id` is refused), `GET/PATCH/DELETE` the webhook (name, avatar as a data URI), and
  `GET/PATCH/DELETE .../messages/:id` for its own messages (PATCH: content, embeds, flags,
  `attachments` to keep, new files). Discord's checks and errors (`{ message, code, errors }`:
  10015 unknown, 50027 bad token, 50006 empty, 50035 invalid form body with the field's path,
  40005 too large, 50109 bad JSON), embed limits (10 embeds, 6000 characters, title 256,
  description 4096, 25 fields...), `attachment://<name>` in embeds, `allowed_mentions`, flags
  SUPPRESS_EMBEDS and SUPPRESS_NOTIFICATIONS (no pushes). Rate limit 5 per 2 s per webhook
  (429 `{ retry_after }` and `X-RateLimit-*` headers). Like Discord, a webhook may ping
  @everyone, @here and any role (`mentions.js` `allowed`).
- **Files** (up to 10, 25 MB together) go to `uploads/webhooks/<uuid>/<name>`, unencrypted;
  images, videos and sounds are served as themselves, anything else as
  `application/octet-stream` (never HTML or SVG). Pictures (data URIs, 8 MB) are processed like
  profile pictures into `profile-pics/webhooks/<id>/<avatar>.webp`. The app's JSON parser skips
  `/webhooks` paths; the router has its own (12 MB JSON, forms, raw multipart read with
  `Response.formData()`).
- **Logged in** (Manage Webhooks and View Channel): `POST/GET /channels/:id/webhooks`, `GET
  /guilds/:id/webhooks`, `GET/PATCH/DELETE /webhooks/:id` (PATCH can move it to another text
  channel). Channel settings have a **Webhooks** tab (`guild/ChannelWebhooks.jsx`, for text
  channels; someone with only Manage Webhooks gets just that tab): New Webhook (named "Captain
  Hook", like Discord's), each one's picture (shrunk to 512 px in the browser, since nginx
  takes 1 MB by default), name, Copy Webhook URL (built from the app's own API address,
  `utils/webhookUrl.js`), delete.
- **Drawing** (`MessageList`): the webhook's picture and name with an APP tag, no profile card;
  `MessageEmbeds` (colour bar, provider, author, title link, markdown description and fields,
  inline fields three across, image, thumbnail, footer and time) and `MessageFiles` (images,
  video, audio inline, else a download box; a file an embed already shows isn't repeated).
  Links open without a referrer; images in embeds and an `avatar_url` override come **straight
  from other sites** (no referrer), so those sites see readers' IP addresses, as with other
  sites' images in messages. A webhook's messages group only with the same webhook under the
  same name and picture.
- **Not done:** Discord's Slack- and GitHub-compatible endpoints (`/slack`, `/github`),
  components (buttons), polls, threads/forums, and `tts`.

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
  and a voice channel in the layout has `voice: [{ user_id, username, self_mute, self_deaf,
  self_stream }]`.
  Without `LIVEKIT_*` settings voice is off: `/api/config` says `voiceEnabled: false`, joins 503.
- **Client** (`voice/voiceClient.js`, read with `hooks/useVoice.js`): one connection per
  device, a module-level store like `ws-client`. `livekit-client` is loaded on the first join
  (it's big). Joining must come from a click (browsers play sound only after one). Muted, the
  mic is released (`stopMicTrackOnMute`, the browser's recording light goes off); deafened, the
  `<audio>` elements are muted and you're muted too; unmuting undeafens (Discord's rules). Mute
  and deafen are remembered per device (`localStorage voicePrefs`) and work outside a call.
  `speaking` is LiveKit's active speakers. A lost connection, being removed, or joining the same
  channel elsewhere ends it with a message in the voice bar.
- **Screen sharing** (guild voice channels, with Video): the token lets you publish
  `screen_share` and `screen_share_audio` only with Video (`publishPermission`), and
  `enforceGuild` changes that live (LiveKit then ends a stream that's no longer allowed; the
  client lets go of the capture). Who's live (`self_stream`) comes from LiveKit's
  `track_published` / `track_unpublished` webhooks (screen share tracks of the session that's
  in), so it's what LiveKit really carries. Client: `startScreenShare` (from a click; the
  browser asks what to share and whether with its sound; LiveKit's default 1080p at 15 fps)
  shows your own stream at once; `stopScreenShare`, also noticed when the browser's own "Stop
  sharing" ends it. **Nobody downloads a stream they aren't watching:** `voiceClient` connects
  with `autoSubscribe: false` and `syncSubscriptions` subscribes every microphone, and a screen
  share (and its sound) only for the one person `watching` (`watchStream(id)`; `attachStream`
  plays it in a `<video>`). The stream's sound plays like the others' (deafen mutes it). UI: a
  Live badge in the channel list and on tiles, Watch Stream on a live tile once you're in, the
  stream big above the tiles (`voice/StreamView.jsx`: full screen, stop watching; the people
  become a row), and the share button (`voice/ScreenShareButton.jsx`) in the voice bar and the
  channel page. Not offered where the browser has no `getDisplayMedia` (phones, which can
  still watch) nor in the desktop app (it needs its own source picker, see Desktop app).
  Bandwidth: the sharer uploads once; LiveKit sends a copy to each viewer.
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
  mute/deafen/share screen/disconnect). `voice/VoiceBar.jsx` sits above the user panel while
  connected (status, channel link, share screen, disconnect, errors); `UserPanel` has mute and deafen
  (`voice/VoiceControls.jsx`). A guild reopens on its last *text* (or list) channel.
- **Not done yet:** device selection, per-user volume, push-to-talk and voice activity
  settings, server mute/move (Mute Members, Move Members), a global push-to-talk key in the
  desktop app (it has global mute/deafen toggles; holding a key needs a native keyboard hook),
  voice isolation stages, screen share in the desktop app and in DM/group calls (LiveKit's E2EE
  would cover the video too), webcam video, stream quality settings, and a TURN server for
  networks that block UDP 7882 and
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
  the Incoming/Outgoing ring loops (see Sounds). Reloading or leaving the page leaves the call.
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
- **Messages** (`group_dm_messages`, `_reactions`, `_reads`): encrypted with the epoch key,
  additional data `groupMessageContext(groupId, epoch, senderId)` (reactions:
  `groupReactionContext(groupId, messageId, reactorId)`); edits keep the message's epoch.
- **Signed** (since 2026-09-30): everyone in a group has the epoch key, so messages, edits and
  reactions are also signed with the sender's identity key, or a member working with the server
  could post as someone else. The signature is inside the encryption (only members see it; the
  server learns nothing new): a `v2.` envelope, "v2." + base64(IV || AES-GCM(64-byte ECDSA
  signature || content)) (`encryptGroupMessage` / `encryptGroupReaction` in groupCrypto.js;
  reactions padded to 64 bytes, so every one is the same size). It covers
  `messageSignatureContext({ groupId, epoch, senderId, replyTo, editOf })` (so a reply can't be
  moved to another parent, nor an edit to another message) or `reactionSignatureContext`.
  `useGroupConversation` checks it against the sender's identity key from the checked log: a
  mismatch isn't shown ("⚠ unverified sender"), a reaction that doesn't match is dropped, and
  `v1.` messages from before signing show as "not signed" (a signature can't be told apart
  from one the server removed). The server takes only `v2.` for anything new (an older app gets
  "Please update the app"). A reply's preview isn't checked (the server doesn't send the
  parent's own signed context; the parent is checked where it's shown). Not signed: the group
  call key (the caller's name comes from the server). DMs aren't signed on purpose: only the
  two people hold the key, so a message can only be from the other one, and unsigned messages
  stay deniable. Pushes say "New message from <name>" (no preview: the service worker has no
  epoch keys).
- **API** (`routes/groupDms.js`): `GET/POST /group-dms`, `GET /group-dms/:id` (summary, the
  whole log, everyone's public keys, your epoch keys, `latest_epoch`, the group's `call`),
  `PATCH` (rename), `POST /:id/log { entry, epoch? }`, `POST /:id/epochs`, `GET/POST
  /:id/messages`, `PUT/DELETE /group-dm-messages/:id` (author), `POST
  /group-dm-messages/:id/reactions`, `DELETE /group-dm-reactions/:id`, `POST /:id/read`,
  pins (see Pinned messages).
  Non-members get 404 for everything.
- **Client:** route `/dm/g/:groupId` (`group/GroupDm.jsx`: header with call and members
  buttons, `GroupCallPanel`, key warnings, `ChatPane`, `GroupMembers`: add people, remove
  (owner), rename, leave). `hooks/useGroupConversation.js` is `useConversation` for a group
  (decrypting with each message's epoch key; membership changes as `system` rows in the
  timeline, which `MessageList` draws as centred lines, from the time you joined).
  `hooks/useGroupList.js` (in `Layout`, `LayoutContext.groupList`) feeds `DmSidebar`, which
  mixes groups in with people by latest message and has the "New group" button
  (`group/NewGroupDialog.jsx`).


### Desktop app (Electron)

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
  `voicaw://app`. Only the app's pages get permissions (microphone, not camera; notifications).
  `backgroundThrottling` is off so ringing and voice work from the tray.
- **Bridge** (`preload.js` → `window.voicawDesktop`, wrapped by `client/src/utils/desktop.js`
  `desktop`, null in a browser): `notify`, `setUnread`, `getSettings` / `updateSettings`,
  `checkForUpdates` / `installUpdate`, `onNavigate`, `onShortcut`, `onUpdateReady`. The main
  process only answers the app's own frames and checks what it's given (`cleanNotification`,
  `cleanChanges`).
- **Notifications** (`notifications.js`): the server sends what would be a web push over the
  websocket (see Push notifications); `hooks/useDesktopApp.js` (in `Layout`) turns it into
  text with the service worker's `notificationFromPush` (DM previews decrypted on the device,
  same previews setting) and a data-URL picture, and the app shows it, one per tag. A click
  shows the window and navigates to its `url`. They're `silent`: the page plays the app's own
  sounds (see Sounds). On/off is Settings → Notifications
  (`pushService` treats the app as always permitted).
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
- **Not done yet:** push-to-talk (held key), screen share's source picker, notifications while
  the app isn't running, code signing (Windows SmartScreen warns about unsigned installers).

### File uploads (S3-compatible object store)

`server/s3.js` wraps `@aws-sdk/client-s3` against `S3_ENDPOINT` (`forcePathStyle: true`, so this
targets a self-hosted/MinIO-style endpoint, not raw AWS). It auto-creates and makes public four
buckets on startup: `uploads`, `profile-pics`, `guild-icons`, `emojis`. Uploads are client-direct: the server only
issues short-lived (60s) pre-signed PUT URLs (`/api/upload_file`, and profile pictures' and
emoji originals, see Profiles and Guilds); the
client uploads the file straight to S3, bypassing the app server. Both routes require a `size` query
param, which is signed into the URL together with the content type (`s3.js` `signableHeaders`), so
the object store rejects a body of any other length or type (verified against the live MinIO).
Limits: 100MB for attachments (nginx's cap on media.voicaw.com), 8MB for profile picture originals,
which must be `image/*`. Profile pictures are unencrypted. Webhooks' files are the exception to
client-direct uploads: they arrive in the webhook request and the server stores them (see Webhooks).

### DM attachments (encrypted, uploaded on send)

Attachments are never uploaded when attached. The composer (`Composer.jsx`, `hooks/useAttachmentDrafts.js`) keeps them as local drafts
and inserts a markdown placeholder `![name](attachment:ID)` (`utils/attachmentMarkup.js`; the editor
shows it as a "📎 name" chip); the tray
(`AttachmentTray.jsx`) previews drafts still referenced from the text. On send, each referenced
draft is encrypted with its own AES-GCM key (`services/attachmentCrypto.js`), uploaded as
`application/octet-stream` (`services/attachmentUpload.js`; server names it `<uuid>.bin`), and its
placeholder is replaced with `<fileUrl>#v=1&k=<key>&t=<mime>&s=<size>[&w=<px>&h=<px>][&sp=1]` (image/video
dimensions, read at attach time by `utils/mediaDimensions.js`, let the renderer reserve the final
box before the file loads; `sp=1` marks a spoiler, see below). The fragment is never sent
to S3 and the URL only exists inside the E2EE message. `Attachment.jsx` renders every markdown image:
placeholders (pending messages, from local blob URLs), encrypted attachments (fetched, decrypted,
cached in `services/attachmentCache.js`; images/videos inline, anything else a download box), and
plain URLs (legacy unencrypted uploads, external images) as `<img>`.

**Spoilers:** an image or video draft can be marked as a spoiler with the eye button in the
tray (`toggleSpoiler`; the thumbnail blurs), which puts `sp=1` in its URL (inside the
encryption, like the rest of the fragment). `Attachment`'s `SpoilerCover` shows it blurred
with "Spoiler" over it for everyone, the sender too, until clicked or tapped; then it stays
shown (per device, not remembered). Until revealed it's out of the image viewer's gallery (its
thumbnails would give it away) and a video has no controls. Previews (`summarizeAttachments`,
guild pushes in `server/mentions.js`) say "📎 spoiler" instead of the file name. GIFs and
other files can't be marked. Because placeholders are
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
  their exact `![name](url)`, so the link and its key never show), custom emoji `<:name:id>` are inline images. Markdown shows as
  it will look while typing, like Discord's box (`editor/markdownPreview.js`, drawn as
  decorations, so the text and its markers stay exactly as typed, markers dimmed): bold,
  italic, underline, strikethrough, spoilers, inline code, ``` code blocks and `>` quotes (not
  headings: Discord doesn't preview them either). It's a line-by-line approximation of how
  messages are rendered (see Message markdown). Unicode emoji stay text, drawn by the Twemoji font, so
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
- Custom (guild) emoji (see Guilds): the picker shows each of your guilds' emoji after Frequently
  Used and before the standard categories, in your rail order, with the guild's icon in the
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

### Message markdown (Discord's set)

Messages are rendered by react-markdown with `remark-gfm` (strikethrough, bare links) and
`utils/remarkDiscord.js`, which makes it Discord's markdown: `__text__` is underline (`<u>`),
`||text||` a spoiler (hidden until clicked, `Spoiler` in `MessageList`; formatting works inside,
code doesn't turn into one), and what Discord doesn't have stays as typed (micromark constructs
switched off: indented code, `---` rules, `===` headings, tables, task lists, footnotes,
`[x]: url` definitions; `####` and deeper headings are turned back into text). Kept: bold,
italic, strikethrough, code, code blocks, `#`–`###` headings, `>` quotes, lists, links.
Plain-text places hide spoilers as `[spoiler]` (`hideSpoilers`: reply previews, DM push
previews; `server/mentions.js` does the same for guild pushes). Copying a message keeps its
markdown. Styles are at the end of `dms.css` (MESSAGE MARKDOWN); only the text inside blocks
keeps its line breaks (`pre-wrap`), and blank lines between blocks (which markdown folds into
one paragraph break) are counted from the source and drawn as empty `.blank-line` paragraphs,
so every newline typed shows.

### GIFs (Klipy)

The emoji picker in the message box has an Emoji / GIFs tab bar when the server has a Klipy key
(`/api/config` `gifsEnabled`; read when the app loads). `components/GifPicker.jsx` shares the
picker's search box (so mobile docked search works the same), shows Trending or Favourites
without a query, loads pages as you scroll, lays GIFs out in two shortest-first columns, and
has a star on each for favourites. The last tab is remembered (`localStorage emojiPickerTab`).
- **Server** (`routes/gifs.js`): `GET /gifs/trending|search?q=&page=` proxy Klipy, so the key
  stays on the server and Klipy gets an HMAC pseudonym per user (`customer_id`), not who's
  searching. Results are cut down to `{ id, title, url (hd WebP), width, height, preview (sm),
  previewWidth, previewHeight }`; ads and anything not on `https://static.klipy.com/` are
  dropped. Favourites: `gif_favorites`, `GET /gif-favorites` (newest first), `PUT/DELETE
  /gif-favorites/:id` (max 500; only Klipy URLs), so they follow you between devices.
- **Sending:** picking one sends it at once as its own message (replying if a reply is set;
  the typed text stays): `![GIF](<url>#gif&w=<px>&h=<px>)` (`utils/gifMarkup.js`), inside
  the encryption in DMs/groups. `Attachment` reserves its box from the fragment and loads it
  straight from Klipy's CDN with `referrerPolicy="no-referrer"`. So in encrypted chats Klipy
  can see the IP addresses of people viewing a GIF (not the chat or its text). Reply previews
  show "📎 GIF".

### Admin settings

Global admins (`users.is_admin`; the first made with `npm run admin -- <username>` in
`server/`, then others from the panel) get an Admin card in Settings (`AdminSettings.jsx`; the
server's 403 hides it from everyone else). App-wide settings are declared in
`server/appSettings.js` (`SETTINGS`: label, description, `env` fallback, `secret`); a value saved
there (`app_settings` table, cached in memory) overrides the `.env` one, and clearing it goes
back. Secrets are write-only: the panel only shows where the value comes from and its last 4
characters. `GET /admin`, `PUT /admin/settings/:key { value | null }`, `POST /admin/admins
{ username }`, `DELETE /admin/admins/:id` (not yourself). Only the Klipy key for now; add new
app-wide keys to `SETTINGS` and read them with `getSetting` rather than from `config.js`.

### Sounds

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
  volume, a switch and a play button per sound).
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

### Polls

Any chat (DM, notes, group DM, guild text channel) can have polls: the composer's `+` opens a
menu (Upload a file / Create poll). `PollDialog.jsx` takes a question (300), 1–10 answers (55
each, each with an optional emoji: Unicode or a guild's custom one, from `EmojiPicker` over the
dialog; Escape there closes only the picker, since `EmojiPicker` marks it handled and `Modal`
skips handled Escapes; Tab goes question → answers → Add another answer, skipping the emoji
and remove buttons), a duration (1h, 4h, 8h, 24h (default), 3d, 1w, 2w) and "Allow multiple
answers"; neither of those two can be changed after posting. A poll is sent as
its own message (replying if a reply is set, like a GIF).
- **Format** (`utils/pollMarkup.js`): the message text is `poll:v1:` + JSON `{ q, multi, d, x?,
  o: [{ id, t, e? }] }` (`e`: the answer's emoji, drawn like a reaction's, `ReactionEmoji`; ids:
  8 random `[a-z0-9]`; `d`: seconds it runs; `x`: unix s its author ended it), so in encrypted
  chats it's inside the encryption.
  `MessageList` draws it with `Poll.jsx` in two phases, like Discord's: **voting** (tapping
  answers only selects them; Vote sends the choice, Show results peeks) and **results** (once
  you've voted: bars and counts; Remove vote, or Back to vote if you only peeked). Tapping an
  answer in the results opens `PollVoters.jsx` (a tab per answer, who voted for it). The
  pinned list shows results only; plain-text places show "📊 Poll: <question>" (`summarizeAttachments`, and
  `server/mentions.js` for guild pushes). An app from before polls shows the raw text.
- **Votes are reactions** whose emoji is `poll:<option id>`, so they're stored, encrypted,
  signed (groups) and delivered exactly like reactions, and in encrypted chats the server can't
  tell a vote from a reaction. Reaction chips leave them out (`groupReactions`). `useReactions`
  `vote(msg, optionIds)` (`planVotes`) makes your votes exactly that choice (`[]`: removes
  them), deleting your votes for answers that no longer exist too.
  `tallyVotes` counts only answers that exist, and one vote per person (the latest) in single
  choice. Percentages and "N votes" are of the votes cast (`cast`, `voteShare`), so in a
  multiple-choice poll they still add up to 100%. In guilds a vote only needs View Channel (not Add Reactions): the server accepts
  `poll:<8 chars>` on a message that starts with `poll:v1:` without it.
- **Editing** (the author, Edit opens `PollDialog`, not the inline editor): question and
  answers can change; an answer whose text or emoji changed gets a new id (`editedPoll`), so its votes
  stop counting. Nobody can delete other people's reactions, so those old votes stay stored
  until their owner votes again.
- **Closing** (`pollEndsAt`): `d` seconds after the message's timestamp (the server's, so the
  author's clock doesn't matter), or earlier at `x`: the author's End poll (in the footer, asks
  first) is an edit stamping `x` (so the message shows "edited"). The footer says the time left
  (`timeLeft`, redrawn each minute, and at once when the poll's end changes; an early end
  counts as closed at once whatever the device's clock says) or "Poll closed"; closed polls show final results, take no
  votes and can't be edited (no Edit in the menus). Votes count only if their reaction's server
  `timestamp` isn't after the close (reactions keep `timestamp` through decryption for this).
  Polls from before durations have no `d` and never close by themselves. In guilds the server
  enforces it too (`server/polls.js`): no votes or vote removals once closed, no edits of a
  closed poll, and an edit can't change `multi` or `d`, un-end one, or end it at any time but
  about now. In DMs and groups only clients enforce it: someone with a modified app could still
  add a vote the server timestamps later (it doesn't count) or edit their own poll's `d`.
- **"Poll ended" rows** (`server/pollTimers.js`, `PollEndNotice.jsx`): when a poll closes, a
  row in the chat says "X's poll Q has closed." with the winning answer and its share of the
  votes cast ("won with 60% (3 of 5 votes)"), a draw ("a draw between A and B, 40% each") or
  "Nobody voted.", and View poll (jumps to it). It works the same in DMs, notes, group DMs and
  guild channels without the server learning the poll's contents: after sending a poll its
  author tells the server when it closes (`POST /polls/:kind/:messageId/timer { duration }`,
  kind `dm`/`group`/`guild`, `services/pollService.js`; `poll_timers`, `ends_at` = the
  message's timestamp + duration), and End poll does `POST .../end` after the edit. A sweep
  (every 5 s, only when run as the server; tests call `announceDue`) posts each due row once:
  a message in that chat's table with `system` = 'poll_end', the poll's author as sender, the
  poll as parent and empty content, sent as the chat's usual new-message event (no pushes;
  unread like any message, in a group in the poll's epoch). Rows carry the poll (the parent,
  still encrypted, plus `parent_timestamp`; in groups also the poll's `parent_reply_to` and
  `parent_edited`, so its signature is checked) and its votes (`poll_reactions`, still
  encrypted), and each device works the result out (`pollResult`, votes up to the poll's own
  end). So the server learns that a message is a poll and when it closes (and who reacted when,
  as before), never the question, answers or result. It posts the rows, so in an encrypted chat
  it could post one early: a row that doesn't fit its poll (`pollEndFits`: not ended by then,
  give or take a minute) isn't shown, and neither is one whose poll can't be read (someone
  added to a group later never gets it: it's in the poll's epoch). Rows can't be edited;
  deleting a poll deletes its row (and timer). An app from before this shows them as unreadable.
- **Not done yet:** a notification when a poll closes.

### Mentions

Discord's forms, in message text: `<@id>` (a person; DMs, group DMs, channels, inside the
encryption where there is one), and in guilds only `<@&id>` (a role), `@everyone` and `@here`.
Helpers in `utils/mentions.js`. Only ids are stored, so a mention always shows the current
name, looked up when drawn: people from the chat's names (`ChatPane`'s `reactionNames`: the two
in a DM, everyone in a group's log, a guild's members; anyone else `@unknown-user`), roles from
`mentionRoles` (`{ id: { name, color } }`; gone: `@deleted-role`).
- **Who can be mentioned:** typing `@` (after a space/bracket or at the start) lists, in
  `MentionSuggestions` (`searchMentions`: people, then up to 3 roles, then @everyone/@here),
  `people` (`ChatPane` → `Composer`: the DM's two, the group's current members, or the members
  who can see the channel, from `GET /channels/:id/members`, refetched on any guild, member or
  role change; `GuildView` also shows only them in the member list), the roles you may mention
  (`mentionable`, or all with Mention Everyone) and, with Mention Everyone, @everyone and
  @here. Keys and clicks work as for `:emoji` suggestions. Picking puts a `mention` or
  `roleMention` node in the editor (`editor/messageDoc.js`; the editor's `mentionNames` /
  `mentionRoles` props turn text back into them); @everyone/@here stay text.
- **Server** (`server/mentions.js`), guild messages only (it can't read DMs or groups): on send
  and edit, `saveMentions` works out who's mentioned (nothing inside code; roles only if
  `mentionable` or the sender has Mention Everyone; @everyone/@here need it, else they're
  just text; @here = viewers not offline; only members who can see the channel; never the
  sender), stores them in `guild_mentions` (message, channel, user) and on the message
  (`mention_everyone` 0/1, `mention_roles` JSON; sent as an array). `/guild-unread` counts them
  per channel (`mentions`). A new message sends `guild_mention` to each person mentioned and
  pushes by each member's level for the guild (`guild_members.notify_level`: 'all', 'mentions'
  (default), 'none'; `PUT /guilds/:id/notifications`, `my_notify_level` in the layout; set in
  the guild menu's Notification Settings, `guild/NotificationDialog.jsx`), skipping whoever is
  looking at the channel. Guild pushes are plain text (guilds aren't end-to-end encrypted):
  title "sender (#channel, Guild)", body with names for mentions, `:name:` for custom emoji and
  attachment names (never their key-carrying links). Edits don't push (like Discord).
- **Client:** `rehypeMentions` (`utils/rehypeMentions.js`) marks them; `MessageList`'s `span`
  component draws `@name` (`.mention`, `.mention-me` for you), roles in their colour
  (`.role-mention`, `--role-color`), and @everyone/@here as mentions only if the message pinged
  them. A message for you (`mentionsMe`: names you, pinged @everyone/@here, or one of your
  roles, `myRoleIds`) gets `.mentioned` (tinted, bar on the left). Unread mentions show as red
  counts on the channel (`GuildSidebar`) and the server icon (`Sidebar`), from
  `useGuildList`'s `unread[].mentions`. Plain-text places use `mentionsToText` (reply previews,
  copying, DM push previews: the push carries `recipientName` for that).
- DMs and group DMs push every message already; mentioning someone there adds no notification
  (the server can't see it).
- **Channel mentions** `<#id>` (Discord's form): a link to a guild channel, notifying nobody;
  usable anywhere (DMs and groups too, inside the encryption). In a guild channel, typing `#`
  lists the channels you can see (`searchChannels`, the channel list's order with each one's
  category; `GuildView` → `ChatPane` `channels` → `Composer`), and picking puts a
  `channelMention` node (`#name`) in the editor. Names come from `ChannelMentionContext`
  (`contexts.js`, provided by `Layout`): every channel in the guild layouts opened so far.
  `MessageList`'s `ChannelMention` draws the icon and current name; clicking navigates to
  `/guild/<guild>/<channel>`. One not known yet calls `loadAll()`, which opens all your other
  guilds' layouts once (never a request about that one channel, so an encrypted message's
  channel isn't revealed); still unknown (can't see it, deleted, not your guild) it's
  `#unknown-channel`. Plain-text places pass the channels to `mentionsToText`; the service
  worker has none, so DM push previews say `#unknown-channel`. Guild pushes name a channel only
  for recipients who can see it (`mentionedChannels`, so the body can differ per person); search
  doesn't index the ids.

### Pinned messages

Any message in a DM, group DM or guild text channel can be pinned. Who may: either person in a
DM, any member of a group DM (a message they can read), Pin Messages in a channel. Max 250 per
chat (`MAX_PINS`, Discord's number; 400 past it).
- **Server** (`server/pins.js` `setPinned`, routes in `dms.js`, `groupDms.js`,
  `guildMessages.js`): `pinned_at` (unix s) / `pinned_by` columns on each message table, null
  when not pinned; message rows carry them, and deleting a message takes its pin with it.
  `PUT` / `DELETE /dm-messages/:id/pin`, `/group-dm-messages/:id/pin`, `/guild-messages/:id/pin`
  return `{ messageId, pinned_at, pinned_by }`; a change (not a repeat) sends `dm_pin` (with
  `sender_id`/`recipient_id`) / `group_dm_message_pin` / `guild_message_pin` to whoever can see
  the chat. Lists, most recently pinned first, as message rows: `GET /dm-pins/:otherUserId`,
  `/group-dms/:id/pins` (only epochs you have a key for), `/channels/:id/pins`.
- **Encrypted chats:** which message is pinned, by whom and when is visible to the server (like
  reply links and reactions), never what it says; the list is decrypted (and, in groups, its
  signatures checked) on the device like history. Pins aren't signed: in a group the server
  could claim someone pinned something, or unpin it.
- **Client:** the chat hooks (`useConversation`, `useGroupConversation`, `useChannel`) have
  `loadPins()`, `setPinned(msg, pinned)` and `pinsVersion` (bumped on every pin change there,
  so an open list reloads). `ChatPane` takes `canPin`, `pinsAnchor` (the header button's rect)
  and `onClosePins`: a pin button in the hover menu and "Pin / Unpin message" in the mobile
  action sheet, and `PinnedMessages` (floating under the header's pin button; full screen on a
  phone; Escape or a click outside closes it), which draws each with `MessageContent`
  (`MessageList`'s markdown, no menu) and has Jump (loads older pages until the message is
  there, then scrolls to it and flashes it, `.jump-highlight`) and Unpin. A pinned message shows
  a small pin by its time (after the text when grouped).
- **Not done yet:** a "X pinned a message" line in the chat (Discord's system message) and
  notifications for pins.

### Profiles

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

### DM message list and history loading

`MessageList` is deliberately **not virtualized**: every loaded message is rendered in a plain
scroll container. Virtualized lists (react-virtuoso was used before) must guess the height of
rows they haven't rendered and correct afterwards, which showed as the chat jumping while
scrolling up. Measured in headless Chrome, the plain list has no such jumps. The browser's CSS
scroll anchoring (`overflow-anchor`) keeps visible messages still when older pages are prepended
or content above resizes. Where that's unsupported (Safari), `MessageList` does the same manually
by tracking the first visible row's `offsetTop` (layout effect + ResizeObserver, both before paint).
It also keeps the view pinned to the bottom while the user is there.

Messages are grouped like Discord's (`utils/messageGroups.js` `continuesGroup`): one from the
same person within 7 minutes of the row above, on the same day and not a reply, drops its
avatar, name and date (`.grouped`; the time shows in the avatar column on hover, "(edited)"
goes after the text). A group DM message whose sender isn't verified (unsigned or a bad
signature) never groups, either way, so it can't pass as the person above.

Where a new day starts (on the device's calendar), a line with the date in words goes across
the chat, like Discord's (`startsNewDay` in the same file, `DayDivider` in `MessageList`,
`formatLongDate`: "11 September 2026" in the Date & time setting's order). The first loaded
row only gets one once there's no older history (`hasMore` false). Client-side only; it's
drawn inside the row's wrapper, so row keys and scroll anchoring are unchanged.

`hooks/useConversation.js` loads a conversation in exactly one effect (keyed on `id` + the other user's public key,
ignoring late responses after a chat switch). Older pages (`PAGE_SIZE`, sent as `limit`, server
clamps 1–100, default 10) are only ever prepended by `loadMoreMessages`, which guards against
overlapping loads and drops ids already present. Rows are keyed by `clientKey ?? id`
(`clientKey` carries a sent message's temp id). react-markdown's `components` must be a stable
object, or attachments remount on every render. Image/video attachments carry their dimensions so
their box is reserved before they load.

Drawing markdown is what makes rows expensive (a webhook embed is a dozen bits of it), and rows
redraw on every hover, page load and name change, so: `MessageMarkdown` and `WebhookParts` are
`memo`ed and take only what they draw (keep their props stable); react-markdown re-runs every
plugin's setup on each render, so plugins with costly setup must do it once
(`utils/rehypeHighlightShared.js`: rehype-highlight registers ~40 languages); text with nothing
for markdown to do skips the parser (`utils/plainText.js` `isPlainText`, tested against
react-markdown's output); Intl formatters are cached (`dateFormat.js`). `e2e/embedperf.mjs`
measures a channel of 150 embeds (open, hover, scroll; computer and a 4× slowed phone). Before
these (2026-10-01) it froze for seconds; now opening takes ~0.2 s of script on a computer.

### Client structure

- Component files export only components (Vite hot reload needs that; lint enforces it).
  Contexts live in `contexts.js` (`ConfigContext`, `InteractionContext`, `LayoutContext`) and
  `hooks/useAuth.js`; logic lives in `hooks/` and `services/`.
- `AuthProvider.jsx` — fetches `/api/profile` on mount to restore the session (id, username, JWT)
  into `useAuth`; the keys come from IndexedDB (`keyStore`). `services/authService.js` does the
  OPAQUE login/register (`Login.jsx` is just the form).
- `App.jsx` — top-level routing (`BrowserRouter`; `HashRouter` only for a page opened from a
  file); provides `ConfigContext` (fetched from
  `/api/config`) and `InteractionContext` (mobile vs. desktop interaction mode, persisted to
  `localStorage`, auto-detected via user-agent unless overridden)
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
  `color-scheme`, which makes the browser's own controls and scrollbars match and, on iPhones
  and iPads, the on-screen keyboard (Android keyboards follow the system or their own setting;
  neither a page nor an app can choose). Code highlighting is Atom One Dark plus
  `hljs-light.css` (Atom One Light under `[data-theme="light"]`).
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

## Decisions, plans and known issues

- **Group DMs** (built 2026-09-30, see Group DMs): removed members don't read new messages and
  new members don't read old ones: per-group epoch keys, renewed after every membership change,
  each member getting a copy wrapped for them (ECDH + HKDF; WebCrypto has no HPKE); membership
  changes signed with identity keys. Re-added members see the times they were in, not the gap.
  Group messages, edits and reactions are signed inside the encryption; DMs deliberately
  aren't (two people, so no one else could have written it; stays deniable). Don't change identity keys or the safety-number derivation
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
  - npm 11 warns that the install script of `esbuild` isn't in an `allowScripts` list yet. It
    still runs today; a future npm will need it approved (`npm install-scripts approve`).
