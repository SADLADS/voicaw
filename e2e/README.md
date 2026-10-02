# Browser checks (real Chrome, throwaway server)

Unit tests can't see layout, scrolling, focus, touch or the editor. For those, `e2e/` runs the
real app against a throwaway API (in-memory database, fresh secrets, rate limits off, and a
stand-in object store in memory, so uploads, profile pictures and emoji work; it serves byte
ranges like MinIO and lists what was read at `/__reads`) and drives it with Playwright (`playwright-core`, using the system Chrome
at `/usr/bin/google-chrome`, or `CHROME_PATH` elsewhere, headless; the harness also runs on
Windows, without voice unless `LIVEKIT_BIN` points at a LiveKit):
```
node e2e/serve.mjs &     # web :5199, API :3099, object store :3100, LiveKit :3101-3103;
                         # E2E_WEB/API/S3/LIVEKIT_PORT
node e2e/smoke.mjs       # two users, one message delivered live; an example to copy
node e2e/guilds.mjs [dir] # guilds end to end (desktop + phone); screenshots into dir
node e2e/roles.mjs [dir]  # roles, colours, private channels, channel permissions
node e2e/auditlog.mjs [dir] # audit log: mod deletes a message, role change, details, filters, no access, phone
node e2e/emoji.mjs [dir]  # custom emoji (upload, picker, :name:, reactions, DM), rail order
node e2e/emojisheets.mjs [dir] # picker sprite sheets: no per-emoji SVGs, time to draw (cold, worker's copy), skin tone sheet, phone
node e2e/voice.mjs [dir]  # voice: join, hear, speaking ring, mute/deafen, phone, leave
node e2e/rejoin.mjs [dir] # voice after a lost connection: Reconnecting, rejoins by itself, phone waits until back in view, leave stays left
node e2e/screenshare.mjs [dir] # screen share: own preview, Live, no download until Watch, phone watches, Video taken away
node e2e/calls.mjs [dir]  # DM calls: ring, answer, encrypted (asks LiveKit), mute, decline, phone
node e2e/groups.mjs [dir] # group DMs: create, add (no old messages), remove, group call, owner leaves
node e2e/presence.mjs [dir] # online status: idle, mobile, no flicker on reload, last seen
node e2e/notes.mjs [dir]  # notes: row under the header, send, pin, reload, not leaked to/from DMs, phone login
node e2e/recovery.mjs [dir] # change password, recovery code reset, new code, code on old login
node e2e/spoilers.mjs [dir] # spoiler images: mark in tray, blurred for both, tap/click reveals, reply preview
node e2e/mentions.mjs [dir] # @ suggestions, highlight, badges, @everyone, roles, private channel, notify level
node e2e/mutes.mjs [dir]  # muted channels: right-click mute, dimmed, no unread (mentions still count), header bell unmutes, phone
node e2e/channelmenu.mjs [dir] # channel/category menus: read, mute, notify level, copy link, duplicate, delete, keys, edge; phone hold = sheet, hold+move = drag
node e2e/menus.mjs [dir]  # browser menu off (kept in text boxes, message links); guild icon menu, channel list empty space, DM list pin/mute (no ping, no dot); phone sheets, rail hold+move drags
node e2e/channel-mentions.mjs [dir] # # suggestions, #channel links (click opens), private = unknown, edit, DM, phone
node e2e/pins.mjs [dir]   # pins: DM (list, jump into unloaded history), guild permission, group, phone
node e2e/invites.mjs [dir] # invite embeds: channel and DM (load at once), Join Guild, Settings → Privacy off = Show first, phone
node e2e/webhooks.mjs [dir] # webhook made in the UI, posted to like Discord (embed, files), edit/delete, phone
node e2e/search.mjs [dir] # guild search: from:/in:/has:/mentions: suggestions, results, Jump into another channel, private channel, phone
node e2e/days.mjs [dir]   # day dividers between days and above the first message (desktop + phone)
node e2e/panes.mjs [dir]  # phone: swipe list <-> chat (flick, slow drag, vertical scroll), back button, guild
node e2e/account.mjs [dir] # delete account: owned guild blocks until ticked, logged out, "Deleted User" for contacts, phone
node e2e/desktop.mjs [dir] # desktop app page side (stand-in bridge): notifications, badge, shortcuts, settings
node e2e/lists.mjs [dir]  # list channels: add, subtask, drag to nest/reorder, assign, due date, comments, read-only, phone
node e2e/docs.mjs [dir]   # document channels: write (typed markdown, toolbar, checklist, table, cover), card live, react (page and card), reply thread, edit live, phone tabs
node e2e/polls.mjs [dir]  # polls: + menu, emoji, Vote (phone), results, who voted, edits, duration, end early + result rows (DM, guild, group)
node e2e/embedperf.mjs [n] [dir] # speed: channel of n webhook embeds with big posters; open/hover/scroll timings, CPU profile with PROFILE=<prefix>
node e2e/video.mjs [dir]  # videos: only the poster before Play, streamed in pieces, seek reads nothing before it, download, keys, full screen, spoiler, phone (needs ffmpeg)
node e2e/voicesettings.mjs [dir] # Settings → Voice & video: fake devices listed, mic test meter, input volume 0 silences you in a call, new mic / each noise suppression kept, speakers + output volume, phone
node e2e/uservolume.mjs [dir] # per-user volume: channel list / tile / call panel, measured 100/200/0%, deafen, kept after reload, phone sheet
node e2e/noise.mjs [dir]  # noise suppression + gate: each mode on a made-up recording (fan, clicks, voice) measured, DeepFilterNet speed, sensitivity by hand, Strong in the mic test, phone
node e2e/sounds.mjs [dir] # sounds: Settings → Sounds, play buttons, mute/deafen, Message in another chat (not the open one, not when off), phone
node e2e/sidebar.mjs [dir] # one sidebar width (DM list, channels, Settings), headers line up, drag/keys/reset, kept; phone untouched
node e2e/themes.mjs [dir] # light/dark: Settings → Appearance, at once, kept per device, no dark flash, Match system, color-scheme, phone
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
Never use port 3002 (the live API) or 7880-7882 (the live LiveKit); `serve.mjs` refuses them
(and 5173, Vite's default). Kill test
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
- **The real desktop app** runs here under Xvfb (installed): build the client for it pointed at
  the throwaway API (a temporary, git-ignored `client/.env.electron` with
  `VITE_API_BASE_URL=http://localhost:<api>/api/` and `VITE_WS_URL=ws://localhost:<api>`; delete
  it after), start `Xvfb :97 -screen 0 1600x1000x24`, then with `DISPLAY=:97` and
  `XDG_CONFIG_HOME=<scratch dir>` (its own settings and session) run the binary itself,
  `node_modules/electron/dist/electron electron/main.js --no-sandbox --remote-debugging-port=9333`,
  and drive it with `chromium.connectOverCDP('http://127.0.0.1:9333')` (the page is
  `voicaw://app/`). Traps: `node_modules/.bin/electron` is a wrapper, so killing its PID leaves
  Electron running, and the single-instance lock then makes every new start quit at once
  (check for leftovers with `pgrep -af electron/dist/electron` and kill them by PID); Chrome's
  `--use-fake-ui-for-media-stream` / `--use-fake-device-for-media-stream` take over screen
  capture and skip the app's display media handler, so don't pass them when testing screen
  sharing (without them the microphone just fails, and you stay in voice muted); Xvfb has no
  window manager, so only screens are listed, no windows.
