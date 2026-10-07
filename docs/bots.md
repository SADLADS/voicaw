# Bots

## Bots (Discord's bot API)

Bots are programs that act in guilds through **Discord's API v10** (REST and the gateway), so
Discord's libraries (discord.js, discord.py, ...) work by changing their URLs. People make them in
the developer portal in the app; public documentation for bot authors is on voicaw.com
(`website/`, `/developers/docs/`). Decided 2026-10-03: library-compatible, guilds only (plus,
since 2026-10-06, their own unencrypted DMs with people: see Bot DMs), no
privileged intents, anyone can make applications (25 each). Commands and components came
next (see Commands and interactions): buttons, selects and forms, slash and context-menu
commands, Discord-style ephemeral replies, interactions over the gateway only.

- **Applications and bot users** (`server/bots.js`, table `bot_applications`): an application
  has exactly one bot, a `users` row with `bot` = 1 whose id is the application's id (as in
  Discord). The bot has no password and empty keys: `findUserByName` skips bots, so their names
  can't log in (they get OPAQUE's dummy answer like an unknown name), and new usernames can't
  contain `#` because bots' are `"<slug>#<4 digits>"` (Discord's old style; the API shows its
  username as the application's name and the digits as its discriminator). Its display name is
  the application's name, its bio the description, its picture a profile picture (avatars.js).
  Deleting an application takes the bot out of every guild and leaves the user as a deleted
  account (`Deleted-Bot-<id>`), so its messages keep an author.
- **Encrypted chats are out of reach**: bots aren't in `/dms-list`, and DM send, DM typing,
  DM calls (`calls.userById`) and group DM membership (`groupDms.checkEntry`) refuse them. Bots
  have their own, unencrypted DMs instead (see Bot DMs). Bots only ever see people through their
  guilds (`GET /users/:id` needs a shared guild), unlike people, who see everyone.
- **Tokens**: Discord's shape (base64 of the bot's id, base64 of the time, 32 random characters),
  shown once on creation and on Reset Token; only the SHA-256 is stored (`token_hash`). Resetting
  ends every gateway session using the old one (`gateway.closeBotSessions`, close 4004).
- **Adding a bot to a guild** (`/oauth2/authorize?client_id=…&scope=bot&permissions=…` in the
  app, `POST /api/oauth2/authorize`): needs Manage Guild there; anyone can add a public bot,
  only its owner a private one. `permissions` is Discord's bitfield; the bot gets its own role
  (`guild_roles.bot_id`, named after it, just above @everyone) with those permissions, keeping
  only the ones the person adding it has. That role can be edited (permissions, colour, name,
  position) but not deleted or given to anyone else (`guildRoles.js`); it goes when the bot
  leaves, is kicked or banned (`guilds.removeMember` → `bots.removeBotRole`). Audit log:
  `bot_add`. A banned bot can't be added back until unbanned.
- **The developer portal** (the app's `/developers`, outside the guild layout; from Settings →
  Developer Portal) uses `routes/applications.js` (logged in): list, create (returns the token
  once), change name, description, public and picture, reset the token, take the bot out of a
  guild, delete; and builds the invite link from permission checkboxes.

### REST (`server/routes/botApi.js`)

Mounted at `/api/v10` and `/api/v9` (before the webhook router, which shares those paths), with
`Authorization: Bot <token>`. The app-wide JSON parser skips `/api/v<n>/`: the router parses its
own (1 MB) so bad JSON gets Discord's 50109, and answers JSON as exactly `application/json`
(discord.py only reads a body as JSON with that type; webhooks under `/api/v<n>/` get it too).
Unknown paths get Discord's 404.

- **Every action goes through the app's own rules**: guild actions are functions shared by the
  app's routes and the bot API, taking the acting member and throwing `ActionError(status,
  message, discordCode)` (`server/actionError.js`; app routes answer `{ error }` through
  `withActionErrors`, the bot API Discord's `{ message, code }`): `createMessage`,
  `deleteMessage`, `setMessagePinned`, `addReaction` / `removeReaction` (routes/guildMessages.js),
  `kickMember`, `banMember`, `unbanMember`, `createChannel`, `updateChannel`, `deleteChannel`,
  `createInvite` (routes/guilds.js), `createRole`, `updateRole`, `deleteRole`, `reorderRoles`,
  `setMemberRoles`, `setOverride` (routes/guildRoles.js), `startThread`, `updateThread`,
  `deleteThread`, `setThreadMembership` (routes/threads.js), `createEvent`, `updateEvent`,
  `startEvent`, `endEvent`, `cancelEvent`, `setInterest` (guildEvents.js). Message bodies (content, embeds,
  files, `allowed_mentions`, flags) are checked by the webhook code (`routes/webhooks.js`
  exports its helpers), so bots' messages can have embeds and files like webhooks'.
- **Endpoints**: gateway (`/gateway`, `/gateway/bot`), users (`@me` get/patch, guilds, leave,
  `/users/:id`), applications (`@me`, `oauth2/applications/@me`, commands: see Commands and
  interactions), guilds (get, channels, create channel, roles
  incl. positions, emoji, members list/search/get/patch roles/role add and remove/kick, bans,
  invites, active threads), channels (get, patch, delete, overwrites, invites, typing),
  messages (list with before/after/around, get, send with replies and files, edit own, delete,
  bulk delete), reactions, pins (old and new paths), threads (from a message or on their own,
  join/leave, members, archived), scheduled events (list, get, create, modify incl. `status`
  2/3/4, delete, interested users; see Events in `docs/guilds.md`; covers sent as image data are
  stored as a WebP upload, `guildEvents.storeImageData`; stage events refused; the app's all-day,
  emoji and colour aren't in Discord's API, so bots don't see them). Rate limits: 50 requests a second per bot, and per route and
  channel or guild, with Discord's `X-RateLimit-*` headers and 429 bodies (off with
  `DISABLE_RATE_LIMITS`, as in tests).
- **CDN**: `/api/cdn/avatars/:id/:hash.*`, `/icons/:guildId/:hash.*`, `/emojis/:id.*`,
  `/guild-events/:id/:hash.*` (a cover a bot can read: not an encrypted one from the app) redirect to
  our pictures, so a library's CDN address can point at `https://api.voicaw.com/api/cdn`.

### Objects, ids and permissions (`server/discord.js`)

- **Ids** are ours, as decimal strings (so the app's ids and the API's are the same, and
  webhooks' already were), with two exceptions Discord's libraries need: a guild's @everyone role
  has the guild's id (role ids always run ahead of guild ids, since every guild is created with
  its @everyone, so no other role of a guild can have its id), and categories, a table of their
  own, are `CATEGORY_ID_BASE` (2^40) + their id so they can't clash with channels. Our ids aren't
  snowflakes: "created at" worked out from one is meaningless.
- **Channels**: text (0), voice (2), category (4) and threads (11). List and document channels
  aren't in the bot API (no Discord type fits).
- **Permissions** are Discord's bits as decimal strings. Each of ours stands for one; Discord's
  that we don't have are implied by the nearest of ours (Read Message History by View Channel;
  Embed Links, Attach Files, Use External Emoji and Use Application Commands by Send Messages;
  Use Voice Activity by Speak; Create Guild Expressions by Manage Emoji). Edit Tasks, Create
  Documents, and Watch Together's Queue Videos, Manage Queue and Control Playback are ours only
  (bits 56 to 60), as are Listen (61) and Manage Levels (62, `VOICAW_MANAGE_LEVELS`). Coming in, only the bits that stand for ours count.
  The client has a copy of the mapping for the portal's checkboxes (a test checks they match).
- **Messages**: Discord's message object, with `member` (gateway), `mentions` (users named in
  the text), `referenced_message` for replies, reactions summed per emoji (`me` for the bot),
  embeds and attachments; system rows map to Discord's types (thread started 18, poll result
  46, a join in the join log 7; Discord has no leave, so a join log leave is type 0 with no
  content). Content is always included: there's no message content intent to need. A guild's
  join log channel is its `system_channel_id` (read only: the bot API can't set it).

### Gateway (`server/gateway.js`)

At `wss://api.voicaw.com/api/gateway` (`sockets.js` hands upgrades to that path to it; nginx
already passes websocket upgrades on every path of api.voicaw.com). Discord's protocol: Hello
(41.25 s heartbeat), Identify, Heartbeat/ACK, Resume (a dropped connection's session waits 2
minutes, keeping up to 1000 events; a clean close ends it), Presence Update (idle shows idle,
Do Not Disturb online, Invisible offline), Request Guild Members (chunks of 1000, by query or
ids, with presences if asked), Invalid Session; Voice State Update is ignored (voice is
LiveKit's). JSON only, with optional `compress=zlib-stream` (one deflate stream per connection,
flushed per message). Close codes: 4001 unknown opcode, 4002 decode error / unsupported
encoding, 4003 not identified, 4004 bad token (also when it's reset), 4005 already identified,
4008 rate limited (120 sends a minute; 16 sessions per bot), 4009 timed out, 4010 bad shard,
4013 bad intents. Intents choose events; none is privileged.

- **How events reach it**: each session is one of the bot's sockets in `sockets.js` `clients`
  (an object with `readyState`, `send`, `close` and `presence`), so it hears exactly what an app
  socket of that user would: everything about its guilds, and only channels it can see. Its
  `send` turns the app's events into Discord's, one at a time in order (`guild_message_*` →
  MESSAGE_*, reactions, pins, members, profiles, statuses → PRESENCE_UPDATE, typing, threads,
  voice states, emoji, `guild_event_*` → GUILD_SCHEDULED_EVENT_* with the Guild Scheduled
  Events intent, which also fills GUILD_CREATE's `guild_scheduled_events`). `guild_reaction_remove` carries `userId` and `emoji` for this. Guild
  changes arrive as a whole new layout (`guild_update`), so the session keeps what it last sent
  of each guild and sends the differences (CHANNEL_CREATE/UPDATE/DELETE, GUILD_ROLE_*,
  GUILD_UPDATE). A session counts as the bot being online (statusOf), unless it set Invisible.
- **Checked with real libraries** (2026-10-03, against e2e's throwaway API): discord.js 14.27
  (rest `api` and `cdn` options) and discord.py 2.7.1, which needs `Route.BASE` *and*
  `DiscordWebSocket.DEFAULT_GATEWAY` set: discord.py ignores `GET /gateway` and would otherwise
  send the token to Discord's own gateway (the public docs warn about this).

### Commands and interactions (`server/commands.js`, `server/interactions.js`, `server/components.js`)

Discord's application commands, message components and interactions (decided 2026-10-03:
buttons, all five selects and forms; slash plus user and message context-menu commands;
ephemeral replies like Discord's; delivered over the gateway only, never to a URL the bot
gives, so the server never makes requests to addresses bots choose).

- **Commands** (`bot_commands`; global ones have `guild_id` 0): the bot API's Discord endpoints
  under `/applications/:appId[/guilds/:guildId]/commands`: list, create (POST with an existing
  type and name replaces it, as in Discord), get, patch, delete, and bulk overwrite (PUT, what
  discord.js's `commands.set()` and discord.py's `tree.sync()` use; ids of the same type and
  name are kept). `cleanCommand` applies Discord's rules: lower-case names for slash commands,
  descriptions, up to 25 options, subcommands and groups (not mixed with plain options, two
  levels at most), required options first, choices (25) or autocomplete, min/max, channel
  types, the attachment type, 8000 characters in all; 100 slash, 5 user and 5 message
  commands per application and place. `default_member_permissions` is stored as our bits
  ("0", administrators only, as ADMINISTRATOR); `mayUse` (Send Messages in the channel, those
  permissions, NSFW commands only in NSFW channels) decides who sees and uses one. A guild
  command hides a global one with the same type and name. Commands go with the bot: only bots
  in the guild count (`guildCommands`). Per-command permission overrides aren't in Voicaw.
- **Using them** (`routes/interactions.js`, logged in): `GET /channels/:id/commands` (the
  picker's list), `POST /channels/:id/command-interactions` (options in Discord's shape;
  multipart `files[n]` for attachment options, stored like webhook files), `POST
  /channels/:id/autocomplete`, `POST /guild-messages/:id/component-interactions` (a button or
  a select's values, also on ephemeral messages), `POST /modals/:id` (a form's answers),
  `DELETE /ephemeral-messages/:id` (dismissed). Everything is checked before the bot hears of
  it: options against the command (types, choices, limits, users/roles/channels the person
  can see, put in `resolved` as Discord does), selects against their options and min/max,
  disabled and unknown components refused, forms against the form that was opened (once
  only). 20 a person per 10 s.
- **Delivery**: `interactions.run` stores the interaction (`bot_interactions`, token SHA-256
  only; tokens start with Discord's `aW50ZXJhY3Rpb246`), sends INTERACTION_CREATE to one of the
  bot's gateway sessions for that guild (`gateway.deliverInteraction`; no intent needed) with
  Discord's payload (member with permissions, channel, app_permissions, message for
  components, resolved data), and waits 3 seconds for the callback. No session, or no answer:
  504 "The application did not respond". The app's call resolves to `{ ok }`, `{ modal }` or
  `{ choices }`; the bot's messages arrive by socket like any other.
- **Callback** (`POST /interactions/:id/:token/callback`, no bot token, once, within the 3
  seconds; `?with_response=true` supported): 4 reply, 5 "thinking…" (a message with flag 128,
  LOADING, that the first follow-up or an edit of `@original` fills), 6 nothing visible, 7
  update the component's message, 8 autocomplete choices, 9 open a form (`cleanModal`: up to 5
  text inputs in action rows, or Label components holding a text input or string select;
  kept in memory for that person for 15 minutes). Which answers each kind may have follows
  Discord. Multipart answers (files) work: the message is in payload_json's `data`.
- **Follow-ups** on the interaction's webhook, `/api/v10/webhooks/:appId/:token` (the bot router
  takes paths whose token is an interaction token; anything else falls through to real
  webhooks): post (needs an answer first), get, patch and delete `messages/@original` or a
  follow-up's id, for 15 minutes.
- **Messages**: `guild_messages.components` (Discord's action rows, checked by
  `cleanMessageComponents`: 5 rows, 5 buttons or one select per row, unique custom ids, link
  buttons with http(s) URLs, no premium buttons, no Components V2) and `interaction` (JSON: the
  interaction's id, type, user, command name with subcommands, command type, target), shown by
  the app as "<person> used /<command>" and to bots as `interaction_metadata` and the old
  `interaction`, with Discord's types 20 / 23 for command replies. Bots send components in any
  message (bot API create/edit, `botMessages.js`, shared with replies and follow-ups);
  `guild_message_edit` carries `components`.
- **Ephemeral messages** ("Only you can see this"): never stored. `interactions.js` keeps them in
  memory for 15 minutes (edits, their components, follow-ups) with ids from `EPHEMERAL_ID_BASE`
  (2^52, never a guild message's id) and sends `guild_ephemeral_message` / `_edit` / `_delete`
  only to that person's sockets; the app keeps them until reload or Dismiss, as Discord does.
  Lost if the API restarts within those 15 minutes (the bot then gets Unknown Message).
- **In the app** (`services/interactionService.js` for the calls and the open form):
  - **"/" picker** (`CommandSuggestions`, `hooks/useChannelCommands.js`): typing "/" at the
    start of an empty message in a guild channel or thread lists the slash commands.
    Subcommands are their own entries. Every match is listed (no cap), one section per bot
    under its picture and name (`groupCommandsByBot`: bots in the order of their best match),
    and the list scrolls inside its height with the bot's name staying at the top; arrow keys
    follow the list as drawn and keep the highlighted command in view. The list is cached 30 s
    per channel and fetched again when it opens.
  - **Command mode** (`CommandComposer`, `utils/commandOptions.js`,
    `hooks/useCommandAutocomplete.js`): picking a command swaps the message box for its
    option fields. Typed fields check their limits; choices are dropdowns; members, roles and
    channels come from the guild; attachments use a file picker. Autocomplete waits 250 ms
    after typing. Required fields are checked, and "The application did not respond" keeps
    what was filled in.
  - **Apps menus:** message commands in the message menu and the phone action sheet; user
    commands on the member card.
  - **Components** (`MessageComponents`, `utils/botComponents.js`): buttons and selects under
    bot messages, with a spinner while waiting and "This interaction failed" for 5 s after a
    failure. Selects open as a sheet on phones.
  - **Interaction notes** (`InteractionNotes`): "<name> used /command" above a command's
    reply, and "<bot> is thinking…".
  - **Ephemeral messages:** `useChannel` handles the `guild_ephemeral_*` events. These
    messages are tinted, have Dismiss, and have no menus or reactions.
  - **Forms:** `BotModal`, mounted once in Layout.
- **Checked with real libraries** (2026-10-03): discord.js 14.27 (`commands.set`, ephemeral
  replies, buttons with `update()`, selects, `showModal`, `deferReply` + `editReply`,
  autocomplete, user context menus) and discord.py 2.7.1 (`tree.sync`, a button `View`,
  a `Modal`).

Voice channels' chats (2026-10-06, see Voice channels' chat in `docs/guilds.md`) are Discord's:
a type 2 channel takes the message, reaction, pin and typing routes and sends MESSAGE_CREATE and
the rest like a text channel, with its `last_message_id`; threads still need a text channel
(`50024`).

### Voice (`routes/botApi.js`, `server/voice.js`)

Decided 2026-10-05: bots join voice channels with **LiveKit's own SDKs** (Node
`@livekit/rtc-node`, Python `livekit`, Go, Rust...), not Discord's voice protocol: Voicaw's voice
is a LiveKit room, so a bot gets a token like the app does and no audio passes through the API.
A Discord-compatible voice bridge (Discord's voice websocket + UDP, re-encoding into LiveKit,
maybe DAVE) may come later. Audio only: bots never get Video (`voice.canStreamWith`).

- **Projecting and listening are separate**: Speak (send audio, as before) and **Listen**
  (`PERMISSIONS.LISTEN`, hear the others; Discord bit 61, Voicaw's own). LiveKit enforces both
  (`canPublishSources` / `canSubscribe` in the token, changed live by `enforceGuild`). Listen is
  a normal permission for everyone (@everyone has it by default; migration 12 gave it to
  existing guilds), but **@everyone's Listen never counts for a bot** (`permissions.js`
  `everyoneBits`, also an @everyone channel override's allow): a bot hears only if Listen comes
  from its own role, another role, or an override for those or for it. Speak, like Connect,
  does come from @everyone (as in Discord). Bots that can hear show an ear in the voice list and
  the call tiles; the invite's checkboxes have "Listen (hear voice channels)".
- **Endpoints** (Voicaw's, under the bot API): `POST /channels/:id/voice` (View Channel +
  Connect; body `{ self_mute, self_deaf }`) answers `{ url, token, room, identity, expires_in,
  speak, listen }`, a 10-minute LiveKit token to connect with (LiveKit keeps a connected one
  fresh; joining another channel leaves the first); `GET /guilds/:id/voice-states/@me` (or a
  user id; Discord's shape plus `listening`); `PATCH /guilds/:id/voice-states/@me` (`self_mute`,
  `self_deaf`, or `channel_id: null` to leave); `DELETE /guilds/:id/voice-states/@me` leaves.
  The bot is then a voice participant like anyone (LiveKit's webhooks put it in `voice.states`),
  so VOICE_STATE_UPDATE goes to bots with Guild Voice States, and GUILD_CREATE's
  `voice_states` lists who's in the voice channels the bot can see. Gateway op 4 (Discord's
  voice join) is still ignored.
- **Channel settings and regions** (2026-10-07, see Channel settings and Voice regions in
  `docs/voice-and-calls.md`): voice channels' `bitrate`, `user_limit` and `rtc_region` (a
  voice region's id as a string, null Automatic) are the channel's own and can be set on
  create and `PATCH /channels/:id` (Manage Channels); `GET /voice/regions` and
  `GET /guilds/:id/regions` list the regions (`optimal`: the default). The join token answers
  with the channel's region's `url`. When a channel moves to another region a bot in it is
  disconnected, to join again with a new token.
- **Checked** (2026-10-05, e2e's throwaway API with its own LiveKit): a Node bot
  (`@livekit/rtc-node`) publishing a tone with Speak; a bot with Listen hears it (Node, and
  Python `livekit`); a bot without Listen gets no audio at all (LiveKit refuses to subscribe it).

## Levels (Voicaw's own)

A guild's levels (see Levels in `docs/guilds.md`; `server/guildLevels.js`'s actions, shared with
the app) under the bot API, snake_case like the rest; Discord has nothing like them.
- `GET /guilds/:id/levels`: `{ enabled, xp_per_level, xp_name, level_name, level_short_name,
  show_in_member_list, message_cooldown, sources: { message, reply_received, reaction_received,
  mention_received, reaction_given, thread_created, document_created, task_completed,
  voice_minute: { enabled, xp } } }` (names the guild left empty read as "XP", "Level", "lvl").
  `PATCH` it (Manage Guild) with any of those fields.
- `GET /guilds/:id/levels/members?limit&offset` (1–1000, default 100): the leaderboard, most XP
  first; `GET /guilds/:id/levels/members/:user_id` (or `@me`): one member. Each is `{ guild_id,
  user_id, xp, level, rank, xp_per_level }`.
- `PATCH /guilds/:id/levels/members/:user_id` (Manage Levels) with exactly one of `{ xp }`,
  `{ level }` (set), `{ add_xp }`, `{ add_levels }` (add; below 0 subtracts, never under 0).
  Answers the member's new object.
- Gateway: `GUILD_MEMBER_LEVEL_UPDATE { guild_id, user_id, xp, level, previous_level }` (Guild
  Members intent) whenever someone's level changes, or their XP is set by hand, so a bot can
  announce level-ups or give roles. discord.js and discord.py ignore events they don't know
  (read it from the raw packet: `client.on('raw')`, `on_socket_raw_receive`).
- Bots never earn XP themselves (they can be given some).

## Login with Voicaw (`server/oauth.js`)

Built 2026-10-06: Discord's OAuth2 **authorisation code grant**, so a website that logs people
in with Discord works with Voicaw by changing its URLs (and ids, which are ours). Any
application (the same ones as bots) can use it; public docs at `/developers/docs/login/`.

- **Only `identify`**: the person's id, username, display name and picture (`D.userObject`),
  nothing else (no email: we have none; no `guilds`). Combined with `bot`, or with no scope, a
  link is still a bot invite (`isBotInvite` in routes/applications.js and AuthorizePage).
- **Portal** (ApplicationPage's OAuth2 tab): a client secret (`POST
  /applications/:id/client-secret`, shown once, SHA-256 in `bot_applications.client_secret_hash`)
  and up to 10 redirect URIs (`redirect_uris` JSON, through `PATCH /applications/:id`): https,
  or http to localhost / 127.0.0.1 / [::1], no fragment or user info, matched exactly; a link
  may leave `redirect_uri` out when there's only one. Plus a copyable authorise link.
- **Consent** (the app's `/oauth2/authorize?client_id&response_type=code&scope=identify&redirect_uri&state[&prompt=none]`,
  `LoginConsent` in AuthorizePage): `GET /api/oauth2/authorize` (logged in) checks the link and
  answers the application, owner, scopes, redirect and `authorized` (already let in, with a token
  that still works or refreshes); `POST` with the same fields (and `deny`) answers `{ location }`,
  the redirect with `code` and `state` (or `error=access_denied`), which the page goes to. An
  unknown client or redirect URI is shown, never redirected to; a bad scope or response type
  goes back to the site as `error=…` (RFC 6749 4.1.2.1). `prompt=none` skips the question when
  `authorized`, as Discord's. Pending, suspended and bot accounts can't (authenticateJWT, `usableUser`).
- **Codes and tokens** (`oauth_codes`, `oauth_tokens`; SHA-256s only): a code lasts 10 minutes and is
  deleted as it's read (`DELETE … RETURNING`), so a failed exchange uses it up too; it must be
  the application's and, if the exchange names one, the same `redirect_uri`. Access tokens last
  7 days (Discord's); a refresh token works once (the pair is replaced), until revoked, or 30
  days after its access token ran out (rows past that are deleted on the next exchange).
- **Bot API side** (routes/botApi.js): `POST /api/v10/oauth2/token` (form or JSON; client id and
  secret in the body or Basic; RFC 6749's `{ error, error_description }`; 30 a minute per
  address), `POST /oauth2/token/revoke` (RFC 7009: unknown tokens are fine), `GET /users/@me`
  with `Bearer` (`loginAuth`, needs `identify`), `GET /oauth2/@me`. A login token opens nothing
  else, and isn't a login to the app's own API.
- **Settings → Authorised apps** (`AuthorisedApps.jsx`; `GET /api/oauth2/authorised-apps`,
  `DELETE /api/oauth2/authorised-apps/:appId`): the applications with a live token, removing one
  deletes its tokens and codes. Deleting the application (`bots.deleteApplication`) or the
  account (`accounts.deleteAccount`) does too; a suspended account's tokens don't work while it is.
- **Privacy**: what the site gets and that it's up to its maker is on the consent page and in
  the privacy policy ("Websites you log in to with Voicaw").

## Bot DMs (`server/botDms.js`)

Built 2026-10-06 (first for slotto's game reminders): a bot and one person can have a direct
conversation, as Discord's DM channels (type 1). **Not end-to-end encrypted** (bots have no
keys): tables `bot_dms` / `bot_dm_messages`, plain text like a guild's, entirely separate from
people's encrypted DMs, which bots still never see. The app says so on every one.

- **Who**: `checkAllowed` on opening and on every message, both ways: a person (not deleted,
  suspended, pending or a bot), a bot that still exists, a shared guild, no block between them
  (`blocks.blockedBetween`; bots can now be blocked, `routes/blocks.js`), and the person's
  `botDms` preference (Settings → Content "Let bots message me", on by default, `preferences.js`).
  Refusals are Discord's 50007.
- **Bot API** (routes/botApi.js): `POST /users/@me/channels` (`recipient_id`) opens or finds it.
  DM channel ids are `CHANNEL_BASE` (2^41) + the row's id and DM message ids `MESSAGE_BASE` (2^42)
  + theirs, so neither clashes with a guild's; `inChannel` answers a DM id with 50003, and the DM
  routes (`inDm`, which passes other ids on with `next('route')`) come first: get the channel,
  list messages (before/after/around), get one, send (botMessages.readNewMessage: content,
  embeds, files; components refused, message_reference ignored), edit and delete its own,
  typing (204, shows nothing). Messages are `D.messageObjects` without `guild_id`.
- **Gateway**: `bot_dm_message_new` / `_edit` / `_delete` (sent to the bot's sockets like the
  person's) → MESSAGE_CREATE / _UPDATE / _DELETE with the Direct Messages intent, on shard 0.
- **App** (routes/botDms.js, logged in): list (`/bot-dms`, with each bot's profile and unread),
  start one from a bot's member card (`POST /bot-dms`, same rules), messages (pages of 50), send
  plain text (2000 characters, 10 per 10 s), edit and delete your own, read, and delete the whole
  conversation (gone for the bot too). Pushes are `bot_dm` (plain title and body, like a guild
  mention's) unless you're looking (`bot-dm-<id>`) or muted it (conversation settings kind
  `bot`). Files the bot sends are `bot_dm` upload refs (uploads.js).
- **Client**: `useBotDmList` (LayoutContext.botDmList; counted with groups for the rail, favicon and
  desktop badge), rows in DmSidebar (BOT tag; DmMenu without calls), `BotDm` at `/dm/b/:dmId`
  ("Not encrypted" in the header, a notice above the messages, delete in the header) over
  `useBotDm` and ChatPane with `textOnly` (no files, polls or replies; no reactions or pins).
- **Goes** with the conversation, the person's account (`accounts.deleteAccount`) or the
  application (`bots.deleteApplication`, which tells the people).
- Not yet: reactions, pins, replies, components and commands in DMs, typing shown, and the
  bot's DM list in READY (`private_channels` stays empty).

### Not done yet

Discord-compatible voice (see Voice), webhooks managed with a bot token, nicknames, timeouts and server mute,
stickers, polls through the API, creating guilds, forwarding, creating or
editing categories, the audit log endpoint. Invites are per guild (a channel's invite only
echoes the channel back). For interactions: Discord's HTTP interactions endpoint (outgoing
requests to bots), Components V2 layouts, premium buttons, entitlements, activities,
per-command permission overrides, localised names shown to people (accepted and returned, not
used), and commands in DMs.
