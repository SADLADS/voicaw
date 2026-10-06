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
node e2e/joinemoji.mjs [dir] # joining a guild shows its custom emoji at once (picker, :name:), no reload
node e2e/pickerswipe.mjs [dir] # phone emoji panel: swipe up = full screen (follows finger, chat doesn't jump), grid scrolls, swipe down / handle = back, search from full screen
node e2e/emojisheets.mjs [dir] # picker sprite sheets: no per-emoji SVGs, time to draw (cold, worker's copy), skin tone sheet, phone
node e2e/voice.mjs [dir]  # voice: join, hear, speaking ring, mute/deafen, unmute+mute at once with a slow mic (never heard; asks LiveKit), phone, leave
node e2e/speaking.mjs [dir] # speaking ring timed against the received audio (fake mic in phrases): lights within ~30 ms, out ~300 ms after, own ring, mute = out at once, still shown deafened
node e2e/railvoice.mjs [dir] # guild rail speaker: green on yours, grey on others' (guild not opened, after reload, live), phone, light, above a mention badge, gone on leave
node e2e/links.mjs [dir] # message links: open in a new tab (target _blank), the app page stays and voice stays connected
node e2e/rejoin.mjs [dir] # voice after a lost connection: Reconnecting, rejoins by itself, phone waits until back in view, leave stays left
node e2e/watchparty.mjs [dir] # Watch Together (real YouTube, needs the internet): in step (measured in YouTube's frames), pause/seek/skip, drag the queue (Manage Queue), remove own only, moves on when a video ends, corner player on another page, channel list line, 16:9 narrow/wide, activity log (newest first, kept after the end, late joiner), phone, ends with the last
node e2e/watchsearch.mjs [dir] # Watch Together search (real YouTube): link or words in one box, other sites' links refused, results with thumbnails/lengths, Play then Add/Added, two queued from one search (Bob sees them), close, phone fits, no thumbnails with Privacy's YouTube off
node e2e/watchkeyboard.mjs [dir] # Watch Together search on a phone with the keyboard up (made up): box in view while typing (empty page's picture, people and call buttons make way; player stays), tapping Search (or Add) with the keyboard up works, search puts the keyboard away, results in view, box tapped again still shows them; nothing playing and a video on
node e2e/screenshare.mjs [dir] # screen share: own preview, Live, no download until Watch, phone watches, Video taken away
node e2e/camera.mjs [dir] # cameras: own (mirrored), tile plays at a small layer, channel list mark, nothing downloaded on another page, phone, Video taken away, off; DM call (encrypted in LiveKit, both decode), group call on a phone
node e2e/streampopout.mjs [dir] # stream pop-out: own window (styled, theme follows), plays on other pages, full screen, close/Bring back return it, Stop watching/stream end/leave close it, phone has none
node e2e/calls.mjs [dir]  # DM calls: ring, answer, encrypted (asks LiveKit), mute, decline, phone
node e2e/calllog.mjs [dir] # calls in the chat: lasted …, declined, didn't answer / missed (unread), after reload, phone
node e2e/groups.mjs [dir] # group DMs: create, add (no old messages), remove, group call, owner leaves
node e2e/groupnames.mjs [dir] # encrypted group names: API never has them, list/header/rename line, new member reads it (phone), desktop notifications decrypted
node e2e/presence.mjs [dir] # online status: idle, mobile, no flicker on reload, last seen
node e2e/notes.mjs [dir]  # notes: row under the header, send, pin, reload, not leaked to/from DMs, phone login
node e2e/recovery.mjs [dir] # change password, recovery code reset, new code, code on old login
node e2e/terms.mjs [dir]  # terms of use: sign-up needs the tick (form and server), someone who hasn't accepted sees only the terms until they agree, not asked again; phone
node e2e/spoilers.mjs [dir] # spoiler images: mark in tray, blurred for both, tap/click reveals, reply preview
node e2e/nsfw.mjs [dir]   # NSFW channels: dialog switch, header tag, age gate ("I am 18 or over": nothing loads before, kept as just the answer, not asked again), NSFW covers (image, embed, YouTube unloaded), spoiler = one cover, phone taps, Settings → Content off (account-wide, kept)
node e2e/mentions.mjs [dir] # @ suggestions, highlight, badges, @everyone, roles, private channel, notify level
node e2e/mutes.mjs [dir]  # muted channels: right-click mute, dimmed, no unread (mentions still count), header bell unmutes, phone
node e2e/channelmenu.mjs [dir] # channel/category menus: read, mute, notify level, copy link, duplicate, delete, keys, edge; phone hold = sheet, hold+move = drag
node e2e/imagemenu.mjs [dir] # picture menu: plain (copy image as PNG, copy link) vs encrypted (save, open, no link), over the viewer (Escape closes only it), phone hold in the viewer
node e2e/menus.mjs [dir]  # browser menu off everywhere (Shift keeps it); guild icon menu, channel list empty space, DM list pin/mute (no ping, no dot); phone sheets, rail hold+move drags
node e2e/channel-mentions.mjs [dir] # # suggestions, #channel links (click opens), private = unknown, edit, DM, pasted channel links (#name if you can see it, else the link), phone
node e2e/textmenu.mjs [dir] # our spellcheck + text box menu: underlines (browser's off), fixes, Add to Dictionary (encrypted on the server, back after reload), cut/copy/paste/select all, toggle, plain field suggestions, selected text, Shift; document cover/pictures menu; phone hold on the cover, no Spellcheck setting
node e2e/messagemenu.mjs [dir] # message right-click menu: quick reaction, Add Reaction picker, reply, edit, pin, copy, delete (asks; Shift skips), not on others' for edit/delete, a link gets its own (Copy/Open Link); phone hold = same actions
node e2e/hoverdelete.mjs [dir] # hover menu after Shift+delete: the next message (now under the still pointer) gets it at once, delete again without moving, none when nothing's under the pointer, a live delete above moves it with the rows
node e2e/voicechat.mjs [dir] # voice channels' chat: unread on the channel and its chat button, opened without joining (?chat=1, beside the voice page), live both ways, joined with it open, kept after a reload, phone (header button, covers the page, Back)
node e2e/threads.mjs [dir] # threads: Create Thread from a message (suggested name), panel beside the channel, live "N messages", posting joins + unread in the list, started on its own (row, Threads list), archive, phone (covers the channel, Back, long press)
node e2e/pins.mjs [dir]   # pins: DM (list, jump into unloaded history), guild permission, group, phone
node e2e/replies.mjs [dir] # reply snippet: click jumps to the message (loads older history), flashes it like search/pins, phone tap
node e2e/invites.mjs [dir] # invite embeds: channel and DM (load at once), Join Guild, Settings → Privacy off = Show first, phone
node e2e/webhooks.mjs [dir] # webhook made in the UI, posted to like Discord (embed, files), edit/delete, phone
node e2e/commands.mjs [dir] # bot commands: a bot in the script registers them (autocomplete, number, true/false, member, subcommand with choices, message command), "/" lists and filters, fields filled, suggestions, run and the reply, Apps in the message menu, phone
node e2e/bots.mjs [dir]   # bots: Settings → Developer Portal (own page), new application, token once + reset (old refused), invite link from ticked permissions, authorise into a guild (bot role), phone
node e2e/botdms.mjs [dir] # bot DMs: a bot (the script, through the bot API) DMs you with an embed, row appears live (BOT tag, unread), opened = Not encrypted + notice, no + menu, reply reaches the bot, row menu mutes (no call), Settings → Content off = bot refused (50007), Delete conversation for both, Message on a bot's member card, phone
node e2e/login.mjs [dir]  # Login with Voicaw: stand-in website on E2E_SITE_PORT (3105) logs people in like a Discord site; portal OAuth2 tab (secret once, redirects, bad one refused), logged-out visitor logs in then sees the consent card, the site trades the code and greets them, prompt=none straight back, Cancel = access_denied, unregistered redirect never followed, Settings → Authorised apps + Remove ends tokens, phone
node e2e/components.mjs [dir] # bots' buttons (every style, link, emoji, disabled) and selects (string, user): click updates the message, choice → ephemeral reply + Dismiss, form (checked, sent), deferred "thinking…" filled in, "used /menu" line; light, dark, phone (select as a sheet)
node e2e/search.mjs [dir] # guild search: from:/in:/has:/mentions: suggestions, results, Jump into another channel, private channel, phone
node e2e/days.mjs [dir]   # day dividers between days and above the first message (desktop + phone)
node e2e/panes.mjs [dir]  # phone: swipe list <-> chat (flick, slow drag, vertical scroll), back button, guild
node e2e/touchhover.mjs [dir] # phone: a finger resting on a channel/DM row then scrolling leaves no hover colour (background or link text), list scrolls; mouse hover unchanged
node e2e/youtubeviewer.mjs [dir] # phone YouTube links (real YouTube, needs the internet): thumbnail only in the chat, swipe on it moves the panes, tap = full-screen player (16:9, playing, sideways), back/X close it on the chat; inline on a computer
node e2e/keyboard.mjs [dir] # phone keyboard (made up): message box above it after swipe to reply, newest message in view, page can't scroll it away, Send keeps it up (box stays focused); Android (window shrinks) and iOS (stand-in visualViewport, slide undone)
node e2e/taphighlight.mjs [dir] # phone tap on a message: brief fade in the hover colour (not a highlight that stays), restarts on a second tap, none on a long press (stays .focused); computer hover unchanged, no flash
node e2e/swipereply.mjs [dir] # phone swipe to reply: message follows the finger with the arrow (not cut off), far enough = reply (bar, focus, sent reply quotes it), short swipe/scroll = none, right = list, no long press; none on a computer
node e2e/devices.mjs [dir] # Settings → Devices: three logins listed, log the phone out (back at login, token dead), all others, phone, logout ends the session
node e2e/signups.mjs [dir] # sign-ups: Settings → Admin → Sign-ups to approval, new account sees only the waiting page, listed live for the admin, approved = app opens by itself, declined (phone) = logged out; invite only: refused without/with a bad code, /join/<code> link fills it in and lets them in, invite used up
node e2e/account.mjs [dir] # delete account: owned guild blocks until ticked, logged out, "Deleted User" for contacts, phone
node e2e/dmrail.mjs [dir] # rail's DM button: icon, newest unread sender's picture (live, after reload), the one before once read, icon when all read, phone
node e2e/favicon.mjs [dir] # favicon dot: DM on, read = off, guild message without a mention = none, mention on (Discord's rule); dir gets the dotted icon
node e2e/moderation.mjs [dir] # block from a profile (collapsed messages, Show, DMs refused both ways, DM closed, Unblock), Report Message (guild; DM sharing its text), admin's Reports, suspend (phone logged out and told why, login refused with the reason), lift
node e2e/desktop.mjs [dir] # desktop app page side (stand-in bridge): notifications, badge, shortcuts, settings
node e2e/android.mjs [dir] # Android app page side (stand-in Capacitor bridge): no service worker, Settings → Android App, a new version offered and downloaded on Update, push registration, notification tap, notify.html decrypts a real DM, call: Answer from the notification, ongoing-call notification, its Mute and Hang up
node e2e/lists.mjs [dir]  # list channels: add, subtask, drag to nest/reorder, assign, due date, comments, read-only, phone
node e2e/events.mjs [dir] # scheduled events: three-step editor (voice, weekly, cover), Events row count, Interested live, who's interested, somewhere else needs an end, Copy Link -> card in #general -> opens it, Start = Live under the channel, End = next week, cancel, phone
node e2e/calendar.mjs [dir] # events calendar: one dialog size for both tabs and an event, + on a day = editor on that day at 18:00, weekly on the day and after, Bob's live, next month / Today, Events tab's Create Event, steps clicked at the top (stop at a missing topic), no location, all day over three days with an emoji and a colour, starts by itself and is listed under Calendar (waits a minute or two), dark, phone (dots, day list)
node e2e/docs.mjs [dir]   # document channels: write (typed markdown, toolbar, checklist, bullets and numbers shown while editing, table, cover), card live, react (page and card), reply thread, edit live, phone tabs
node e2e/uploads.mjs      # deleting files: a DM send lists its file, deleting the message (DM, guild) removes it from the store, others kept
node e2e/filedrop.mjs [dir] # files dragged in: "Upload to <chat>" over the window, drop anywhere attaches (DM, guild, document replies), leave/in-page drag/dialog = none, document cover button and body, phone
node e2e/polls.mjs [dir]  # polls: + menu, emoji, Vote (phone), results, who voted, edits, duration, end early + result rows (DM, guild, group)
node e2e/openpolls.mjs [dir] # open polls: add an answer from the vote screen (not ticked or voted), repeats refused, "added by", ✕ (vote screen only, asks; creator, author, guild moderator not on the author's), gone once others vote, new question drops all, closed = no changes (DM phone, guild, group)
node e2e/embedperf.mjs [n] [dir] # speed: channel of n webhook embeds with big posters; open/hover/scroll timings, CPU profile with PROFILE=<prefix>
node e2e/thumbnails.mjs [dir] # image thumbnails: phone downloads only the copy (upright, no EXIF; transparent stays so), viewer opens the file, Save = the file as sent; animated PNG, GIF, small image left alone (needs ffmpeg)
node e2e/video.mjs [dir]  # videos: only the poster before Play, streamed in pieces, seek reads nothing before it, download, keys, full screen, spoiler, phone (needs ffmpeg)
node e2e/voicesettings.mjs [dir] # Settings → Voice & video: fake devices listed, mic test meter, input volume 0 silences you in a call, new mic / each noise suppression kept, speakers + output volume, phone (no mic picker), names hidden before the mic is allowed (no placeholders) then shown
node e2e/uservolume.mjs [dir] # per-user volume: channel list / tile / call panel, measured 100/200/0%, deafen, kept after reload, phone sheet
node e2e/noise.mjs [dir]  # noise suppression + gate: each mode on a made-up recording (fan, clicks, voice) measured, DeepFilterNet speed, sensitivity by hand, Strong in the mic test, phone
node e2e/sounds.mjs [dir] # sounds: Settings → Sounds, play buttons, mute/deafen, Message in another chat (not the open one, not when off), the open one with another tab in front (one ding for two tabs, the service worker told), phone
node e2e/scrollbars.mjs [dir] # scrollbars: styled with a mouse, overlay only (no grabbable bar) on a phone, also in a browser without scrollbar-color
node e2e/sidebar.mjs [dir] # one sidebar width (DM list, channels, Settings), headers line up, drag/keys/reset, kept; phone untouched
node e2e/focus.mjs [dir] # opening a chat focuses its box on a computer (DM by link and from the list, guild channel, thread beside it), not another text box's focus, not on a phone
node e2e/drafts.mjs [dir] # unsent messages: back after another DM, Settings, a guild; no typing event; sent = gone; reload forgets; phone
node e2e/typing.mjs [dir] # typing indicator: DM (dots, cleared on send, clear of the last message), two typers in a guild channel on a phone, timeout, Privacy off
node e2e/colours.mjs [dir] # screenshots for colour changes: login, DM (mention, link), guild + rail, menu, Settings, list, poll, voice Join / Connecting…, incoming call; every theme (THEMES=…), desktop + phone (fresh serve.mjs per run)
node e2e/themes.mjs [dir] # light/dark: Settings → Appearance, at once, kept per device, no dark flash, Match system, color-scheme, phone
node e2e/avatar.mjs [dir] # message avatars: top with the name, bottom with the first line of text, reply line to its middle (desktop + phone)
node e2e/safearea.mjs [dir] # safe areas (CDP-made iPhone insets): user panel above the home indicator, landscape notch, unchanged without insets
node e2e/linkpreviews.mjs [dir] # link previews (stand-in website, needs ffmpeg): guild card/picture/video fetched by the server, live; Privacy off = text only, nothing asked of the site until Show/Play (phone); Remove Previews for both; DM: server fetches nothing, picture links only
node e2e/embedprivacy.mjs [dir] # Settings → Privacy YouTube/GIFs off: placeholders, nothing asked of YouTube/Klipy until Play/Show, GIF picker warns first; defaults load at once (stand-ins, phone)
KLIPY_API_KEY=… node e2e/gifs.mjs [dir] # admin sets the Klipy key, GIFs tab, search, favourites, send (real Klipy)
kill %1                  # stops all the servers (kill the serve.mjs process itself)
```
For voice, `serve.mjs` also runs its own LiveKit (the binary at `LIVEKIT_BIN`, default
`~/livekit/livekit-server`; skipped with a note if missing) on 127.0.0.1 with fresh keys and its
webhook pointed at the throwaway API. `fakeMicArgs()` (helpers) gives Chrome a fake microphone
playing a made-up speech-like sound: Chrome's own fake mic is a steady beep, which the browser's
noise suppression removes, so it never counts as talking; `fakeMicArgs({ phrases: true })` talks
for 1.5 s then is silent for 1.5 s, over and over. `serve.mjs` also leaves its LiveKit's
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
