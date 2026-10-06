# Guilds

## Guilds

Discord-style servers, always called **guilds** in the app and its code (never "servers": that
word is kept for the app's own server). **Not end-to-end encrypted**, on purpose: the server reads guild
messages, so it can do mentions, search and moderation. Encryption stays for DMs and (planned)
group DMs. Anyone can create a guild; its creator is the owner (`guilds.owner`).
- **Permissions** (`server/permissions.js`, copied in `client/src/utils/permissions.js`; a
  test checks they match) are Discord's model with a bit field: View Channel, Send Messages,
  Add Reactions, Manage Messages, Manage Channels, Manage Roles, Manage Guild, Create Invite,
  Kick, Ban, Administrator, Manage Emoji, Connect, Speak, Video (`STREAM`: camera and screen sharing;
  voice), Mention Everyone (@everyone,
  @here and any role; not a default, guild-wide only), Pin Messages (not a default; split out of
  Manage Messages like Discord did, migration 3), Manage Webhooks (guild-wide only), View Audit
  Log (not a default, guild-wide only; see Audit log), Edit Tasks (list channels; see List
  channels), Create Documents (`CREATE_DOCUMENTS`, document channels; see Document channels), Create Threads and
  Send Messages in Threads (`CREATE_THREADS`, `SEND_MESSAGES_IN_THREADS`; see Threads), and for
  Watch Together in voice channels Queue Videos, Manage Queue (not a default) and Control
  Playback (`QUEUE_VIDEOS`, `MANAGE_QUEUE`, `CONTROL_PLAYBACK`; see Voice channels in
  `docs/voice-and-calls.md`), and Create Events (a default, migration 13) and Manage Events
  (`CREATE_EVENTS`, `MANAGE_EVENTS`; see Events). Every guild has an `@everyone`
  role (`is_everyone`, position 0, default: view, send, react, invite, connect, speak, edit tasks, video, create documents,
  create threads, send in threads, queue videos, control playback) plus orderable roles (`guild_roles`: name, colour
  0xRRGGBB or null, `hoist` = shown separately in the member list, `mentionable` = anyone may
  @mention it, position: higher ranks
  higher), given out in `guild_member_roles`. Guild permissions are @everyone's plus the
  member's roles'; the owner and Administrator get everything.
- **Channel overrides** (`guild_channel_overrides`, per role or member, `allow`/`deny` of the
  channel permissions: View, Send, React, Manage Messages, Pin Messages, Connect, Speak, Video,
  Queue Videos, Manage Queue, Control Playback, Edit Tasks, Create Documents, Create Threads, Send Messages in Threads; the editor shows a text, voice, list or document channel's) apply in order: @everyone's, the member's roles' (all denies, then
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
  loads at once too, unless Settings → Privacy's "Show guild invites in DMs and group DMs
  straight away" is turned off (per device, on by default; `utils/privacy.js`, applies live):
  then it waits for a tap on Show, since asking tells the server which invite an encrypted
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
- **Bots** (`docs/bots.md`) are members with `bot` set: a BOT tag in the member list and on
  their messages (which can have embeds and files, drawn like webhooks'), no Message or Make
  owner on their card, and their own role (`bot_id`), which `RolesSettings` explains and won't
  delete and the member card won't give or take. The guild actions (send, delete, pin, react,
  kick, ban, channels, roles, overrides, threads, invites) are functions the bot API shares
  (they throw `ActionError`), so a bot follows the same permission and rank rules as anyone.
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
  its emoji anywhere. The client keeps them in `useGuildList` (`emojis`: all of them fetched at
  login, again when a guild new to the list is added, as on joining one, and after the websocket
  reconnects; `guild_emojis_update` in between), and `Layout` provides
  `CustomEmojiContext` (`emoji/customEmojiContext.js`: by guild in rail order, and by id).
- **Channel and category menus** (like Discord's): right-click a channel or category in the
  channel list, or touch and hold on a phone (where there are no cog buttons: the menu is the
  only way in). `ContextMenu.jsx` draws every such menu (see `docs/client.md`): floating with submenus beside it on a
  computer (hover, click or arrow keys), a bottom sheet on a phone (a submenu replaces it, with
  Back). `ChannelMenu`: Mark As Read (`POST /channels/:id/read { latest: true }`), Mute Channel
  ▸ / Unmute, Notification Settings ▸ (see Mentions), Copy Link (`channelLink`: this site's
  address, app.voicaw.com from the desktop app), and with Manage Channels Edit, Duplicate
  (`CloneChannelDialog`) and Delete; voice channels only the last four. `CategoryMenu`: Mark
  As Read, Collapse/Expand, Edit, Create Channel, Delete. On a phone the long press shares the
  touch with dragging (`usePointerDrag` `onLongPress`): hold and lift opens the menu, hold and
  move drags (with Manage Channels). The list's **empty space** has its own menu (right-click,
  or hold on a phone): Create Channel and Create Category (Manage Channels), Invite People.
- **A guild's menu on the rail** (`guild/GuildMenu.jsx`, right-click its icon or hold it on a
  phone; hold and move still drags it, `useDragReorder` `onMenu`): Mark As Read (every unread
  channel), Invite People, Notification Settings ▸ (your level for the guild), Guild Settings,
  Audit Log, Copy Link (`guildLink`) and Leave Guild, as your permissions allow; the dialogs
  live in `Sidebar` (the menu closes on a pick). It loads the guild's layout first if it isn't
  open yet.
- **Duplicating a channel** (Discord's Clone Channel): `POST /guilds/:id/channels/:c/clone
  { name? }` (Manage Channels) makes a channel just below it with the same type, topic,
  category and overrides, none of its content; copying overrides needs Manage Roles, and every
  bit they allow or deny must be one you have in the guild. Logged as `channel_create` with
  `clonedFrom`.
- **NSFW channels:** a text, list or document channel can be flagged NSFW (`guild_channels.nsfw`;
  `nsfw: true` on create or `PATCH`, Manage Channels; the channel dialog's "NSFW channel" switch;
  kept by Duplicate; logged as an `nsfw` change). The header shows a red NSFW tag. Its media is
  covered with "NSFW" for everyone until clicked or tapped (`MediaCover.jsx`, the same cover as
  spoilers, see Spoilers in `docs/uploads.md`): uploaded images and videos, GIFs, other sites'
  images, webhook embed images and files, and YouTube players (which load nothing from YouTube
  until uncovered). Emoji, avatars and text aren't covered. It's worked out when drawn, not stored
  in messages: `GuildView` (and each guild search result) puts the channel's flag in
  `NsfwChannelContext`, and `hooks/useMediaCover.js` gives each piece of media its cover: a
  spoiler gets the one "Spoiler" cover (never two), otherwise "NSFW" unless Settings → Content's
  "Blur media in NSFW channels" is off (`blurNsfw`, an account preference: see Account
  preferences in `docs/client.md`). Flagging or unflagging a channel changes its old messages
  too.
- **Age gate** (2026-10-05, for Google Play and the terms' 18+ rule): an NSFW channel, and a
  thread in one, shows `guild/NsfwAgeGate.jsx` instead ("I am 18 or over", Continue / Go back)
  until the account's `adultConfirmed` preference is set (Settings → Content can set or clear
  it). Only that answer is kept, never a date of birth or an age (the user's wish). While gated,
  nothing of the channel loads (`useChannel` gets no channel id, so nothing is marked read
  either), its pins and threads buttons are hidden, and guild search leaves out its results with
  a note saying how many. "Loading…" shows until the preferences have loaded, so someone who
  ticked never sees the gate flash. It's a client-side check: the API still serves an NSFW
  channel to any member (bots included), as Discord's does.
- **Not done yet:** category-level permissions (overrides are per channel), server folders in the
  rail, search dates (see Guild search), muting a category or a whole guild, a list of your
  recent mentions. Voice: see
  Voice channels.

## Threads

Discord's (public) threads in text channels: a side conversation started from a message, or on
its own, that opens beside the channel. Not encrypted, like the rest of a guild.
- **A thread is a channel**: a `guild_channels` row of type `'thread'` (migration 10 added the
  type) with `parent_id` (its text channel; no category, no position), `owner_id` (who started
  it), `starter_message_id`, `created_at`, `last_activity` and `archived`. So its messages,
  replies, reactions, edits, pins, polls, mentions, unread counts, mutes, notification levels,
  typing and read markers are a channel's, through the same routes (`/channels/<thread
  id>/messages`...). It never appears in `channels` of a layout, and the channel routes (edit,
  clone, move, overrides, `/layout`) don't know it (404). Deleting the channel deletes its
  threads (`deleteChannelContents`).
- **Permissions:** a thread has no overrides: `getOverrides` gives it its channel's, so whoever
  sees the channel sees its threads (a private channel's threads are private). Two new
  permissions, both channel permissions and on for @everyone (migration 10 adds them to old
  guilds): **Create Threads** (`CREATE_THREADS`) and **Send Messages in Threads**
  (`SEND_MESSAGES_IN_THREADS`), which in a thread stands for Send Messages (`threadPermissions`,
  applied by `getChannelAccess` and to a layout thread's `my_permissions`), so a read-only
  channel can still have open threads. Its starter renames and archives it; Manage Messages in
  the channel renames, archives and deletes anyone's (and moderates its messages as usual);
  anyone who may post in it unarchives it.
- **Starting one** (`server/threads.js`, `routes/threads.js`): `POST /channels/:id/threads
  { name (1–100 characters, free text), messageId? }`. From a message: one thread per message
  (409), not from a system row. On its own: a `"thread"` system row goes in the channel as its
  starter (its content is the name at the time; "X started a thread: name. See all threads").
  Starting one is in the audit log (`thread_create`; also `thread_update` with what changed,
  and `thread_delete`), under the channel.
- **Members** (`guild_thread_members`): whoever started it, posted in it, was mentioned in it by
  name (`<@id>`, not roles or @everyone), or pressed Join. Members have it under its channel in
  the channel list and get unread counts for it (`/guild-unread` leaves out threads you're not
  in); others find it from the message's line or the channel's Threads list. Pushes: a mention
  always (with the usual levels); other messages only to members, by the thread's own level, else
  the channel's, else the guild's, and a muted channel mutes its threads. The push opens
  `/guild/<g>/<channel>?thread=<id>`. `PUT` / `DELETE /threads/:id/member` joins and leaves.
- **Archiving:** archived by hand (`PATCH /threads/:id { archived }`) or after a week with no
  messages (worked out when read, `AUTO_ARCHIVE_SECONDS`: no timer); posting brings it back.
  Archived threads leave the layout and channel list but stay readable, under Archived in the
  Threads list.
- **API:** `GET /channels/:id/threads` (all of a channel's, active and archived, most recently
  active first, at most 200, with `joined`), `GET /threads/:id` (`{ thread, starter }`: the
  message it started from, null if gone or started on its own), `PATCH` (`name`, `archived`),
  `DELETE` (Manage Messages; takes its messages and its "started a thread" row). A thread is
  `{ id, guild_id, parent_id, name, owner_id, starter_message_id, created_at, last_activity,
  archived, message_count }` (+ `joined`). A message a thread started from has `thread` (that
  object; null otherwise). Layouts have `threads`: the active ones in channels you can see,
  with `joined` and `my_permissions`. Events: `guild_thread_update { thread }` (to the
  channel's viewers, on start, rename, archive and every message, so counts stay live),
  `guild_thread_delete { channelId, threadId }`, `guild_thread_member { threadId, joined }`
  (to your own devices).
- **Client:** `?thread=<id>` on a text channel's URL opens `guild/ThreadPane.jsx` in the member
  list's place (on a phone it covers the channel, with Back): header (name, #channel, Archived,
  Join, a menu: Join/Leave, Rename, Archive/Unarchive, Copy Link, Delete), the starter message,
  and a `ChatPane` over `useChannel({ side: true })` (the "side chat" in presence, `setSideChat`,
  so a thread on screen isn't pushed either). `ThreadContext` (`contexts.js`, from `GuildView`)
  gives the channel's messages Create Thread (right-click menu and phone action sheet;
  `guild/ThreadDialog.jsx` suggests a name from the message), the line under a starter message
  (`guild/ThreadSummary.jsx`: name, message count, last activity), and the header's threads
  button (`guild/ThreadList.jsx`: Active and Archived, Create). `useGuildList` keeps layouts'
  `threads` current and counts only joined threads as unread; `GuildSidebar` lists joined ones
  under their channel (a collapsed category still shows a channel with an unread thread).
- **Not done yet:** private threads, forum channels, threads in document channels, webhooks
  posting into threads, searching thread messages (guild search covers text channels only),
  `<#thread>` links (they show as #unknown-channel), choosing the auto-archive time, a thread's
  own notification settings in the UI (the API takes them like a channel's).

## List channels (tasks)

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

## Document channels

Guilded's docs as a guild channel type, `doc`: a feed of documents, newest first, each a card
(cover image if it has one, title, author and date, a plain-text excerpt, reactions, reply
count) that opens to the document, with reactions and a thread of replies that are ordinary
chat messages. Documents are **full markdown** (not Discord's subset): every heading level,
tables, task lists, rules, plus the app's `__underline__` and `||spoilers||`. Not end-to-end
encrypted, like the rest of a guild. A title is 200 characters, a document 100,000 (the routes
take a 1 MB JSON body, `server/index.js`), a channel holds 1000.
- **Permissions are the channel's:** View Channel sees the feed (without it: 404, no events),
  **Create Documents** (a channel permission, on for @everyone) writes new ones and edits your
  own, Manage Messages ("Manage Documents and Replies") edits and deletes anyone's (and their
  replies), Send Messages replies, Add Reactions reacts. Taking Create Documents away also stops
  editing your own.
- **Server** (`server/guildDocuments.js`, `routes/guildDocuments.js`; tables
  `guild_documents`, `guild_document_reactions`): `GET/POST /channels/:id/documents` (cards: no
  `content`, `content_start` = its first 1000 characters, `reply_count`, `last_reply_at`,
  `last_reply_id`, `reactions`), `GET/PATCH/DELETE /documents/:id`, `POST
  /documents/:id/reactions`, `DELETE /document-reactions/:id` (own only). The cover is an upload
  of ours (`<S3_ENDPOINT>/uploads/…`, an encrypted channel attachment's URL with its key, like
  images in messages). **Saving needs `version`** (the one the edit started from; every save
  bumps it): a stale one is 409 with the newer `document`, so nobody's save is silently
  overwritten (no live co-editing; that would need a CRDT and its own sync). Deleting is in the
  audit log as `document_delete` (never its title or text) and takes its replies and reactions.
- **Replies are `guild_messages` with `document_id`** (null for every other message), so
  mentions, pushes (url `/guild/<g>/<c>?doc=<id>`), edits, deletes, reactions, polls (their
  "poll ended" row too) and the audit log work as in a text channel. `GET/POST
  /channels/:id/messages` in a document channel need `document` (query) / `documentId` (body),
  and a reply's parent must be in the same document; a text channel refuses one. No pins there.
  Unread counts the channel's new replies; opening the feed marks the channel read up to its
  newest reply. Guild search only searches text channels, so replies aren't searched.
- **Client:** `GuildView` shows `documents/DocChannelView.jsx` for a document channel (no member
  list): the feed, or `?doc=<id>` (the document, its replies in a `ChatPane` over
  `useChannel({ channelId, documentId })` beside it, tabs Document / Replies on a phone),
  `?doc=new` and `&edit=1` (the editor). `hooks/useDocuments.js` keeps the feed and an open
  document current. `DocumentMarkdown` (`MessageList.jsx`) renders a document with
  `remarkDocument` (`utils/remarkDiscord.js`) and the messages' mentions, emoji and attachments.
- **The editor** (`documents/DocumentEditor.jsx`, lazily loaded with ProseMirror,
  prosemirror-tables and prosemirror-markdown, its own chunk): title, cover (Add / Change /
  Remove; an image dropped on "Add a cover image" becomes the cover, one dropped on the text goes
  into it), a Word-like toolbar (text style, bold, italic, underline, strikethrough, code,
  spoiler, link, bulleted / numbered / checklist, quote, image, table with row/column tools,
  rule, undo/redo) and the usual shortcuts (Ctrl/⌘+B/I/U, Ctrl/⌘+S saves), plus markdown typed
  as in a message turning into formatting at once (`# `, `- `, `1. `, `[ ] `, `> `, `` ``` ``,
  `---`, `**x**`…; `documents/editorSetup.js`). Images (picked, pasted or dropped) and the
  cover are uploaded encrypted like attachments; they (and the cover and pictures on the page)
  have the picture menu (right-click, or hold on a phone; Image menu in `docs/uploads.md`), and
  the text our spellcheck (see Spellcheck in `docs/client.md`). **Markdown is the format**:
  `documents/documentSchema.js` only has what markdown can hold (no colours, sizes or alignment,
  on purpose), `documentMarkdown.js` parses with the page's own remark pipeline
  (`documentText.js`) and writes markdown back (a test checks every construct round-trips
  exactly). A 409 shows "Load their version" / "Save mine over it". Styles are
  `assets/css/documents.css`. ProseMirror reads the selection from the browser's
  `selectionchange`, so a script pressing keys back to back must pause after one that only moves
  the selection (`e2e/docs.mjs` `move`); people can't type that fast.
- **Not done yet:** live co-editing, a document's history (old versions), mentions in a
  document notifying anyone, searching documents (and their replies), pinning or ordering
  documents in the feed, comments on a passage, and templates.

## Events

Discord's scheduled events (Discord has no calendar: its Events are a list), with a month
calendar of them beside the list (Guilded's calendar channels may come later, on the same data). An event is in a voice channel of the guild or
somewhere else (free text: a place, a link), with a name (100), description (1000, markdown
like messages), start, end (required somewhere else), optional cover image, and how it repeats.
Not end-to-end encrypted, like the rest of a guild.
- **Seeing one**: a voice channel's event follows View Channel there (like the channel: 404, no
  events, left out of lists), one somewhere else every member.
- **Permissions**: Create Events makes events (in a voice channel also needs Connect there; both
  are channel permissions too, in voice channels' overrides, as in Discord) and lets you edit,
  start, end and cancel your own; Manage Events does it to anyone's (`canManage`). Interested:
  anyone who can see it. At most 100 events per guild; starts at most five years ahead.
- **Lifecycle** (`server/guildEvents.js`, sweep every 15 s, `startEventTimers`): scheduled ->
  active -> completed, or cancelled. One somewhere else starts and ends on its own at its times;
  a voice channel's is started by hand (Start) and ends by hand (End event) or once its channel
  has stayed empty 5 minutes (counted in memory: a restart gives it 5 more); one nobody starts is
  cancelled 12 hours after its time. Only scheduled and active events are kept: one that ends
  or is cancelled is deleted (people are sent it with status `completed` / `canceled` first), a
  repeating one moves on to its next occurrence still to come, keeping who's interested.
- **Repeating** (`server/eventRecurrence.js`, `client/src/utils/eventRecurrence.js`): Discord's
  recurrence rules and only its shapes: daily (optionally on some weekdays), weekly or every
  other week on one day, monthly on the nth weekday, yearly on a date. Occurrences fall on the
  event's time zone's wall clock (`timezone`, the creator's device's; bots' are UTC), so a weekly
  20:00 stays 20:00 across clock changes (a time skipped by one comes an hour later, a repeated
  one the first time). The start must be one of its days. `occurrence_start` is when the current
  occurrence is due by the rule; "Change this event's time" moves only it (`start_time`, before
  the next one), "Cancel this event" skips to the next. Editing the event edits the series, and a
  new start or rule re-anchors it. Only the next occurrence can be changed on its own.
- **Interested**: its creator is, at once. Interested people get a push when it starts (`type:
  'event'`, the event's name, "Starting now · place (Guild)", url `/guild/<g>/<voice channel>?event=<id>`,
  tag `event-<id>`), unless their notification level for the guild is 'none', and never the one
  who started it. Leaving the guild (or deleting your account) drops your interest.
- **Server** (`guildEvents.js` has the actions, shared with the bot API, throwing `ActionError`;
  `routes/guildEvents.js`; tables `guild_events`, `guild_event_users`): `GET/POST
  /guilds/:id/events` (each with `interested`, yours, and `user_count`), `GET/PATCH/DELETE
  /guild-events/:id` (DELETE cancels every occurrence), `POST /guild-events/:id/start`, `/end`,
  `/skip`, `PUT /guild-events/:id/occurrence { startTime, endTime? }`, `PUT/DELETE
  /guild-events/:id/interest`, `GET /guild-events/:id/users` (user ids). Events go to whoever can
  see the event (`guild_event_create` / `_update` / `_delete`, `guild_event_interest`); moving one
  to a channel someone can't see is a delete for them. Audit log: `event_create`,
  `event_update` (changes, the channel by name, cover and repeat notes), `event_delete`.
  Deleting a voice channel deletes its events (a delete is sent), deleting the guild all of
  them. Covers are uploads (like a document's: encrypted like a guild attachment, its URL with
  the key), linked as upload kind `event`, so the file goes with the event.
- **Client**: `hooks/useGuildEvents.js` (in `GuildSidebar`) keeps the guild's events. The channel
  list starts with Calendar (Live while an event is on), and under a voice channel with an
  event on, "Live: name"; the guild menu has Create Event (Create Events, or a voice channel
  you may hold one in). `events/EventsDialog.jsx`: one dialog, the same size whatever it shows
  (900 × 700 at most), with two tabs, Calendar (first) and Events (the tab, month and day are kept in `GuildSidebar`
  while the editor is open; it always opens on the calendar, on today), and the list (`EventCard`: cover, when and "Starts
  in 3 hours" / "Happening now", repeat, place, interested count, Interested, Start/End, the
  menu: edit, change or cancel this occurrence, copy link, cancel) and one event (info and an
  Interested tab with who). `events/EventEditor.jsx`: Discord's three steps (where: a voice
  channel you may hold one in, or somewhere else; info: topic, start, end, repeats from
  `repeatChoices` of the start day, description, cover; review: the card). `?event=<id>` on a
  guild URL opens it (links, notifications; `eventLink`, kept through the redirect to the last
  channel); an event link in a guild channel gets a card (`events/EventEmbed.jsx`; not in DMs and
  group DMs, so an encrypted chat's link is never sent to the server).
- **Calendar** (`events/EventCalendar.jsx`, `utils/eventCalendar.js`): a month on six weeks from
  Monday, each event on the day it starts (on this device), with every occurrence of a
  repeating one: `occurrencesBetween` (`utils/eventRecurrence.js`) is a copy of the server's
  stepping on the event's time zone's wall clock (keep the two alike), the current occurrence
  at its own, perhaps moved, time and the rule's after it, with the series' `duration`. A day
  shows up to three events (time and name; a click opens the event), then "+N more"; clicking
  a day picks it and lists its events beside the month (under it when the dialog is narrower
  than 620 px, where the squares show dots instead of names: a container query). Making an
  event on the calendar: the + on a day under the pointer (or the chosen one), or Create Event
  under the day's list, both only on today and later and for those who may make events; the
  editor starts that day at 18:00 (`startOnDay`; the next whole hour if that's sooner than it
  allows). The Events tab keeps its own Create Event. Styles in
  `assets/css/events.css`; times through `formatEventTime` (`utils/dateFormat.js`).
- **Not done yet**: a week view, events spanning days drawn across them, calendar channels, RSVP
  beyond Interested (Going / Maybe / Can't, limits), reminders before an event, editing an
  occurrence other than the next one, per-occurrence interest, event invite links that also
  invite into the guild, and stage channels.

## Guild search

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

## Webhooks (Discord's API)

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
