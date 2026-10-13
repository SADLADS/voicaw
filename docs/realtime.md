# Realtime, online status and push notifications

## Realtime: WebSocket for push, REST for fetch/mutate

`server/index.js` exports the Express `app`; only when run directly (`require.main === module`)
does it bind `PORT` (default 3000) and attach the `ws` server (`sockets.js`
`attachWebSocketServer`) to the same HTTP server. `clients` and `sendToUserSockets` are
module-level in `sockets.js`, so routes can push events (and tests can fake sockets through
`app.locals.clients`). Clients
identify themselves post-connect with `{ type: 'identify', token }` (JWT); the server maps
`userId -> [sockets]` in an in-memory `clients` Map (a user can have multiple open sockets/tabs).
Server -> client push events: `new_dm`, `delete_dm`, `edit_dm`, `reaction_add`, `reaction_remove`,
`dm_pin` (see Pinned messages), `dm_link_previews` (and groups' `group_dm_message_link_previews`:
a sender's encrypted link previews; see Link previews),
`user_status` and `presence_snapshot` (see Online status), `user_profile` (someone changed their
profile, to every logged-in socket; see Profiles), `account_deleted` (to your own sockets: log
out; see Deleting an account), `session_revoked` (to the sockets of a session logged out from
another device: log out; see Login sessions), `message_sound` (play the Message sound; see Sounds), and for guilds (see Guilds) `guild_add`, `guild_update`, `guild_remove`,
`guild_member_add`, `guild_member_remove`, `guild_message_new` / `_edit` / `_embeds` (link previews, or Remove Previews' flags) / `_delete` / `_pin` (a
webhook's edit also carries `embeds`, `attachments`, `flags`),
`guild_reaction_add` / `_remove` (the removal with who and which emoji, for bots), `guild_member_update` (roles), `guild_emojis_update`,
`guild_order` (your guild rail order, to your other devices), `guild_channel_mute` (you muted or
unmuted a channel, to your other devices; see Mentions), `guild_mute` (the same for a whole
guild), `guild_channel_notify` (you set a
channel's notification level, to your other devices), `conversation_settings` (you pinned or
muted a DM or group, to your other devices; see `docs/client.md`), `preferences` (you changed
an account preference, to your other devices; see `docs/client.md`), `friends` (your friends
or friend requests changed, to both people's devices with each one's lists; see Friends in
`docs/client.md`), `dictionary` (your
encrypted spellcheck dictionary was saved, to your devices; see `docs/auth-and-encryption.md`),
`emoji_usage` (your encrypted emoji usage was saved, to your devices; see Emoji usage in
`docs/auth-and-encryption.md`),
`guild_voice_state` (someone
joined, left or (un)muted in a voice channel), `guild_watch_party` (a voice channel's Watch
Together changed or ended, with the activity log's new entry, to whoever can see it; see Voice channels in `docs/voice-and-calls.md`), `guild_thread_update` / `_delete` (to whoever can
see the thread's channel) and `guild_thread_member` (you joined or left a thread, to your devices;
see Threads in `docs/guilds.md`), `guild_mention` (only to whoever a new message
mentions, for their red counts), `guild_task_upsert` / `_delete` / `guild_tasks_move` /
`guild_task_comment_new` / `_edit` / `_delete` (to whoever can see the list channel) and
`guild_task_assigned` (only to whoever was just assigned; see List channels),
`guild_event_create` / `_update` / `_delete` (an event, to whoever can see it; one moved out of
sight is a delete for those who lose it) and `guild_event_interest` (who's interested changed,
with the new count; see Events in `docs/guilds.md`),
`guild_document_upsert` (a feed card) / `_update` (the whole document, after a save) / `_delete` /
`guild_document_reaction_add` / `_remove` (to whoever can see the document channel), for calls `call_incoming`, `call_update`,
`call_end`, and for group DMs `group_dm_add` / `_update` / `_remove` / `_epoch` /
`_message_new` / `_message_edit` / `_message_delete` / `_message_pin` / `_reaction_add` / `_reaction_remove`, and `typing`
(see Typing indicator). A 30s heartbeat
(ping/pong) prunes dead connections.

Client side, `client/src/utils/ws-client.js` wraps this with `connectWebSocket`/`closeWebSocket`
and a pub/sub listener API (`onNewDm`, `onDeleteDm`, `onEditDm`, `onReactionAdd`, `onReactionRemove`, `onDmPin`, `onGuildEvent`,
`onCallEvent`, `onGroupEvent`), auto-reconnecting
every 3s on close. All non-realtime DM operations (fetch history, send, mark read) go through the
plain REST API in `client/src/services/dmService.js` / `client/src/utils/api.js` instead.

Bots connect to `/api/gateway` instead (the same HTTP server; `attachWebSocketServer` sends
upgrades there to `gateway.js`): Discord's gateway protocol, where each session sits in `clients`
as one of the bot's sockets and turns these events into Discord's (see `docs/bots.md`).

## Typing indicator

"Alice is typing…" (bold names, three bouncing dots) just above the message box in DMs, group
DMs, guild text channels and a document's replies; never in notes. Like Discord:
- Sending: `services/typingService.js` `noteTyping(chatId)`, called by `Composer` on every edit
  while the box has text, posts `POST /api/typing { chatId }` at most every 8s per chat.
  Sending the message or emptying the box (`typingDone`) resets that, so the next one tells the
  others at once. Turned off in Settings → Privacy ("Let others see when I'm typing",
  `utils/privacy.js` `sendTyping`, on by default), nothing is sent; you still see others.
- Server (`routes/typing.js`): checks you may write there (the other person exists for a DM;
  member of the group; View Channel and Send Messages in the channel, or the document's
  channel), then sends `typing { chatId, userId }` to everyone else who can see the chat, with
  `chatId` as *they* name it (for a DM, the typer's id). At most one a second per person and
  chat: sooner gets 429, and the client tries again a second later unless the message was sent
  or the box emptied by then. Nothing is stored.
- Showing: `utils/typing.js` keeps who is typing per chat (`useTyping(chatId)`); someone is
  forgotten 10s after their last event or when their message arrives (`ChatPane` clears the
  newest message's sender). `TypingIndicator` sits over room kept free at the bottom of the
  message list (`--vc-typing-height`), so it coming and going moves nothing; the dots stand
  still with reduced motion.
- Privacy: in DMs and group DMs this tells the server when you're typing and to whom (it
  already sees when messages are sent), never what. Hence the Privacy setting.

## Online status

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

## Activities (Rich Presence)

What people are doing, as Discord's activities: "Playing Hades" from their games (the desktop
app's Rich Presence, see Rich Presence in `docs/desktop-and-site.md`), and bots' own ("Watching 3
guilds", a custom status; gateway Presence Update). Built 2026-10-09.
- Server (`activities.js`): kept on the socket that set them, in memory only, gone when it
  closes (only games' names and times are saved, below). A socket sends `activity { activities }` (cleaned: at most 3,
  128-character texts, people's types 0/2/3/5, bots' 0-5; 30 a minute) once it's identified;
  someone's activities are their most recently set socket's (an invisible bot's don't show).
  Changes go to every logged-in socket as `user_activities { userId, activities }`, and
  `presence_snapshot` carries `activities: { id: [...] }`. One activity: `{ name, type, details,
  state, start, end, partySize, partyMax, imageText, image, smallIcon, smallText }`: `name` null
  for a game the app couldn't name, start/end unix ms, `image` a picture's id, `smallIcon`
  'playing' | 'paused' | null (a music player's state: a play or pause badge on the picture's
  corner on the card) with its hover text.
- Pictures: the app sends a game's picture (JPEG or PNG, at most 48 KB; the app makes them 128
  px) as base64 in the activity the first time on each connection, then only its id; the server
  keeps the last 500 in memory by the SHA-256 of their bytes and serves them at
  `GET /api/activity-images/<id>` (no login: `<img>` can't send one, and the hash says nothing
  about who plays it; cached a day).
- Client: `utils/activities.js` is the store (snapshot + changes) and the wording, `hooks/
  useActivities.js` subscribes. `ws-client.js` `setOwnActivities` (from `useDesktopApp`) sends this
  device's, at most one every 5 s (the latest), and again after each reconnect. Shown in
  `ActivityLine` ("Playing **Hades**", the latest one, after its kind's icon: gamepad Playing,
  note Listening, TV Watching, broadcast tower Streaming, trophy Competing, none for a custom
  status; under names in the guild member list, and
  in the DM list and Friends where there's no custom status, as Discord) and `Activities` (the
  profile card: per activity a heading, the picture or that icon, name, details, state with
  "(2 of 4)", "12:34 elapsed" / "3:00 left", ticking).
- **Streaming in guild voice** (built 2026-10-09, as Discord's Go Live): someone sharing their
  screen in a guild voice channel shows "Streaming in **lounge**" (broadcast tower, in the live
  red) in `ActivityLine`, before any game, and a Streaming section first on their card (channel,
  guild, Go to channel). Not an activity: nothing more is broadcast. `utils/voiceStreams.js` keeps
  it from what the app already gets about voice channels it can see: the guild list's `streams`
  (`[{ user_id, channel_id, channel_name }]`, from `voice.js` `guildVoiceFor`), guild layouts
  (`self_stream` in each voice channel's `voice`) and `guild_voice_state` events (which carry
  `channelName`), fed by `useGuildList`. So the server's channel visibility decides who learns
  it, and a private channel's stream stays private. Never for DM or group calls (private and
  end-to-end encrypted). Checked in `e2e/voicestream.mjs`.
- Bots get people's in PRESENCE_UPDATE (`activities`, Discord's shape, no application id or
  pictures) with the presences intent, and when they change.

### Activity history

Built 2026-10-13, for the full profile's Activity tab (Full profiles in `docs/client.md`).
`activityHistory.js` turns people's activities, as they change (`refreshActivities` calls
`record`), into play sessions in `activity_sessions (user_id, name, started_at, ended_at)`, unix s:
only "Playing" activities with a name, never bots', never the rest of what the game says. A game
that stops and starts again within 5 minutes carries on its last session. Open sessions' ends
move on every minute (`tick`), so a restart loses at most that; rows over 30 days old are deleted
hourly (`prune`). Changes for one person run in order (a promise per person). With
`showActivity` off nothing is recorded, and turning it off deletes their rows (`forget`, from
`PUT /preferences`); deleting the account deletes them too. `historyOf(id)` sums them per game
(`{ name, seconds, lastPlayed, sessions, playing }`, last played first).

## Push notifications (Web Push)

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
- Server: `sendPushToUser()` (drops 404/410 subscriptions). New DMs are pushed unless the
  recipient muted the conversation (`isConversationMuted`) or `isViewingConversation()` says
  they're looking at that chat (group DMs: chat id
  `group-<id>`; guild channels: `channel-<id>`, and which guild messages push is in Mentions). That uses `presence`
  websocket messages (`{visible, chatId, sideChatId}`; `sideChatId` is a thread open beside its
  channel, `setSideChat`) that `ws-client` sends on focus/visibility/chat changes
  and every 15s. The server ignores presence older than 35s.
- Previews stay end-to-end encrypted. The DM push carries the ciphertext (never a key) when it fits
  in a push (~4KB), plus `senderId`/`recipientId`. `service-worker.js` → `services/pushNotifications.js`
  decrypts it on the device with the sender's *pinned* key (`contactKeys`) and the user's key
  (`keyStore`). It falls back to "New message" when the message is too big, previews are off
  (`settingsStore`, IndexedDB, readable by the SW), this device has never checked the sender's
  keys, or the device is logged out. Previews off (Settings → Privacy, "Show message text in
  notifications") also swaps guild messages' and bot DMs' text, which the server sends
  readable, for "New message" (`notificationFromPush`, so the desktop and Android apps too). Group DM pushes do the same with the group keys saved on
  the device, for the group's name too (see Group names in `docs/group-dms.md`). Notifications are
  tagged per conversation.
- `pushsubscriptionchange` posts to the unauthenticated `/api/update-subscription`, keyed by the
  old endpoint. `/api/test-push` sends a test notification to all of the caller's devices.
- The desktop app has no web push: `sendPushToUser` also sends the payload to the user's sockets
  whose presence says `desktopNotifications` (the app, notifications on) as `notification
  { payload }`, so the same checks apply (viewing, levels, previews). See Desktop app.
- The Android app has no web push either: its subscription is a Firebase token (`fcm:<token>`
  endpoint, with the phone's own key), and `sendPushToUser` sends it the same payload through
  FCM, encrypted for that phone (`fcm.js`). Calls also get `call_stop` there
  (`sendToAndroidApps`) to stop the phone ringing. See Android app in `docs/desktop-and-site.md`.
- **Reaction notifications** (`reactionPushes.js`, as Discord's): a `reaction` push to a message's
  author when someone else reacts, never for poll votes or added answers, a reactor they
  blocked, a conversation they're looking at or have muted (in guilds: their level for the
  channel, its thread's channel or the guild being Nothing, or the channel or guild muted; the default
  Mentions counts, since the reaction is to them), and only as their account preference
  `reactionNotifications` allows (Settings → Notifications: `all` by default, `dms`, `off`).
  At most one per message and reactor in 30 s; each replaces the last for that message (`tag`
  `reaction-<chat>-<message id>`); no sound, and taking the reaction back leaves it.
  - Guilds (`chat: 'guild'`): the server sees the emoji, leaves votes out (`addReaction`'s
    `forPoll`, so bots' reactions too) and sends `emoji`, the message's `preview` and a worded
    `body` to every device, browsers included.
  - DMs and group DMs (`chat: 'dm'` / `'group'`): the server can't tell a vote from an emoji (on
    purpose, see Polls), and a browser must show a notification for every push, so these go
    only to apps that can drop one unshown (`sendToReactionApps`): desktop apps whose presence
    says `reactionPushes`, Android apps whose subscription does (`fcm.reactionPushes`; older
    apps say neither and get none). The push carries the encrypted reaction (`reaction`) and,
    when it fits, the message (`ciphertext`), with the ids they're bound to (`messageId`,
    `reactorId`, `senderId` = the author, `recipientId` / `groupId`, `epoch`, `replyTo`,
    `edited`). `notificationFromPush` opens them with the keys the device keeps (the reactor's
    pinned key; the group's saved keys, the reaction only if signed by its reactor) and returns
    null, i.e. nothing shown, for a vote, an added answer or anything that won't open. Browsers
    therefore never hear about reactions in encrypted chats.
- Message pushes (`dm`, `group`, `guild`) also send `message_sound` to every socket of the user
  (see Sounds). Before showing one, the service worker asks the open pages
  (`handles-message-sound`, answered within 500 ms) whether one plays the Message sound itself;
  if so (or a window of the app is focused) the notification is `silent`.
- The PWA manifest is `public/manifest.json` only (VitePWA `manifest: false`). The dev server also
  serves the real service worker (`devOptions`), so push works under `npm run dev`.
