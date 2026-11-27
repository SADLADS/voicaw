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
  is no longer used). **Since 2026-11-16 everything live runs on a DigitalOcean Droplet**
  (`ssh voicaw-do`, 167.99.202.4, Debian 13, user `otto`; planned as a stay of about a month): the
  API, LiveKit, Garage (the object store, README 4b), nginx and the static sites, with the same
  paths as below. The old host's `voicaw-api`, `voicaw-livekit` and MinIO are stopped or idle
  there; don't start them (their database is out of date). The live API (pm2 `voicaw-api`, :3002, with
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
  in the fitting `docs/` file, or a new file listed below; a decision the user made gets a
  dated entry in `docs/decisions.md`). When a change affects how a new host is set up (a new env
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
- `docs/auth-and-encryption.md`: OPAQUE login, the login cookie, sessions and Settings → Devices, two-factor, rate limits, sign-ups (open, invite
  only, admin approval), deleting an account,
  end-to-end encryption (keys, backups, recovery code, contact pinning, DMs, reactions, notes,
  the spellcheck dictionary, emoji usage).
- `docs/realtime.md`: websocket events, online status, web push.
- `docs/guilds.md`: guilds (permissions, overrides, category permissions, audit log, invites, custom emoji, channel
  menus, NSFW channels), threads, list channels, document channels, events (scheduled, repeating),
  guild search, webhooks (Discord's API).
- `docs/voice-and-calls.md`: voice channels (LiveKit, reconnecting, screen sharing, microphone
  chain, noise suppression, voice settings, playback and per-user volume, Watch Together), DM and
  group calls.
- `docs/group-dms.md`: group DMs (membership log, epochs, signing).
- `docs/messages.md`: emoji, message markdown, GIFs, YouTube links, link previews, polls, mentions, timestamps, forwarding, pinned messages, drafts, messages that couldn't be sent,
  search in encrypted chats (on the device), the offline copy, the message list and history
  loading.
- `docs/uploads.md`: the object store, encrypted attachments, video streaming, voice messages, spoilers, the EPUB reader, the PDF
  reader, image viewer.
- `docs/client.md`: client structure (contexts, translations, Layout, settings, dates, themes, errors and the connection strip, sidebar, phone
  panes, PWA updates, spellcheck, right-click menus, pinned and muted conversations, account preferences),
  other servers (the login screen's Server),
  profiles and pictures, sounds, admin settings, blocking, reports and suspensions.
- `docs/desktop-and-site.md`: the Electron app, the Android app (FCM, ringing, ongoing call),
  voicaw.com.
- `docs/decisions.md`: why things are the way they are, one dated entry per feature (what the
  user chose and what was dropped), and the known issues. Read the entries for your area first.
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
  `utils/dateFormat.js`, never `toLocaleString`. Errors shown through `utils/errors.js`
  (`errorText`, and `ErrorState` / `InlineError` / toasts), never `err.message` or the
  server's `error` written in directly (see Errors in `docs/client.md`). CSS uses the `--vc-*` colour tokens (every
  theme), not literal colours. **Themes** (Dark, Light, Ol' Familiar, Halloween, Christmas,
  Slack; `voicaw.css`, see Themes in `docs/client.md`): a feature that needs a new colour token
  adds it to every theme's block, with a value that suits that theme (`themeTokens.test.js`
  fails otherwise), and new UI is looked at in each theme, light ones especially. A new part of
  the left side or the top bar joins Slack's aubergine block's selector; scrollbars are styled only in `voicaw.css`; desktop and phone
  layouts are `desktop.css` / `mobile.css`; new sidebar/header UI uses `--vc-sidebar-width` and
  `--vc-header-height`, and anything screen-high `--vc-app-height` (never 100vh/svh: it
  ends at a phone's keyboard). react-markdown's `components` must be a stable object, and memoised
  message parts take only stable props. New settings are a subsection of a page in `Settings.jsx` (see Settings in `docs/client.md`). The app's
  text is British English, and every string shown goes through `t('area.key')` with its
  English in `i18n/en-GB/<area>.json` (see Translations in `docs/client.md`; lint fails on
  text written straight into JSX). Translate as you go: any change that adds or changes English text adds
  or updates the Russian (`i18n/ru/`, with `_few`/`_many` plurals), Japanese (`i18n/ja/`,
  `_other` only) and Thai (`i18n/th/`, `_other` only) in the same branch, with the same `{{placeholders}}` and tags.

## Decisions (read `docs/decisions.md`)

Every feature's decisions (what the user chose, when and why, and what was dropped) are in
`docs/decisions.md`, with the known issues. **Read the entries for the area you're changing
before you change it**, and add or update one there (dated) whenever the user decides
something. The ones almost everything touches:

- **Encryption:** DMs, group DMs, notes and DM calls are end-to-end encrypted; the server is
  untrusted for them. **Guilds aren't** (decided 2026-09-29), nor guild voice, nor bot DMs (bots
  have no keys, so bots are never in people's DMs, groups or calls). Don't change identity keys
  or the safety-number derivation casually: every contact would get a "key changed" warning.
- **Voice** is a self-hosted LiveKit SFU (not peer-to-peer); the API only checks permissions and
  hands out short-lived tokens.
- **Bots** speak Discord's API; guild actions are functions shared by the app's routes and the
  bot API (they throw `ActionError`): change a rule there, never re-implement one in `botApi.js`.
- **Everyone sees everyone** once logged in (the app is for groups who know each other); only
  logged-out visitors and accounts awaiting approval must not learn usernames.
- **Custom emoji** are per guild and unencrypted, usable anywhere (no paid tier).
- **The web app's code**, delivered by the server, stays the unfixable gap in the encryption
  until native apps.
