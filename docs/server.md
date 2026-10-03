# Server layout and environment

## Server layout

`server/index.js` only assembles the app: CORS, `/api/config`, the routers, and the error handler.
Express 5 sends rejected async handlers to that handler, so routes don't need try/catch for
unexpected errors. The rest:
- `config.js`: loads `.env` (required first), checks it, message length limits.
- `db.js`: schema, plus promise helpers `db.get` / `db.all` / `db.run` (`run` resolves to
  `{ lastID, changes }`) and `db.transaction` (see Database). The raw `node:sqlite` handle is
  `db.db`.
- `auth.js`: `startSession`, `generateToken`, `verifyToken` (checks the token's login session),
  the `authenticateJWT` middleware (attach it per
  route, not with `router.use`, since every router is mounted at `/api`).
- `sockets.js`: the `clients` map, `sendToUserSockets`, online status (`getStatus`, see Online
  status), `isViewingConversation`, and
  `attachWebSocketServer` (the ws server).
- `push.js`: web push sending and the DM push payload.
- `s3.js`: pre-signed upload URLs. Bucket setup at startup logs and carries on if the store is down.
- `uploads.js`: which uploads exist and what links to them, and deleting the ones nothing uses
  (see Deleting files in `docs/uploads.md`); `uploadKeys.js` finds upload names in text.
- `guilds.js`: shared guild helpers (membership checks, `getGuildLayout`, `sendToGuild`).
- `guildTasks.js`: list channels' tasks (tree helpers, limits, the assignment notification; see
  List channels); `routes/guildTasks.js` has their routes.
- `guildDocuments.js`: document channels' documents (rows, limits, cleanup; see Document
  channels); `routes/guildDocuments.js` has their routes.
- `channelMutes.js`: each member's muted channels and own channel notification levels (see Mentions).
- `conversationSettings.js`: each person's pinned and muted DMs and group DMs (see
  `docs/client.md`); `routes/conversationSettings.js`.
- `preferences.js`: each person's account preferences, e.g. blurring NSFW channels' media (see
  Account preferences in `docs/client.md`); `routes/preferences.js`.
- `dictionary.js`: each person's spellcheck dictionary, one encrypted envelope with a version
  (see Spellcheck dictionary in `docs/auth-and-encryption.md`); `routes/dictionary.js`.
- `auditLog.js`: a guild's audit log (`logAudit`, `readAuditLog`; see Guilds); `routes/auditLog.js`.
- `voice.js`: voice channels (who's in which, LiveKit tokens and webhooks; see Voice channels).
- `calls.js`: DM and group DM calls (ringing, answering, hanging up; see DM calls).
- `callLog.js`: a call's row in its chat's history once it ends (see Calls in the chat history, under DM calls).
- `groupDms.js`: group DMs (membership log checks, epochs, summaries; see Group DMs).
- `appSettings.js`: app-wide settings a global admin edits (see Admin settings).
- `bots.js`: bot applications and their bot users, tokens, adding bots to guilds (their own
  role); `discord.js`: our objects, ids and permissions as Discord's API shows them;
  `gateway.js`: the bot gateway (Discord's protocol at `/api/gateway`); `actionError.js`: the
  error the guild actions shared by the app's routes and the bot API throw; `commands.js`:
  bots' application commands (checks, storage, who may use them); `components.js`: buttons,
  selects and forms (Discord's limits); `interactions.js`: interactions (delivery, the 3 s
  wait, callbacks, follow-ups, ephemeral messages and open forms in memory); `botMessages.js`:
  bots' message bodies (shared by the bot API and interaction replies). See `docs/bots.md`.
- `pins.js`: pinning and unpinning a message, the same for every kind of chat (see Pinned messages).
- `polls.js`: reading guild polls, when they close, and what an edit may change (see Polls).
- `accounts.js`: deleting an account (see Deleting an account).
- `sessions.js`: listing and ending login sessions (see Login sessions and Settings → Devices).
- `usernames.js`: usernames ignore capitals (`findUserByName`, `opaque_id`; see Auth).
- `pollTimers.js`: when every poll closes and its "poll ended" row (see Polls), and dropping
  the timers of polls whose chat was deleted (hourly); `routes/polls.js`.
- `routes/typing.js`: "… is typing" (`POST /typing`, relayed as `typing`; see Typing indicator in `docs/realtime.md`).
- `profiles.js`: display name, custom status and bio (limits, cleaning, `displayNameOf`; see Profiles).
- `avatars.js` + `avatarImage.js`: profile pictures (processing, storage, the one-off migration;
  see Profiles). `routes/avatars.js` has their routes.
- `routes/`: `auth.js` (OPAQUE register/login, profile), `sessions.js` (Settings → Devices, logout), `dms.js` (conversations, send, edit,
  delete, unread; `DM_SELECT` is the shared message query), `reactions.js`, `guilds.js` (guilds,
  members, invites, bans, categories, channels), `guildMessages.js` (channel messages, reactions,
  read state), `guildSearch.js` (guild search; see Guild search), `voice.js` (join token, mute/deafen, leave, LiveKit webhook), `calls.js` (DM
  calls), `groupDms.js` (group DMs), `webhooks.js` (Discord-compatible webhooks), `applications.js` (the developer portal
  and adding bots to guilds), `botApi.js` (Discord's REST API for bots, at `/api/v10`),
  `interactions.js` (people using bots' commands, components and forms), `push.js`
  (subscriptions), `uploads.js`, `gifs.js` (Klipy search proxy, GIF favourites), `admin.js`.

Client tests sit next to their source files (`src/**/*.test.{js,jsx}`). The default environment is
`node`; component tests opt into DOM with a `// @vitest-environment jsdom` header on the first
line. `vitest.config.js` pins `VITE_API_BASE_URL`/`VITE_WS_URL`, and `src/test/setupTests.js`
stubs `ResizeObserver` (used by `MessageList`) and the Range measuring ProseMirror does. The message
box is an editor (contenteditable), which jsdom can't type into: tests drive it through its handle,
`editorFor(element)` from `editor/editorRegistry.js` (`insertText`, `setText`, `getText`...).
Component tests mock `../utils/api`,
`../utils/ws-client`, and `../services/dmService` with `vi.mock`.

## Server environment

The host runs Node 24 LTS (NodeSource apt package, shared by every pm2 app on it). The
database is Node's built-in `node:sqlite`, so there's no native module to build.

`server/config.js` fails fast at startup if any of these env vars are missing (set them in
`server/.env`): `JWT_SECRET`, `OPAQUE_SERVER_SETUP`, `VAPID_EMAIL`, `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, `S3_ENDPOINT`, `S3_ROOT_USER`, `S3_ROOT_PASSWORD`. Voice channels also need
`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (and `LIVEKIT_API_URL` to reach LiveKit
directly); without them voice is just off. `FCM_SERVICE_ACCOUNT` (a Firebase service account's
JSON key file) lets the Android app be notified while closed (`fcm.js`, see Android app in
`docs/desktop-and-site.md`). `KLIPY_API_KEY` turns on GIFs (also settable in
Settings → Admin, see Admin settings). `README.md` "Initial setup" has the whole list. VAPID keys are generated
via `webpush.generateVAPIDKeys()` (see root `README.md`). `S3_*` vars point at an S3-compatible
object store (e.g. MinIO) used for uploads and profile pics.
