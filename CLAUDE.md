# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Voicaw is a Discord-style chat web app: end-to-end encrypted direct messages and group DMs
(with calls), and guilds
(Discord-style servers, always called guilds in the app: text, voice (with a text chat), list (task board)
and document channels, threads, roles and private channels, scheduled events; not encrypted, see `docs/guilds.md`),
with bots that use Discord's API (`docs/bots.md`). It's an npm workspaces monorepo with
four packages: `client` (React/Vite SPA, also packaged as an Electron desktop app and an
Android app), `server` (Express + ws API), `electron` (the desktop app: the built client plus
notifications, tray, shortcuts and updates) and `mobile` (the Android app, Capacitor: the built
client plus notifications and ringing while closed, call buttons, calls with the screen off);
see `docs/desktop-and-site.md`.

## Working on Voicaw (read first)

Each feature is worked on in its own chat, on its own branch, in its own worktree. The rules:

- **`master` is the deploy branch, deployed by hand** (it replaced `dev` on 2026-10-19; `dev`
  is no longer used). The live API (pm2 `voicaw-api`, :3002, with
  the real database) runs from `/home/otto/git/voicaw`, checked out on `master`. Nothing deploys a
  push any more: the GitHub webhook and the test.voicaw.com dev server (pm2 `voicaw-test`) were
  removed on 2026-10-02. After a merge, the API is updated with `git pull` there (`npm install`
  if the lockfile changed) and `pm2 restart voicaw-api`, only when the user asks. The web app at
  app.voicaw.com is a static build in `/opt/voicaw-client`, only updated by running `npm run
  build` by hand; voicaw.com is the info and download site (`website/`, `/opt/voicaw-site`, see
  `docs/desktop-and-site.md`). Voice runs on a self-hosted LiveKit server, pm2 `voicaw-livekit` (`~/livekit`, not
  in git).
- **Never commit to, merge into, push, reset or otherwise move `master`.** Branch off it
  (`feature-name`), commit there; the user reviews and merges. Don't push branches unless asked.
- **Never work in `/home/otto/git/voicaw`.** It's the live checkout: the API runs from it, so
  switching its branch changes what the next restart serves. Use a worktree per feature:
  ```
  git -C ~/git/voicaw worktree add ~/git/voicaw-<feature> -b <feature> master
  cd ~/git/voicaw-<feature> && npm install
  ```
  Chats running at the same time each need their own worktree (and their own e2e ports, see
  `e2e/README.md`). Check `git branch --show-current` before committing. Once the user has
  merged a branch, its worktree can go: `git -C ~/git/voicaw worktree remove ~/git/voicaw-<feature>`
  (ask before deleting branches).
- **Don't touch production** unless asked: no pm2 restarts, no edits to nginx, `server/.env`,
  `~/livekit/livekit.yaml`, the real database or `/opt/voicaw-client`. Never run `pm2 update` (on 2026-09-29 it left every
  app on the host stopped; `pm2 resurrect` brought them back). The host also runs other
  projects' apps under the same pm2 and Node.
- **Done means:** server and client tests pass, `npm run lint` (in `client/`) is clean, UI
  changes are checked in a real browser (`e2e/README.md`), and this file or the `docs/` file
  for that area is updated when something it describes changes (a new feature gets a section
  in the fitting `docs/` file, or a new file listed below). When a change affects how a new host is set up (a new env
  var, service, port, bucket, nginx site, build step or dependency on the host), update
  `README.md`'s "Initial setup" in the same branch: it's the only setup guide. Then commit on the branch with a message saying what and why.
- **Secrets:** never log or commit plaintext messages, keys, tokens, `OPAQUE_SERVER_SETUP`,
  anything from `server/.env` or the LiveKit API secret.

## Commands

Run from the repo root unless noted.

- `npm run dev` — start the client Vite dev server (port 5173, proxies `/api` to
  `https://api.voicaw.com`)
- `npm run build` — build the client for web deployment (into `build-web/`, then copied to
  `/opt/voicaw-client` only if it succeeded; see PWA updates in `docs/client.md`)
- `npm run build:site` — build voicaw.com, the info and download site (`website/`, outputs to
  `/opt/voicaw-site`; also run by `updates/publish.mjs` after every desktop release)
- `npm run start:server` — start the Express/WebSocket server (`server/index.js`)
- `npm run start:electron` — build the client in Electron mode, then launch the Electron shell
- `npm run dist:electron` — the same build, then installers in `dist-desktop/` (electron-builder)
- `npm run dist:electron:win` — the same build, then the Windows installer in Docker with wine
  (`electron/dist-win.sh`, electron-builder's image; unsigned)
- Releases (desktop and Android as one version: GitHub builds them from a pushed
  `desktop-vX.Y.Z` tag, the host checks the attestations, signs Android and publishes; then the
  web app and an API restart): by hand, README "Desktop app" and "Android app". Publishing
  touches the live sites: only when the user asks
- `npm run dist:android` — the client's Android build, `cap sync`, then the APK (and the native
  JUnit tests) in Docker (`mobile/dist-android.sh`) into `dist-android/voicaw-debug.apk`

Client-only (run inside `client/`):
- `npm run lint` — ESLint over `client/src`
- `npm run build:electron` — Vite build with `ELECTRON=true` (outputs to `../build`, served by
  `electron/protocol.js`; uses `.env.production` unless there's a `.env.electron`)

### Tests (Vitest)

- `npm test` (root) — runs server tests, then client tests, then the desktop app's, then the
  Android app's (`mobile/test/`; its Java tests run with `npm run dist:android`)
- `npm test` inside `server/`, `client/`, `electron/` or `mobile/` — run one package's suite
- Single file / single test: `npx vitest run test/dm.test.js` (in `server/`) or
  `npx vitest run src/components/Dm.test.jsx -t "test name"` (in `client/`)
- **Memory:** several chats share one 4-core, 16 GB host, and a RAM-full host freezes for
  hours. While working, run only the test files you touched; run the full suites once, before
  committing. The client and server configs run 2 files at a time (`maxWorkers`) and cap each
  worker's heap at 2 GB, so a leaking test fails with "heap out of memory" instead of filling
  the host (Buffers aren't counted: a test allocating them can still grow, so keep big uploads
  small in tests). The full client suite peaks around 1.8 GB, the server's around 0.8 GB. The
  chats' service, `code-server@otto.service`, is capped at 8 GB, so going over kills a process
  in some chat.

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
- WebSocket handling is not covered: it only exists when `index.js` is run directly.

Client tests sit next to their source (`src/**/*.test.{js,jsx}`), environment `node` unless the
first line is `// @vitest-environment jsdom`. The message box is a contenteditable editor jsdom
can't type into: drive it with `editorFor(element)` (`editor/editorRegistry.js`). Component
tests mock `../utils/api`, `../utils/ws-client` and `../services/dmService`.

### Browser checks

Unit tests can't see layout, scrolling, focus, touch or the editor. `e2e/` runs the real app in
headless Chrome (Playwright) against a throwaway API, object store and LiveKit:
`node e2e/serve.mjs &`, then a script such as `node e2e/smoke.mjs`; one script per feature.
**Read `e2e/README.md` before using it**: ports (never 3002, 7880-7882 or 5173), helpers, the
list of scripts, tips, and running the real desktop app under Xvfb. Kill test processes by PID,
never `pkill -f` with a pattern in your own command line.

## Where things are documented

Read the file for the area you're working on before changing it. Section names mentioned
elsewhere ("see Guilds", "see Polls"...) are headings in these files.

- `docs/server.md`: server layout (which module does what), env vars, Node/sqlite on the host.
- `docs/database.md`: `node:sqlite`, query helpers, transactions, migrations.
- `docs/auth-and-encryption.md`: OPAQUE login, sessions and Settings → Devices, two-factor, rate limits, sign-ups (open, invite
  only, admin approval), deleting an account,
  end-to-end encryption (keys, backups, recovery code, contact pinning, DMs, reactions, notes,
  the spellcheck dictionary, emoji usage).
- `docs/realtime.md`: websocket events, online status, web push.
- `docs/guilds.md`: guilds (permissions, overrides, audit log, invites, custom emoji, channel
  menus, NSFW channels), threads, list channels, document channels, events (scheduled, repeating),
  guild search, webhooks (Discord's API).
- `docs/voice-and-calls.md`: voice channels (LiveKit, reconnecting, screen sharing, microphone
  chain, noise suppression, voice settings, playback and per-user volume, Watch Together), DM and
  group calls.
- `docs/group-dms.md`: group DMs (membership log, epochs, signing).
- `docs/messages.md`: emoji, message markdown, GIFs, YouTube links, link previews, polls, mentions, timestamps, pinned messages, drafts, messages that couldn't be sent,
  search in encrypted chats (on the device), the offline copy, the message list and history
  loading.
- `docs/uploads.md`: the object store, encrypted attachments, video streaming, voice messages, spoilers, image
  viewer.
- `docs/client.md`: client structure (contexts, translations, Layout, settings, dates, themes, sidebar, phone
  panes, PWA updates, spellcheck, right-click menus, pinned and muted conversations, account preferences),
  other servers (the login screen's Server),
  profiles and pictures, sounds, admin settings, blocking, reports and suspensions.
- `docs/desktop-and-site.md`: the Electron app, the Android app (FCM, ringing, ongoing call),
  voicaw.com.
- `docs/bots.md`: bots: applications and bot users, the developer portal, adding bots to guilds,
  Discord's REST API (`/api/v10`) and gateway (`/api/gateway`), ids and permission bits,
  slash and context-menu commands, buttons, selects, forms and ephemeral replies, Login with
  Voicaw (OAuth2 for websites, Settings → Authorised apps).

## Rules that apply everywhere

- **Guilds** are always "guilds" in the app and its code; "server" means the app's own server.
- **Never mention Discord in text people see** (the app, Settings → Admin, the site, the privacy
  policy; decided 2026-10-17): say what a feature does, not that it's like Discord's. Code
  comments and these docs may still compare. The developer docs (`website/src/developers/`)
  still name Discord for API compatibility and its libraries.
- **Encrypted chats** (DMs, notes, group DMs): the server stores and relays only ciphertext and
  is untrusted. Never use a contact's key straight from the server (`contactKeys.js`
  `checkContactKeys`); every format is versioned (`v1.`, `{v:1}`, `voicaw/<purpose>/v1`). Anything
  that lets a third party (Klipy, another site's images...) see something, say so in the docs.
- **Privacy policy** (`website/src/legal/privacy.html`, voicaw.com/privacy/; also the terms and
  `delete-account.html`): every claim matches the code. A change to what's stored, kept for how
  long, encrypted or not, deleted with an account, or seen by a third party updates it in the
  same branch, with its date in `website/build.mjs` `LEGAL`. Changing the terms in substance also
  moves `server/terms.js` `TERMS_VERSION` to that date, so everyone accepts them again.
- **Database:** anything writing more than one row goes in `db.transaction` (database work only:
  no S3, LiveKit, pushes or socket sends inside). New columns through `addColumn`; one-off data
  changes as the next numbered `MIGRATIONS` entry in `db.js`. Anything writing a guild
  message's content, embeds or attachments calls `db.indexGuildMessage(id)` in its transaction.
- **Server routes:** attach `authenticateJWT` per route (every router is mounted at `/api`).
  Permissions live in `server/permissions.js` and a copy in `client/src/utils/permissions.js`
  (a test checks they match). App-wide settings go in `appSettings.js` `SETTINGS`, read with
  `getSetting`.
- **Client:** component files export only components (contexts in `contexts.js`, logic in
  `hooks/` and `services/`). Draw names with `displayName(id, fallback)` / `nameOf(user)` and
  pictures with `Avatar`, never `user.username` or a hand-built URL. Icons are `Icon`
  (`components/Icon.jsx`), not Font Awesome's `FontAwesomeIcon` (slow on phones). Dates and times through
  `utils/dateFormat.js`, never `toLocaleString`. CSS uses the `--vc-*` colour tokens (both
  themes), not literal colours; scrollbars are styled only in `voicaw.css`; desktop and phone
  layouts are `desktop.css` / `mobile.css`; new sidebar/header UI uses `--vc-sidebar-width` and
  `--vc-header-height`, and anything screen-high `--vc-app-height` (never 100vh/svh: it
  ends at a phone's keyboard). react-markdown's `components` must be a stable object, and memoised
  message parts take only stable props. New settings are a subsection of a page in `Settings.jsx` (see Settings in `docs/client.md`). The app's
  text is British English, and every string shown goes through `t('area.key')` with its
  English in `i18n/en-GB/<area>.json` (see Translations in `docs/client.md`; lint fails on
  text written straight into JSX). Write new text in English only: Russian (`i18n/ru/`) and Japanese
  (`i18n/ja/`) are translated in batches when the user asks, and show English until then.

## Decisions, plans and known issues

- **Group DMs** (built 2026-09-30, see `docs/group-dms.md`): removed members don't read new messages and
  new members don't read old ones: per-group epoch keys, renewed after every membership change,
  each member getting a copy wrapped for them (ECDH + HKDF; WebCrypto has no HPKE); membership
  changes signed with identity keys. Re-added members see the times they were in, not the gap.
  Group names are encrypted too (2026-10-02), always under the latest epoch: every new epoch
  carries the renamer's signed name, and an add always comes with its epoch so the person added
  can read it; group keys are kept on the device (IndexedDB) for notifications.
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
  text). DM calls are (LiveKit's E2EE with a per-call key sent inside the DM encryption), screen
  sharing in them too (2026-10-08: everyone in a call may share; a 1:1 call opens the other's
  stream on its own, a group call waits for Watch Stream). The microphone
  path is a Web Audio chain (capture with echo cancellation → input volume → noise
  suppression → gate → published track). Krisp needs LiveKit Cloud or a licence, so it's out:
  noise suppression is RNNoise by default and DeepFilterNet as Strong (decided 2026-10-01),
  both running on the device. Who's talking (the green ring) is measured on the device from
  the audio itself (`voice/speaking.js`, 2026-10-05), not LiveKit's active speakers, which lag
  by half a second. Cameras (2026-10-05): with Video in voice channels (the same
  permission as screen sharing, as in Discord), always in DM and group calls (encrypted like
  the audio); a camera is downloaded only while a tile shows it, at that tile's size
  (simulcast). Hearing a voice channel needs Listen (2026-10-05; everyone has it
  by default), enforced by LiveKit like Speak. Stream quality (2026-10-07): the sharer picks
  resolution and frame rate before going live (Discord's choices, no paid tier); global admins
  can cap both, kept by the client only (LiveKit can't cap a track's bitrate). Screen shares keep
  LiveKit's simulcast (a half-size copy); viewers choosing it isn't built yet.
- **Android app** (built 2026-10-03, see `docs/desktop-and-site.md`): a Capacitor wrapper of the
  client, native (Java) only for notifications, ringing and the ongoing call. Closed-app pushes
  go through Firebase Cloud Messaging (Google; the only reliable way to wake an Android app,
  chosen over UnifiedPush and a permanent websocket), each encrypted for the phone, since FCM
  doesn't encrypt to the device. Previews are decrypted by the app's own page code in a hidden
  WebView (`notify.html`), not a native port of the crypto, so keys never leave the page's
  storage and there's one implementation. Since 2026-10-06 distributed through Google Play's
  closed test (voicaw.com has a form to ask to join, which admins see in Settings → Admin; see
  Info site in `docs/desktop-and-site.md`). Before that, as a signed APK from updates.voicaw.com
  (2026-10-03), which updates itself from there, downloading only when asked (2026-10-04; the
  `play` build flavour never does, as Play requires), still published there for those copies.
  Open to everyone on Play after the closed test (12 testers for 14 days; the privacy policy,
  terms and account-deletion page are on voicaw.com, and blocking, reports and suspensions in
  the app, 2026-10-05).
- **Bots** (built 2026-10-03, see `docs/bots.md`): Discord's API, library-compatible (discord.js
  and discord.py work with URL changes), guilds (never in people's DMs, group DMs or calls: they're
  end-to-end encrypted, and bots have no keys; bot DMs, 2026-10-06, are their own unencrypted
  kind, see Bot DMs in `docs/bots.md`), no privileged intents, anyone can make
  applications. Guild actions are functions shared by the app's routes and the bot API (they
  throw `ActionError`): change a rule there and bots follow it; don't re-implement one in
  `botApi.js`. Ids stay ours (not snowflakes), except @everyone (the guild's id) and categories
  (offset by 2^40). Commands and components (same day): buttons, selects and forms, slash and
  context-menu commands, interactions over the gateway only (no outgoing requests to bots'
  URLs), ephemeral replies kept only in memory and the person's open app, as Discord does.
  Voice (2026-10-05): bots join with LiveKit's SDKs and a token from the bot API, audio only;
  hearing is its own permission, Listen (people have it through @everyone, which never gives it
  to a bot; LiveKit enforces it), and listening bots show an ear. A Discord-compatible voice
  bridge was deferred (big: voice websocket, UDP, re-encoding, maybe Discord's DAVE).
- **Login with Voicaw** (built 2026-10-06, see `docs/bots.md`): Discord's OAuth2 code grant for
  applications' websites (first for slotto, a Discord games site being moved over), so sites
  only change URLs. Only `identify` (id, username, display name, picture); tokens and secrets
  stored as hashes; people remove sites in Settings → Authorised apps.
- **Bot DMs** (built 2026-10-06, see `docs/bots.md`; first for slotto's game reminders, a
  Discord games site being moved over): a bot and one person it shares a guild with, as
  Discord's DM channels, deliberately NOT end-to-end encrypted (bots have no keys) and kept
  apart from people's encrypted DMs; said so on every one and in the privacy policy. People
  can block bots, turn bot DMs off (Settings → Content, on by default) and delete a
  conversation for both sides.
- **Voice channels' chat** (built 2026-10-06, see `docs/guilds.md`): as in Discord, every voice
  channel is also a permanent chat for anyone who can see it, in the call or not (not only
  those connected); a side panel toggled from the header (`?chat=1`), no threads.
- **Voice channel settings and regions** (built 2026-10-07, see Channel settings and Voice
  regions in `docs/voice-and-calls.md`): after "low quality" reports (LiveKit's default was
  48 kbps), voice channels have Discord's bitrate (8–384 kbps, default 64), user limit and
  region. Global admins add regions (more LiveKit servers, a flag and a name; secrets in the
  database, never shown again) in Settings → Admin; `.env`'s LiveKit is the built-in "Main".
  Automatic means the admin's default region (decided: not Discord's nearest-to-first-joiner),
  calls use the default too. A channel moving region makes its people's apps rejoin there.
- **Link previews** (built 2026-10-05, see Link previews in `docs/messages.md`): guilds' page
  previews are fetched by the server (`safeFetch.js`: public addresses only); encrypted
  chats never send links to the server: there links straight to a picture or video show it,
  loaded by the reader, and since 2026-10-07 the sender's desktop or Android app makes page
  previews itself (as Signal does; the site sees the sender's IP address) and sends them
  encrypted beside the message, bound to it (and signed in groups). The web app can't (browsers
  can't read other sites' pages) and deliberately doesn't ask the server instead. Pictures load
  from the sites (not proxied); Settings → Privacy can hold them back (on by default), Settings →
  Admin can stop the server's fetching.
- **Events** (built 2026-10-05, see Events in `docs/guilds.md`): Discord's scheduled events
  (Discord has no calendar), in a voice channel or somewhere else, with covers, Interested and
  Discord's repeat rules laid on the creator's time zone's wall clock. Every event starts on its own
  at its time (2026-10-06; Discord's voice events wait for Start), and what's on is listed under
  Calendar in the channel list; ended and cancelled ones are deleted, repeating ones move on.
  Interested on a repeating one (2026-10-20) is for this occurrence or all of them, as Discord's.
  Occurrences (reworked 2026-10-21, as Google's and Outlook's): the series is one row and each
  date is named by its original start (links: `?event=13&on=2026-10-27`; without `on`, the
  series, opening on its next date); any date to come can be moved, renamed, cancelled or
  picked for interest, and Edit/Cancel ask this event / this and following (a new event from
  then on, old links redirected) / all events. What took place is kept a year and shown greyed
  on the calendar (the privacy policy says so). Bots still see only the series. Bots get
  Discord's scheduled-event API and gateway events. A month calendar (2026-10-06) opens from Calendar in
  the channel list, its first tab (Week the second, the list the third), made from the same events (repeats laid out by a client copy of the
  server's stepping); events can be made on a day of it. A Week tab (2026-10-09, as Guilded's) shows the chosen day's week as
  hours, events made by clicking one. All-day events, an emoji and a colour (2026-10-06) are the
  app's own, not in the bot API. Guilded's calendar channels and RSVPs
  are planned next, on the same tables.
- **TURN on 443** (built 2026-10-14, see TURN in `docs/voice-and-calls.md`): for networks that
  allow only the web (no UDP 7882, no TCP 7881; Discord's voice fails there too), LiveKit's own
  TURN over TLS on 443, sharing the port with nginx's sites by TLS name (nginx `stream` +
  `ssl_preread`, `server/scripts/turn-443.sh`; the sites moved to 127.0.0.1:8443 with the PROXY
  protocol). Chosen over a second IP. A fallback only: browsers use it when nothing direct works.
- **Watch Together** (built 2026-10-04, see `docs/voice-and-calls.md`): YouTube watch parties in
  guild voice channels, the server keeping the queue and the clock in memory, clients following
  it. YouTube's iframe API script is deliberately not loaded (it would run YouTube's code next to
  the keys): `voice/youtubeEmbed.js` speaks the embed's messages itself. Permissions Queue
  Videos and Control Playback (defaults) and Manage Queue (not). Search (2026-10-06): the server
  asks YouTube's own keyless search endpoint (InnerTube; undocumented, may break: then only
  links work, and the Data API with a key is the fallback), so YouTube never sees who searched.
- **Media servers in Watch Together** (built 2026-10-23, see Media servers in
  `docs/voice-and-calls.md`): a guild's own Jellyfin or Emby, connected in Guild Settings →
  Watch Together with an account's login (only the token kept; administrators refused). The
  user chose: viewers stream straight from the media server (no bandwidth through our host; it
  sees their IP addresses, and the token reaches them, so a restricted account), the media
  server transcodes what browsers can't play (HLS, one transcode per channel), public https
  addresses only (no home-network servers).
- **Open polls** (built 2026-10-06, see Polls in `docs/messages.md`): anyone adds answers, each
  a reaction from whoever added it (not a table: reactions already have the encryption, group
  signing and delivery, and the server still can't tell which messages are polls), so
  encrypted reactions are padded to 256 bytes. Its creator, the poll's author or a guild
  moderator removes one nobody else voted for; a new question drops every vote and added
  answer. Polls take 20 answers.
- **The + panel** (built 2026-10-07, see The + panel in `docs/uploads.md`): on phones the
  + button opens Discord's panel (camera, a grid of recent photos, then Photos / Poll / Thread /
  Files); computers keep the menu, which gained Create thread. The grid is the Android app's
  only (web pages can't list a phone's photos) and needs `READ_MEDIA_IMAGES`/`_VIDEO`, which
  Google Play only allows after a declaration (chosen over the system photo picker alone;
  Google accepted it, 2026-10-09). The gallery never
  leaves the phone; only picked files are read by the page.
- **Levels** (built 2026-10-07, see Levels in `docs/guilds.md`): Guilded's XP per guild, off until
  a guild turns it on (decided the same day); the guild (Manage Guild) chooses what earns XP and how much (messages, replies and
  reactions received on by default; mentions, reacting, threads, documents, tasks, voice minutes
  off), XP per level (linear; 1 = levels only, XP never shown), its own names for XP, levels and
  the member list's short badge ("12 lvl"), or turns it off again. Manage Levels (not a default) sets
  or adds to anyone's XP or level, mainly for bots (bot API `/guilds/:id/levels...` and a
  `GUILD_MEMBER_LEVEL_UPDATE` gateway event). Bots never earn XP; XP is kept when someone leaves.
- **Reaction notifications** (built 2026-10-07, see Reaction notifications in `docs/realtime.md`):
  as Discord's, the author is told when someone reacts (Settings → Notifications: everywhere by
  default, DMs and groups only, or never). In encrypted chats the server can't tell a poll vote
  from an emoji and a browser must show every push, so a notification there could be wrong
  ("reacted" for a vote); the user chose none over wrong ones: those go only to the desktop and
  Android apps, which open the reaction and show nothing for a vote. Browsers get guild ones only.
- **Join log** (built 2026-10-07, see Join log in `docs/guilds.md`): Discord's join messages in
  a text channel the guild picks (off by default), plain "X joined the guild.", and leaves too
  if the guild ticks it. Kicks and bans read "left" like leaving, so the channel doesn't show
  moderation (the audit log does). Bots see it as `system_channel_id` (read only) and type 7.
- **Desktop splash and installer** (built 2026-10-08, see Splash window and Windows installer in
  `docs/desktop-and-site.md`): Discord-like, not a copy. The app starts in a splash window that
  installs any update before opening (the user chose this over updating only in the background;
  "Start anyway" after 10 s), and the Windows installer is restyled to match (NSIS, since
  electron-updater doesn't do Squirrel).
- **Big files** (built 2026-10-08, see Big files in `docs/uploads.md`): attachments up to
  500 MB everywhere (was 100), Settings → Admin's File size limit (500/250/100/50/25 MB). No file
  is ever whole in the page: every file is sent chunked (`v=2`, videos' format), encrypted part
  by part as an S3 multipart upload (each request under nginx's 100M), and big ones are saved
  as they're decrypted (service worker download, the desktop app's Save dialog, Android's
  Downloads). The user chose: no resuming after a reload (failed parts retry while open), no
  per-account storage quota for now. Bots keep Discord's 25 MB by default (Settings → Admin's Bot
  file size limit raises it, 2026-10-16). No re-encoding of videos.
- **Voice messages** (built 2026-10-09, see Voice messages in `docs/uploads.md`): as Discord's.
  Phones hold the mic in Send's place (empty box only; slide left cancels, up locks), computers
  start one from the + menu (Discord's desktop can't record; ours can, with Stop to listen first).
  An ordinary encrypted attachment sent as its own message, with `vm=1`, its length and a
  64-byte waveform in the URL fragment (inside the encryption in DMs and groups), so the server
  needed no change but guild pushes' wording. Can't be edited. Up to 20 minutes, recorded with the
  browser's own noise suppression, not the call chain. Bots see a guild one as a plain link in
  the content (no Discord voice-message flags yet).
- **Two-factor** (built 2026-10-09, see Two-factor authentication in `docs/auth-and-encryption.md`):
  optional (off by default), authenticator-app codes (TOTP) and ten backup codes, as Discord's.
  With it on, a password alone gets no session and no key backup, and recovery-code resets need a
  code too. No SMS or email codes (the app has neither). Turning it on needs the password and a
  code; an admin on the host can turn it off for someone who lost everything (`npm run admin`).
- **Group pictures** (built 2026-10-09, see Group pictures in `docs/group-dms.md`): any member
  sets one, cropped like a profile picture, end-to-end encrypted like the name: cut and shrunk on
  the device (256 px WebP, GIFs become still), encrypted with its own key, which rides in the
  group's signed name record (so it follows the name into every epoch). The name record grew
  to 768 bytes for it, so group pushes keep 1450 characters for the message (was 1800).
- **Edit history** (built 2026-10-09, see Edit history in `docs/messages.md`): every edited
  message keeps its earlier versions, for everyone who can see it (DMs and groups as the
  ciphertext they were; guilds plain); deleting the message deletes them. People's edits only:
  bots' and webhooks' aren't kept. Editing no longer takes text back (the privacy policy says so).
- **Search in encrypted chats** (built 2026-10-09, see Search in encrypted chats in
  `docs/messages.md`): DMs, group DMs and notes are searched on the device, in guild search's box
  (no `in:`). Light on memory: an AES-GCM-encrypted copy of each searched chat in IndexedDB
  (segments of ~200 messages; the key is non-extractable and made on the device), read a few
  segments at a time; edits and deletes found by asking the server for per-range counts (never
  which messages matched). Settings → Privacy can keep no copy (each search then reads the
  whole history again); logging out deletes it.
- **Offline copy** (built 2026-10-14, see Offline copy in `docs/messages.md`): DMs, group DMs
  and notes the device has shown are kept on it (decrypted text and reactions, re-encrypted under
  a non-extractable device key, as the search copy), plus the lists the app needs (profile, DM
  list, groups...), so they can be read without a connection. The user chose: on by default,
  only the encrypted chats (no guild channels or bot DMs), text only, read-only (nothing queued
  to send). Online nothing changes but the saving; the copy is only read when the server can't be
  reached (offline mode when the app starts that way). Settings → Privacy → Storage on this
  device shows sizes, turns it off, clears it; logging out deletes it with everything else the
  account kept here (not contact pins, which warn of changed keys).
- **Rich Presence** (built 2026-10-09, see Rich Presence in `docs/desktop-and-site.md` and
  Activities in `docs/realtime.md`): the desktop app listens on Discord's local `discord-ipc-N`
  socket, so games' "Playing X" reaches Voicaw unchanged (a Discord started first keeps them).
  Never asks Discord (the user's choice): names and pictures come from Steam's local files and
  the program itself; games' own per-moment pictures (Discord asset keys) aren't shown, but a
  picture given as a web address (Feishin's Navidrome album covers) is downloaded by the
  player's app and shared as the small copy (never the address). A 128 px
  copy of the picture goes to the server; activities live in its memory only (but games' names
  and times, for full profiles' Activity, 2026-10-13). Shown in the
  member list (unlike custom statuses), the DM list, Friends and profile cards; "Share what I'm
  playing" in Settings → Desktop App, on by default. Bots' own activities show too. Sharing a
  screen in a guild voice channel shows "Streaming in #channel" (before games) to those who can
  see that channel only, from voice states, never for calls (2026-10-09).
- **In-game overlay** (built 2026-10-19, see In-game overlay in `docs/desktop-and-site.md`): as
  Discord's, in the desktop app, on by default (Settings → Desktop App): while in voice and a
  game runs (a Rich Presence game, or a Steam game found among the running programs), a
  click-through always-on-top window over the game shows who's there and talking, and
  notifications; its shortcut (default Ctrl+Shift+O, not Discord's Shift+\`; only taken while
  it's up) unlocks it for mute, deafen, disconnect, its corner and Open Voicaw. No injection
  into games, so exclusive full screen hides it; no text chat in it.
- **Full profiles and banners** (built 2026-10-13, see Full profiles and Banners in
  `docs/client.md`): Discord's. A card's picture or names open a full profile (a phone skips
  the card: a full-screen sheet, swiped down to close) with tabs About me, Activity, Mutual
  friends, Mutual guilds; the picture opens in the image viewer. Banners are a picture (5:2,
  unencrypted like pictures) or a colour. Activity is the games played over the last 30 days:
  saved on the server (names and times only, 30 days; a month's history was asked for, and it
  has to reach other people's apps), the only activity data that is. Each tab can be hidden (Settings → Privacy, shown by default);
  hiding Activity stops recording it and deletes it. Your own profile is edited in place, and
  replaced Settings' Edit Profile page (Settings, the user menu and `/settings/profile` open it).
- **Other servers** (built 2026-10-17, see Other servers in `docs/client.md`): the login screen
  can point the app at another Voicaw server (checked through its `/api/config`), the first step
  towards federation. No server-to-server traffic yet: people only reach others on their own
  server. Data the device keeps across logins (contact pins, volumes) is keyed per server, since
  user ids repeat between servers; changing server forgets the login and reloads. Federation
  plan when it comes: `user@host` addresses, signed server-to-server requests, 1:1 DMs between
  allow-listed servers first, group DMs later.
- **Custom emoji** are per guild and unencrypted (like profile pictures). As in Discord, a guild's
  members can use them anywhere, DMs included; unlike Discord, no paid tier is needed for that.
- **Everyone sees everyone** once logged in (the app is for groups who know each other); only
  logged-out visitors, and accounts still waiting for an admin's approval (sign-ups, 2026-10-05),
  must not learn usernames. Pending accounts are hidden from everyone else too. Friends
  (2026-10-07) don't change that: `/dms-list` is still everyone (the app's directory of names
  and keys); friends only decide who the DM list shows.
- **Friends** (built 2026-10-07, see Friends in `docs/client.md`): as Discord's. The DM list shows
  friends and people you have a conversation with; requests by username or from a profile card;
  group DMs are made from friends. DMs don't need friendship (guild members meet there).
  Migration 14 made everyone who had an account then friends with everyone else. Admins get an
  Everyone tab on the Friends page listing every account.
- **Known issues:**
  - Keycap emoji (1️⃣) and Unicode 15.1+ emoji (🙂‍↔️) show in the system font while typing
    (digits are kept out of the Twemoji font; 15.1 isn't in Twemoji 15).
  - The Playwright WebKit build crashes opening the emoji picker (see `e2e/README.md`); real
    iPhones are fine (the web app in Safari, tested by a friend of the user, 2026-10-13).
  - Spellcheck draws its own underlines only in the editors (message box, documents): plain
    text boxes (titles, bio, task fields) keep the browser's, which can disagree with our
    suggestions there. Our dictionaries are English only (UK, US); other languages fall back
    to the browser's (or the desktop app's) own checker.
  - npm 11 warns that the install script of `esbuild` isn't in an `allowScripts` list yet. It
    still runs today; a future npm will need it approved (`npm install-scripts approve`).
