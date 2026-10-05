# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Voicaw is a Discord-style chat web app: end-to-end encrypted direct messages and group DMs
(with calls), and guilds
(Discord-style servers, always called guilds in the app: text, voice, list (task board)
and document channels, threads, roles and private channels; not encrypted, see `docs/guilds.md`),
with bots that use Discord's API (`docs/bots.md`). It's an npm workspaces monorepo with
four packages: `client` (React/Vite SPA, also packaged as an Electron desktop app and an
Android app), `server` (Express + ws API), `electron` (the desktop app: the built client plus
notifications, tray, shortcuts and updates) and `mobile` (the Android app, Capacitor: the built
client plus notifications and ringing while closed, call buttons, calls with the screen off);
see `docs/desktop-and-site.md`.

## Working on Voicaw (read first)

Each feature is worked on in its own chat, on its own branch, in its own worktree. The rules:

- **`dev` is the deploy branch, deployed by hand.** The live API (pm2 `voicaw-api`, :3002, with
  the real database) runs from `/home/otto/git/voicaw`, checked out on `dev`. Nothing deploys a
  push any more: the GitHub webhook and the test.voicaw.com dev server (pm2 `voicaw-test`) were
  removed on 2026-10-02. After a merge, the API is updated with `git pull` there (`npm install`
  if the lockfile changed) and `pm2 restart voicaw-api`, only when the user asks. The web app at
  app.voicaw.com is a static build in `/opt/voicaw-client`, only updated by running `npm run
  build` by hand; voicaw.com is the info and download site (`website/`, `/opt/voicaw-site`, see
  `docs/desktop-and-site.md`). Voice runs on a self-hosted LiveKit server, pm2 `voicaw-livekit` (`~/livekit`, not
  in git).
- **Never commit to, merge into, push, reset or otherwise move `dev`.** Branch off it
  (`feature-name`), commit there; the user reviews and merges. Don't push branches unless asked.
- **Never work in `/home/otto/git/voicaw`.** It's the live checkout: the API runs from it, so
  switching its branch changes what the next restart serves. Use a worktree per feature:
  ```
  git -C ~/git/voicaw worktree add ~/git/voicaw-<feature> -b <feature> dev
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
- `npm run dist:android` — the client's Android build, `cap sync`, then the APK (and the native
  JUnit tests) in Docker (`mobile/dist-android.sh`) into `dist-android/voicaw-debug.apk`;
  `./build-android.sh [patch|minor|major|X.Y.Z]` releases: next version, APK signed with the
  release key (`~/.voicaw-android-keys`, `mobile/make-release-key.sh`), published to
  updates.voicaw.com/android/ and voicaw.com (`updates/publish-android.mjs`); `--no-publish`,
  `--debug`; stops without `google-services.json` (`--no-push` builds without). Each release
  also builds `dist-android/voicaw-<version>-play.aab` for the Play Console (uploaded by hand).
  Publishing touches the live sites: only when the user asks

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
- `docs/auth-and-encryption.md`: OPAQUE login, sessions and Settings → Devices, rate limits, sign-ups (open, invite
  only, admin approval), deleting an account,
  end-to-end encryption (keys, backups, recovery code, contact pinning, DMs, reactions, notes,
  the spellcheck dictionary).
- `docs/realtime.md`: websocket events, online status, web push.
- `docs/guilds.md`: guilds (permissions, overrides, audit log, invites, custom emoji, channel
  menus, NSFW channels), threads, list channels, document channels, guild search, webhooks (Discord's API).
- `docs/voice-and-calls.md`: voice channels (LiveKit, reconnecting, screen sharing, microphone
  chain, noise suppression, voice settings, playback and per-user volume, Watch Together), DM and
  group calls.
- `docs/group-dms.md`: group DMs (membership log, epochs, signing).
- `docs/messages.md`: emoji, message markdown, GIFs, YouTube links, polls, mentions, pinned messages, drafts, the
  message list and history loading.
- `docs/uploads.md`: the object store, encrypted attachments, video streaming, spoilers, image
  viewer.
- `docs/client.md`: client structure (contexts, translations, Layout, settings, dates, themes, sidebar, phone
  panes, PWA updates, spellcheck, right-click menus, pinned and muted conversations, account preferences),
  profiles and pictures, sounds, admin settings.
- `docs/desktop-and-site.md`: the Electron app, the Android app (FCM, ringing, ongoing call),
  voicaw.com.
- `docs/bots.md`: bots: applications and bot users, the developer portal, adding bots to guilds,
  Discord's REST API (`/api/v10`) and gateway (`/api/gateway`), ids and permission bits,
  slash and context-menu commands, buttons, selects, forms and ephemeral replies.

## Rules that apply everywhere

- **Guilds** are always "guilds" in the app and its code; "server" means the app's own server.
- **Encrypted chats** (DMs, notes, group DMs): the server stores and relays only ciphertext and
  is untrusted. Never use a contact's key straight from the server (`contactKeys.js`
  `checkContactKeys`); every format is versioned (`v1.`, `{v:1}`, `voicaw/<purpose>/v1`). Anything
  that lets a third party (Klipy, another site's images...) see something, say so in the docs.
- **Privacy policy** (`website/src/legal/privacy.html`, voicaw.com/privacy/; also the terms and
  `delete-account.html`): every claim matches the code. A change to what's stored, kept for how
  long, encrypted or not, deleted with an account, or seen by a third party updates it in the
  same branch, with its date in `website/build.mjs` `LEGAL`.
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
  pictures with `Avatar`, never `user.username` or a hand-built URL. Dates and times through
  `utils/dateFormat.js`, never `toLocaleString`. CSS uses the `--vc-*` colour tokens (both
  themes), not literal colours; scrollbars are styled only in `voicaw.css`; desktop and phone
  layouts are `desktop.css` / `mobile.css`; new sidebar/header UI uses `--vc-sidebar-width` and
  `--vc-header-height`, and anything screen-high `--vc-app-height` (never 100vh/svh: it
  ends at a phone's keyboard). react-markdown's `components` must be a stable object, and memoised
  message parts take only stable props. New settings are a section in `Settings.jsx`. The app's
  text is British English, and every string shown goes through `t('area.key')` with its
  English in `i18n/en-GB/<area>.json` (see Translations in `docs/client.md`; lint fails on
  text written straight into JSX). Write new text in English only: Russian (`i18n/ru/`) is
  translated in batches when the user asks, and shows English until then.

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
  text). DM calls are (LiveKit's E2EE with a per-call key sent inside the DM encryption). The microphone
  path is a Web Audio chain (capture with echo cancellation → input volume → noise
  suppression → gate → published track). Krisp needs LiveKit Cloud or a licence, so it's out:
  noise suppression is RNNoise by default and DeepFilterNet as Strong (decided 2026-10-01),
  both running on the device. Hearing a voice channel needs Listen (2026-10-05; everyone has it
  by default), enforced by LiveKit like Speak.
- **Android app** (built 2026-10-03, see `docs/desktop-and-site.md`): a Capacitor wrapper of the
  client, native (Java) only for notifications, ringing and the ongoing call. Closed-app pushes
  go through Firebase Cloud Messaging (Google; the only reliable way to wake an Android app,
  chosen over UnifiedPush and a permanent websocket), each encrypted for the phone, since FCM
  doesn't encrypt to the device. Previews are decrypted by the app's own page code in a hidden
  WebView (`notify.html`), not a native port of the crypto, so keys never leave the page's
  storage and there's one implementation. Distributed as a signed APK from updates.voicaw.com
  (2026-10-03), which updates itself from there, downloading only when asked (2026-10-04; the
  `play` build flavour never does, as Play requires); Google Play planned once the user's developer account is verified (needs a
  12-tester closed test for 14 days and report/block for user content first; the privacy
  policy, terms and account-deletion page are on voicaw.com, 2026-10-05).
- **Bots** (built 2026-10-03, see `docs/bots.md`): Discord's API, library-compatible (discord.js
  and discord.py work with URL changes), guilds only (never in DMs, group DMs or calls: they're
  end-to-end encrypted, and bots have no keys), no privileged intents, anyone can make
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
- **Watch Together** (built 2026-10-04, see `docs/voice-and-calls.md`): YouTube watch parties in
  guild voice channels, the server keeping the queue and the clock in memory, clients following
  it. YouTube's iframe API script is deliberately not loaded (it would run YouTube's code next to
  the keys): `voice/youtubeEmbed.js` speaks the embed's messages itself. Permissions Queue
  Videos and Control Playback (defaults) and Manage Queue (not).
- **Custom emoji** are per guild and unencrypted (like profile pictures). As in Discord, a guild's
  members can use them anywhere, DMs included; unlike Discord, no paid tier is needed for that.
- **Everyone sees everyone** once logged in (the app is for groups who know each other); only
  logged-out visitors, and accounts still waiting for an admin's approval (sign-ups, 2026-10-05),
  must not learn usernames. Pending accounts are hidden from everyone else too.
- **Known issues:**
  - Keycap emoji (1️⃣) and Unicode 15.1+ emoji (🙂‍↔️) show in the system font while typing
    (digits are kept out of the Twemoji font; 15.1 isn't in Twemoji 15).
  - The Playwright WebKit build crashes opening the emoji picker (see `e2e/README.md`); not yet
    checked on a real iPhone.
  - nginx doesn't compress JS/CSS/SVG (`gzip_types` is commented out in
    `/etc/nginx/nginx.conf`); first visits download the 1.7 MB main bundle uncompressed,
    Strong noise suppression's 17 MB (10 MB compressed) WebAssembly whole, and spellcheck's
    550 KB dictionary (about 200 KB compressed) the first time an editor opens.
  - Spellcheck draws its own underlines only in the editors (message box, documents): plain
    text boxes (titles, bio, task fields) keep the browser's, which can disagree with our
    suggestions there. Our dictionaries are English only (UK, US); other languages fall back
    to the browser's (or the desktop app's) own checker.
  - npm 11 warns that the install script of `esbuild` isn't in an `allowScripts` list yet. It
    still runs today; a future npm will need it approved (`npm install-scripts approve`).
