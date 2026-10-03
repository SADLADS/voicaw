# Bots

## Bots (Discord's bot API)

Bots are programs that act in guilds through **Discord's API v10** (REST and the gateway), so
Discord's libraries (discord.js, discord.py, ...) work by changing their URLs. People make them in
the developer portal in the app; public documentation for bot authors is on voicaw.com
(`website/`, `/developers/docs/`). Decided 2026-10-03: library-compatible, guilds only, no
privileged intents, anyone can make applications (25 each), slash commands later.

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
  DM calls (`calls.userById`) and group DM membership (`groupDms.checkEntry`) refuse them. The
  bot API answers DM attempts with Discord's 50007. Bots only ever see people through their
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
  `deleteThread`, `setThreadMembership` (routes/threads.js). Message bodies (content, embeds,
  files, `allowed_mentions`, flags) are checked by the webhook code (`routes/webhooks.js`
  exports its helpers), so bots' messages can have embeds and files like webhooks'.
- **Endpoints**: gateway (`/gateway`, `/gateway/bot`), users (`@me` get/patch, guilds, leave,
  `/users/:id`), applications (`@me`, `oauth2/applications/@me`; commands: GET is `[]`, writes
  are refused until application commands exist), guilds (get, channels, create channel, roles
  incl. positions, emoji, members list/search/get/patch roles/role add and remove/kick, bans,
  invites, active threads), channels (get, patch, delete, overwrites, invites, typing),
  messages (list with before/after/around, get, send with replies and files, edit own, delete,
  bulk delete), reactions, pins (old and new paths), threads (from a message or on their own,
  join/leave, members, archived). Rate limits: 50 requests a second per bot, and per route and
  channel or guild, with Discord's `X-RateLimit-*` headers and 429 bodies (off with
  `DISABLE_RATE_LIMITS`, as in tests).
- **CDN**: `/api/cdn/avatars/:id/:hash.*`, `/icons/:guildId/:hash.*`, `/emojis/:id.*` redirect to
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
  Use Voice Activity by Speak; Create Guild Expressions by Manage Emoji). Edit Tasks and Create
  Documents are ours only (bits 56 and 57). Coming in, only the bits that stand for ours count.
  The client has a copy of the mapping for the portal's checkboxes (a test checks they match).
- **Messages**: Discord's message object, with `member` (gateway), `mentions` (users named in
  the text), `referenced_message` for replies, reactions summed per emoji (`me` for the bot),
  embeds and attachments; system rows map to Discord's types (thread started 18, poll result
  46). Content is always included: there's no message content intent to need.

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
  voice states, emoji). `guild_reaction_remove` carries `userId` and `emoji` for this. Guild
  changes arrive as a whole new layout (`guild_update`), so the session keeps what it last sent
  of each guild and sends the differences (CHANNEL_CREATE/UPDATE/DELETE, GUILD_ROLE_*,
  GUILD_UPDATE). A session counts as the bot being online (statusOf), unless it set Invisible.
- **Checked with real libraries** (2026-10-03, against e2e's throwaway API): discord.js 14.27
  (rest `api` and `cdn` options) and discord.py 2.7.1, which needs `Route.BASE` *and*
  `DiscordWebSocket.DEFAULT_GATEWAY` set: discord.py ignores `GET /gateway` and would otherwise
  send the token to Discord's own gateway (the public docs warn about this).

### Not done yet

Application commands and interactions (slash commands, buttons and other components: a later
phase), voice, webhooks managed with a bot token, nicknames, timeouts and server mute,
stickers, polls through the API, scheduled events, creating guilds, forwarding, creating or
editing categories, the audit log endpoint. Invites are per guild (a channel's invite only
echoes the channel back).
