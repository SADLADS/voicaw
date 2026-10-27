# Messages: emoji, markdown, GIFs, YouTube links, link previews, polls, mentions, pins, drafts, the message list

## Emoji (Discord-style, default Unicode set)

Messages store plain Unicode emoji; there is no server-side emoji data. `client/src/emoji/`:
- `emojiIndex.js`: emoji data from `@emoji-mart/data` (`sets/15/twitter.json`, lazy-loaded) and
  Twemoji art from `@twemoji/svg` (both Unicode 15, so every emoji has an image; a test checks
  this). It provides search, a shortcode map, and a matcher for emoji in text. `twemojiFile()`
  gives Twemoji's file-naming rule.
- Images are **self-hosted** at `/emoji/<file>.svg` by the `twemojiAssets` plugin in
  `client/vite.config.js`: served from the npm package in dev, copied into the build otherwise,
  and not precached. There is no CDN and no setup for a new install. The artwork is CC-BY 4.0,
  so keep the attribution in Settings. The service worker caches them cache-first (cache
  `emoji-<twemoji version>`), so each is fetched once per device.
- **The picker draws standard emoji from sprite sheets**, like Discord (`emoji/emojiSheets.js`):
  one WebP per category (default tone) plus one per skin tone holding only the emoji with
  tones, 16 columns of 56px cells, ~1.7 MB for the eight category sheets. One SVG per emoji used to
  fill in a cell at a time on any device that hadn't seen them. The layout comes from the
  emoji data (`spriteMap`, in the index as `sprites`), so there's no map file; each cell is a
  span with an `emoji-sheet-<name>` class (the picker's `<style>`, `sheetCss`) and an inline
  `background-position`. `twemojiAssets` makes them with `sharp` (a client dev dependency)
  once per key into Vite's cache folder (`node_modules/.vite/emoji-sheets/`, ~10 s), and
  serves or copies them at `/emoji/sheets/<key>/<name>.webp`; the key holds the Twemoji and
  emoji data versions, `LAYOUT_VERSION` and the cell size, so a change gets new URLs. The
  service worker caches them like the SVGs and fetches the category sheets (and the six
  default quick reactions' SVGs) when it installs, so even the first picker is instant.
  Custom emoji in the picker still load one by one, only once within a screen of the visible
  area (its own `IntersectionObserver`, not `loading="lazy"`, which queued hundreds of
  offscreen images ahead of the visible ones). The picker's images (custom emoji, the few
  standard ones not on a sheet, the preview) are `LoadingImage`s: transparent (`emoji-loading`)
  until they load, and for good if they fail, so a cell is blank rather than a broken-image
  icon and the emoji's name.
- **The picker opens at once** (2026-10-19): it draws its first 120 emoji (a screenful) as it
  opens, then 150 more after each frame until all ~1,900 are there; drawing them all at once held
  a phone up for about half a second (`e2e/mobileperf.mjs`). Jumping to a category draws the rest
  at once. Its buttons are memoised with one `onPick` for good, so drawing more, or hovering,
  doesn't redraw the ones already there.
- Everywhere else (the message box while typing, names, previews, buttons) emoji are Twemoji
  too, via a colour font: `assets/css/twemoji-font.css` is first in the body font stack, limited
  by `unicode-range` to its emoji (not the digits, `#`, `*`, ©, ® it also has). A text box can't
  show images, so this is how typing looks right. Bundled into `/assets/`, loaded once an emoji
  is on screen. The font, `assets/fonts/twemoji-voicaw.woff2` (COLR, Twemoji 15, SIL OFL, credited
  in Settings), is generated from the `twemoji-colr-font` dev dependency by
  `client/scripts/patch-twemoji-font.py` (fonttools): Chrome and Safari drop U+FE0F before the
  font sees the text, so its ligatures for sequences containing FE0F (🏳️‍🌈, ❤️‍🔥, 🧔‍♂️…) never
  matched and showed as two emoji; the script adds FE0F-less copies. Re-run it after updating
  the package.
- `EmojiProvider` (in `App.jsx`) loads the index. `rehypeTwemoji` turns emoji in rendered
  messages into `<img class="emoji">` (skipping code). `MessageList`'s `MarkdownImage` passes
  those through (not to `Attachment`), and emoji-only messages get `.emoji-only` (large).
- The message box is `editor/MessageEditor.jsx`, a small ProseMirror editor (also used for editing a
  sent message). Its value is plain message text (`editor/messageDoc.js`): lines are paragraphs,
  draft attachments are chips (so are a sent message's attachments while editing it, kept as
  their exact `![name](url)`, so the link and its key never show), custom emoji `<:name:id>` are inline images. Markdown shows as
  it will look while typing, like Discord's box (`editor/markdownPreview.js`, drawn as
  decorations, so the text and its markers stay exactly as typed, markers dimmed): bold,
  italic, underline, strikethrough, spoilers, inline code, ``` code blocks and `>` quotes (not
  headings: Discord doesn't preview them either). It's a line-by-line approximation of how
  messages are rendered (see Message markdown). Unicode emoji stay text, drawn by the Twemoji font, so
  typing, autocorrect, IME and copy/paste stay plain. Pasting is always plain text (files go to
  attachments). Copying or cutting from the box writes message text (`sliceToText`: custom
  emoji as `<:name:id>`, mentions as `<@id>`...), so pasting them back gives the emoji and
  mentions again (elsewhere they paste as that markup); edits past the length limit are refused. Saving an edit left empty or
  only whitespace cancels it (`ChatPane`). Enter sends on desktop, Shift+Enter is a
  new line; on mobile Enter is a new line. The ref handle (`focus`, `blur`, `insertText`,
  `replaceBeforeCaret`, `insertAttachments`, `removeAttachment`, `clear`...) is how `Composer`
  and `Dm` drive it.
- Opening a conversation (DM, group DM, notes, guild channel, thread) focuses its message box
  on a computer (web and desktop app), so typing goes straight in; `Composer` does it whenever
  `chatId` changes. Not on a phone or tablet (it would bring up the keyboard), not while another
  text box has the focus (a search left open after jumping to a result), not for a document's
  replies (the document has it) and not for a channel with a thread open beside it (the thread
  has it): `ChatPane`'s `focusOnOpen`. `e2e/focus.mjs` checks it.
- Composer (`Composer.jsx`): `EmojiPicker` (search, categories, frequently used and skin tone, both
  following the account, encrypted: `emojiUsage.js`, see Emoji usage in
  `docs/auth-and-encryption.md`; on a computer its search box is focused on opening and on
  switching between the Emoji and GIFs tabs), `:sm` autocomplete (`EmojiSuggestions`), and a completed
  `:shortcode:` turns into the emoji as you type. `remark-emoji` still renders any leftover
  `:shortcode:` text.
- Mobile: the picker is `docked` in the on-screen keyboard's place, at its height
  (`utils/keyboardHeight.js` measures it via `visualViewport`, see On-screen keyboard in `docs/client.md`, and remembers it per device). It and
  the keyboard are never open together: opening it blurs the message box, and the button (⌨️ while
  open) or focusing the message box swaps back. Picks don't close it. It's a bottom sheet
  (`hooks/useSheetDrag.js`): swiping it up (anywhere: while docked the grid doesn't scroll, the
  swipe pulls the sheet) or tapping its handle makes it full screen; swiping down on its top bar,
  or on the grid once it's scrolled to the top, or the handle again, brings it back. It follows
  the finger and settles by flick speed or a 60px drag; a spacer keeps its place meanwhile so the
  chat doesn't jump. Emoji and GIFs both, and the reaction picker. Searching is the one
  exception: tapping its search box (never auto-focused, since iOS only opens the keyboard for a
  real tap) switches to full-screen search, sized to the visible area above the keyboard
  (`utils/useVisualViewport.js`, unrounded, plus 1px hidden under the keyboard so no seam shows).
  On Chromium (Chrome/Brave Android) the visual viewport height is wrong there: with the address
  bar at the bottom it comes out one toolbar short, leaving a gap. So during search only, the
  search box turns on `navigator.virtualKeyboard.overlaysContent` (on pointerdown, before the
  keyboard opens) and the picker runs to the keyboard's exact `boundingRect` top
  (`utils/virtualKeyboard.js`). It's switched off again on leaving search or closing. Add
  `?kbdebug` to the URL to show the numbers on screen.
  Picking (or Enter) or going back returns to the docked panel and dismisses the keyboard. If the
  keyboard closes some other way (search box blurred, or Android's back button with focus kept),
  it returns to the docked size and keeps the results. Result taps don't take focus from the
  search box, so the picker can't shrink mid-tap. `MessageList` keeps the chat pinned
  to the bottom when the list's own height changes (a `ResizeObserver` on the scroller, plus
  ignoring the browser's scroll-anchoring nudge during that resize).
- Custom (guild) emoji (see Guilds): the picker shows each of your guilds' emoji after Frequently
  Used and before the standard categories, in your rail order, with the guild's icon in the
  category bar; search, `:name` suggestions and a typed `:name:` include them (standard
  shortcodes win a name clash). Picking gives `<:name:id>` (Frequently Used keeps them as
  `custom:<id>`). `rehypeTwemoji` renders them in messages (`data-custom-emoji`, which
  `MarkdownImage` turns into `CustomEmojiImage`), reactions show them too (a reaction's 64
  padded bytes fit one), and plain-text places (reply previews, copying, notifications) show
  `:name:` (`customEmojiToText`). Emoji-only messages count them.
- Reactions (see End-to-end encryption): `MessageReactions` chips under a message (grouped by
  emoji, each person counted once, yours highlighted; tap to toggle, `+` to add). The message
  menu's smiley opens `EmojiPicker` for it: floating by the button on desktop
  (`reactionPickerPosition`, a zero-size fixed `.reaction-picker-anchor`), docked in the keyboard's
  place on mobile, closing after the pick. Search matches several words ("thumbs up").
- Who reacted (Discord's): hovering a chip with a mouse shows a card over it (`ReactionCard` in
  `MessageReactions.jsx`, portalled, fixed, below the chip when there's no room above): the
  emoji big and ":+1: reacted by A, B, C and 2 others" (three names, the emoji's shortcode from
  `reactionShortName`: a custom emoji's name, a Unicode one's emoji-mart id). Clicking the card,
  the message's right-click View Reactions (after Add Reaction, once it has reactions, also
  without Add Reactions; `ChatPane` shows that one), on a phone the action sheet's View
  reactions (first of its actions, same rule) or holding a chip (instead of the message's
  action sheet), opens `ReactionsDialog`:
  PollVoters' layout, a tab per emoji with its count, who reacted (pictures, in the order they
  reacted), live as reactions change, your own with a × taking it back; it closes once the last
  reaction goes. Chips you can't tap (no Add Reactions) are `aria-disabled`, not `disabled`, so
  they still show who reacted. Nothing new reaches the server: it's drawn from the reactions the
  page already has (decrypted, in encrypted chats).

## Message markdown (Discord's set)

Messages are rendered by react-markdown with `remark-gfm` (strikethrough, bare links) and
`utils/remarkDiscord.js`, which makes it Discord's markdown: `__text__` is underline (`<u>`),
`||text||` a spoiler (hidden until clicked, `Spoiler` in `MessageList`; formatting works inside,
code doesn't turn into one), and what Discord doesn't have stays as typed (micromark constructs
switched off: indented code, `---` rules, `===` headings, tables, task lists, footnotes,
`[x]: url` definitions; `####` and deeper headings are turned back into text). Kept: bold,
italic, strikethrough, code, code blocks, `#`–`###` headings, `>` quotes, lists, links.
Links always open in a new tab (`MarkdownLink`; the desktop app sends them to the browser):
following one in the app's own page would unload it, and LiveKit leaves voice on unload, even
when the desktop app then cancels the navigation. Links to the app's own pages are the
exception (`AppAwareLink`, `guildDisplay.js` `appPathOf`: the address it shares links from,
or app.voicaw.com on the built-in server, and a path the app has: a guild, channel, event,
invite, DM, settings or the developer portal): a plain click opens them in place, with the
router, in every app (browser, desktop, Android); Ctrl, Shift or a middle click still opens a
new tab.
Plain-text places hide spoilers as `[spoiler]` (`hideSpoilers`: reply previews, DM push
previews; `server/mentions.js` does the same for guild pushes). Copying a message keeps its
markdown. Styles are at the end of `dms.css` (MESSAGE MARKDOWN); only the text inside blocks
keeps its line breaks (`pre-wrap`), and blank lines between blocks (which markdown folds into
one paragraph break) are counted from the source and drawn as empty `.blank-line` paragraphs,
so every newline typed shows.

## GIFs (Klipy)

The emoji picker in the message box has an Emoji / GIFs tab bar when the server has a Klipy key
(`/api/config` `gifsEnabled`; read when the app loads). `components/GifPicker.jsx` shares the
picker's search box (so mobile docked search works the same), shows Trending or Favourites
without a query, loads pages as you scroll, lays GIFs out in two shortest-first columns, and
has a star on each for favourites. It always opens on the Emoji tab.
- **Server** (`routes/gifs.js`): `GET /gifs/trending|search?q=&page=` proxy Klipy, so the key
  stays on the server and Klipy gets an HMAC pseudonym per user (`customer_id`), not who's
  searching. Results are cut down to `{ id, title, url (hd WebP), width, height, preview (sm),
  previewWidth, previewHeight }`; ads and anything not on `https://static.klipy.com/` are
  dropped. Favourites: `gif_favorites`, `GET /gif-favorites` (newest first), `PUT/DELETE
  /gif-favorites/:id` (max 500; only Klipy URLs), so they follow you between devices.
- **Sending:** picking one sends it at once as its own message (replying if a reply is set;
  the typed text stays): `![GIF](<url>#gif&w=<px>&h=<px>)` (`utils/gifMarkup.js`), inside
  the encryption in DMs/groups. `Attachment` reserves its box from the fragment and loads it
  straight from Klipy's CDN with `referrerPolicy="no-referrer"`. So in encrypted chats Klipy
  can see the IP addresses of people viewing a GIF (not the chat or its text). Reply previews
  show "📎 GIF".
- **Privacy** (Settings → Privacy, "Show GIFs straight away", `gifs`, on by default): turned
  off, a GIF in a message is a box of its size with Show (`Attachment.jsx` `GifView`), and the
  picker's GIFs tab says Klipy sees your IP address and which GIFs you look at, loading nothing
  (not even our search) until "Show GIFs anyway". Both are remembered until the app reloads
  (per GIF, and for the picker).

## YouTube links

A YouTube watch, share, shorts, live or embed link (`utils/youtube.js`; music.youtube.com too) gets a player under the message
(`UrlPreviews.jsx`), from youtube-nocookie.com, which sets no cookies until it's played but
still tells YouTube the viewer's IP address and the video, in encrypted chats too. With
Settings → Privacy's "Show YouTube videos straight away" (`youtubeEmbeds`, on by default) off,
a placeholder with the link and Play stands in (no thumbnail, which would come from YouTube
too); Play loads the player autoplaying, and it stays loaded until the app reloads.
On a phone (`isMobile`), as in Discord, the message never holds the player: touches on
YouTube's cross-origin frame never reach our page, so a swipe starting on it couldn't move the
panes or reply. It shows the video's thumbnail instead (`i.ytimg.com/vi/<id>/hqdefault.jpg`,
also YouTube's, so it tells YouTube the same as the player; with the setting off, the
placeholder), and tapping it plays the video full screen (`YouTubeViewer.jsx`, on the image
viewer's toolbar: Open on YouTube, X; autoplaying). Back closes it like the image viewer: it's a
history entry of its own (`hooks/useBackCloses.js`), checked in `e2e/youtubeviewer.mjs`.
Voice channels can watch YouTube videos together (Watch Together, see Voice channels in
`docs/voice-and-calls.md`).
The desktop app adds the Referer YouTube requires (`https://app.voicaw.com/`), since its
`voicaw://` pages send none (`electron/youtube.js`, see `docs/desktop-and-site.md`).

## Link previews

Links in messages get previews, Discord style, worked out differently by whether the chat is
end-to-end encrypted. Which links count is the same on both sides (`server/linkPreviews.js`
`linksIn`, `client/src/utils/linkPreviews.js`, tested alike): at most 5 per message, not in code,
spoilers or a markdown image, and not written as `<https://…>` (the way to keep a link plain).
YouTube links and guild invites keep their own player and card (`UrlPreviews.jsx`).

- **Guilds** (not encrypted, so the server already has the text): after a message is sent or
  edited (people's, bots' and webhooks'), the server fetches its links (`linkPreviews.js`
  `refreshLinkPreviews`, not awaited; an edit that keeps the same links fetches nothing) and
  keeps Discord-shaped embeds in `guild_messages.link_embeds` (and the links they were made for
  in `link_urls`), then sends `guild_message_embeds` (bots: MESSAGE_UPDATE, where `embeds` is
  the message's own followed by these, as in Discord). A page gives its OpenGraph / Twitter
  card (`embedFromHtml`: site name, title, description cut at 350, `theme-color` as the bar,
  `og:image` large with `summary_large_image` or a video, else a thumbnail, and an `og:video`
  that is an MP4/WebM/QuickTime/Ogg file); a link to a picture (`image`, size read from its
  header with sharp) or a video (`video`) is shown as itself. Fetching (`safeFetch.js`): http(s)
  on ports 80/443 only, every address checked to be public (no loopback, private, link-local,
  CGNAT, multicast, IPv4-mapped or NAT64 ones), the check done on the address actually
  connected to and again on each of up to 5 redirects, 5 s in all, at most 1 MB of a page,
  256 KB of a picture and nothing of a video; `User-Agent: VoicawBot/1.0`. Results are cached
  per link in memory (an hour; failures 10 minutes), 4 fetches at a time, 100 waiting at most.
  Settings → Admin's **Link previews** (`appSettings.js` `linkPreviews`, `LINK_PREVIEWS=off`)
  turns the fetching off for the whole app. Pictures aren't copied: readers load them straight
  from the site (no referrer), as with webhook embeds. The previews' text isn't in search.
- **DMs, group DMs and notes** (encrypted): the server never sees the links, so it makes no
  previews. A link whose address ends in a picture's or a video's file name (`mediaLinkKind`:
  png, jpg, gif, webp, avif, bmp; mp4, webm, mov, m4v) shows that file, loaded by the reader's
  browser from the site. Other pages get a preview only from a sender using the desktop or
  Android app, as Signal does: the message is sent as usual, then the sender's app fetches its
  links (`services/linkPreviewService.js` `previewsFor`; not YouTube, invite or media links,
  and nothing with "Show link previews" off) through its native side, which can read other
  sites (a web page can't, and asking our server would tell it the link): `electron/pageFetch.js`
  (the server's `safeFetch.js`, copied; a test keeps them the same) or `PageFetch.java` (its own
  sockets, to the address it checked), both public addresses only, ports 80/443, 5 redirects,
  5 s, a page's first 1 MB, nothing of a picture or video. `utils/pageEmbed.js` (a copy of
  the server's `embedFromHtml`, tested alike) reads the card. The embeds go encrypted beside the
  message (`services/linkPreviewCrypto.js`): `PUT /dm-messages/:id/link-previews` or
  `/group-dm-messages/:id/link-previews` `{ previews }` (the sender only; null removes) stores
  them in `link_previews` and sends `dm_link_previews` / `group_dm_message_link_previews`; an
  edit clears them and the sender's app makes them again. The payload is
  `{"v":1,"content":<base64 SHA-256 of the message's stored ciphertext>,"embeds":[...]}`,
  encrypted with the conversation's key under `voicaw/link-previews/v1|<message id>|<sender>|<recipient>`
  (groups: the message's epoch key, `voicaw/group-link-previews/v1|<group>|<epoch>|<message id>|<sender>`,
  signed by the sender like messages, `voicaw/group-link-previews-sig/v1|…`), so the server can't
  move them to another message or keep them past an edit, and a group member can't make them for
  someone else's. Readers check them again (`checkedEmbed`: only for links in the text, 5 at most,
  only an embed's fields and http(s) addresses) and draw them as guild previews
  (`link_embeds`). Up to 16 KB before encryption (`MAX_LINK_PREVIEWS_BYTES`). Older apps ignore
  the field.
- **Drawing:** `MessageEmbeds` with `links` (after the message's own embeds and files): a page's
  card (its description plain text, not markdown: it's another site's words), a picture
  (`LinkMedia.jsx` `SiteImage`: opens in the image viewer, draws nothing if it fails to load)
  or our video player (`SiteVideo`). Covered in an NSFW channel like other media.
- **Settings → Privacy's "Show link previews"** (`showLinkPreviews`, per device, on by
  default): off, links to other sites get nothing drawn under them: no guild cards
  (`MessageEmbeds` with `links`), no YouTube players and no linked pictures or videos in
  encrypted chats (`UrlPreviews`), so nothing loads from those sites. Voicaw's own invite and
  event cards and bots' and webhooks' embeds still show. Only this device's display changes:
  the server still makes guild previews for everyone else. The desktop and Android apps also stop
  fetching links for previews of the encrypted messages sent from them. The setting below is then moot
  (greyed out).
- **Settings → Privacy's "Show pictures and videos from links straight away"** (`linkPreviews`,
  per device, on by default): off, other sites' pictures (link previews', links to pictures,
  webhook and bot embeds' unless they're the message's own files; their small author and
  footer icons are left out) wait behind Show (`SiteMediaGate.jsx`, "Picture from <site>"),
  and videos are given nothing to load before Play. A guild card's text still shows: it comes
  from our server, so no other site learns anything.
- **Remove Previews** (message menu, phone action sheet; the author, or Manage Messages):
  `PUT /guild-messages/:id/suppress-embeds` (`{ suppress: false }` undoes it) sets Discord's
  SUPPRESS_EMBEDS flag, which hides the message's embeds, link previews and YouTube/invite
  cards for everyone (`guild_message_embeds` with `flags`). Guilds only. On a computer, as in
  Discord, an X beside each link preview, YouTube player or invite/event card (shown while it's
  hovered; `RemovableEmbed`, for the same people) does the same, asking first unless Shift is
  held. A bot's or webhook's own embeds have no X (the menu still removes them).
- **Who sees what:** the sites linked in guilds see our server ask for the page (not who
  posted it); the sites linked in encrypted chats see the sender's desktop or Android app ask
  (their IP address, as opening the link would), and our server sees only that a message has
  previews and their size; the sites whose pictures or videos are shown see each reader's IP
  address, in any chat, unless the setting is off. Checked in `e2e/linkpreviews.mjs` (the
  encrypted chats' previews in `e2e/dmlinkpreviews.mjs`).

## Polls

Any chat (DM, notes, group DM, guild text channel) can have polls: the composer's `+` opens a
menu (Upload a file / Create poll). `PollDialog.jsx` takes a question (300), 1–20 answers (55
each, each with an optional emoji: Unicode or a guild's custom one, from `EmojiPicker` over the
dialog; Escape there closes only the picker, since `EmojiPicker` marks it handled and `Modal`
skips handled Escapes; Tab goes question → answers → Add another answer, skipping the emoji
and remove buttons), a duration (1h, 4h, 8h, 24h (default), 3d, 1w, 2w), "Allow multiple
answers" and "Open poll" (see Open polls below); none of those three can be changed after
posting. A poll is sent as its own message (replying if a reply is set, like a GIF).
- **Format** (`utils/pollMarkup.js`): the message text is `poll:v1:` + JSON `{ q, multi, d, x?,
  o: [{ id, t, e? }] }` (`e`: the answer's emoji, drawn like a reaction's, `ReactionEmoji`; ids:
  8 random `[a-z0-9]`; `d`: seconds it runs; `x`: unix s its author ended it), so in encrypted
  chats it's inside the encryption.
  `MessageList` draws it with `Poll.jsx` in two phases, like Discord's: **voting** (tapping
  answers only selects them; Vote sends the choice, Show results peeks; on a phone Vote gets a
  full-width line of its own above the footer) and **results** (once
  you've voted: bars and counts; Remove vote, or Back to vote if you only peeked). Tapping an
  answer in the results opens `PollVoters.jsx` (a tab per answer, who voted for it). The
  pinned list shows results only; plain-text places show "📊 Poll: <question>" (`summarizeAttachments`, and
  `server/mentions.js` for guild pushes). An app from before polls shows the raw text.
- **Votes are reactions** whose emoji is `poll:<option id>`, so they're stored, encrypted,
  signed (groups) and delivered exactly like reactions, and in encrypted chats the server can't
  tell a vote from a reaction. Reaction chips leave them out (`groupReactions`). `useReactions`
  `vote(msg, optionIds)` (`planVotes`) makes your votes exactly that choice (`[]`: removes
  them), deleting your votes for answers that no longer exist too.
  `tallyVotes` counts only answers that exist, and one vote per person (the latest) in single
  choice. Percentages and "N votes" are of the votes cast (`cast`, `voteShare`), so in a
  multiple-choice poll they still add up to 100%. In guilds a vote only needs View Channel (not Add Reactions): the server accepts
  `poll:<8 chars>` on a poll without it, and refuses any other `poll:` reaction that isn't a vote
  or an added answer that fits (below), or is on a message that isn't a poll.
- **Editing** (the author, Edit opens `PollDialog`, not the inline editor): question and
  answers can change; an answer whose text or emoji changed gets a new id (`editedPoll`), so its votes
  stop counting. A new question drops every vote (all answers get new ids) and, in an open poll,
  every added answer (a new round); the dialog says so. Nobody can delete other people's
  reactions, so in encrypted chats those old votes and answers stay stored until their owner
  votes again (`planVotes` clears them); in guilds the server deletes them with the edit.
- **Open polls** ("Open poll" in the dialog, `open: true` and a round `r` in the JSON): anyone
  can add an answer, from the vote screen only (a box under the answers; not on the results),
  and adding one neither votes for it nor ticks it (that would look like a vote): it's picked
  and sent with Vote like any other. Each added answer is a reaction from whoever added it,
  `poll:+` + JSON `{ i: id, r: round, t: text }` (text only, at most 55 characters, one line,
  trimmed; `parseAnswer` ignores anything not made exactly so), so who added it is the
  reaction's owner (signed in groups) and, in encrypted chats, the server can't tell it from an
  emoji (reactions are padded to 256 bytes for it; see Reactions in `auth-and-encryption.md`).
  `pollWithAnswers` is the poll with them: the author's answers, then added ones in server
  order, leaving out other rounds, repeats of an earlier answer ignoring case (refused when
  typed too, `answerProblem`), ones added after the poll closed, and any past 20 answers in all
  (`MAX_POLL_OPTIONS`, for every poll). Each shows "added by <name>" unless the author added
  it. **Removing one** (the ✕ beside it, on the vote screen only, so after Remove vote if you
  voted; asks first): its creator, the poll's author, or in a
  guild anyone with Manage Messages (not the author's answers), only while nobody but its
  creator and the remover has voted for it (`canRemoveAnswer`); its creator's and the remover's
  votes go with it, so someone whose only vote it was is back on the vote screen. The author's
  own answers in the poll message are changed by editing. In DMs and groups its creator deletes
  their reaction and the author adds one `poll:-<id>` (only the poll author's count; signed in
  groups), since nobody can delete other people's reactions; there, only apps check the rules
  (the server can't read them), so two people acting at once could remove an answer just as
  it's voted for. In guilds the server checks it all: answers need Send Messages and must fit
  (round, shape, no repeat, at most 20), `DELETE /guild-messages/:id/poll-answers/:answerId`
  removes one with its votes (`{ removed: [reaction ids] }`), the plain reaction delete refuses
  an answer someone else has voted for, and nothing is added or removed once the poll closes.
  Poll reactions there have their own limit (50 per person per message, apart from the 20
  emoji); in DMs and groups the limit is 50 for everything. The "poll ended" row counts added
  answers too. Bots see added answers as reactions, as they see votes. An app from before
  open polls shows an open poll as an ordinary one and hides the added answers (they start
  with `poll:`), but voting there would delete your own added answers (and the author's
  removals, bringing those answers back).
- **Closing** (`pollEndsAt`): `d` seconds after the message's timestamp (the server's, so the
  author's clock doesn't matter), or earlier at `x`: the author's End poll (in the footer, asks
  first) is an edit stamping `x` (so the message shows "edited"). The footer says the time left
  (`timeLeft`, redrawn each minute, and at once when the poll's end changes; an early end
  counts as closed at once whatever the device's clock says) or "Poll closed"; closed polls show final results, take no
  votes and can't be edited (no Edit in the menus). Votes count only if their reaction's server
  `timestamp` isn't after the close (reactions keep `timestamp` through decryption for this).
  Polls from before durations have no `d` and never close by themselves. In guilds the server
  enforces it too (`server/polls.js`): no votes or vote removals once closed, no edits of a
  closed poll, and an edit can't change `multi` or `d`, un-end one, or end it at any time but
  about now. In DMs and groups only clients enforce it: someone with a modified app could still
  add a vote the server timestamps later (it doesn't count) or edit their own poll's `d`.
- **"Poll ended" rows** (`server/pollTimers.js`, `PollEndNotice.jsx`): when a poll closes, a
  row in the chat says "X's poll Q has closed." with the winning answer and its share of the
  votes cast ("won with 60% (3 of 5 votes)"), a draw ("a draw between A and B, 40% each") or
  "Nobody voted.", and View poll (jumps to it). It works the same in DMs, notes, group DMs and
  guild channels without the server learning the poll's contents: after sending a poll its
  author tells the server when it closes (`POST /polls/:kind/:messageId/timer { duration }`,
  kind `dm`/`group`/`guild`, `services/pollService.js`; `poll_timers`, `ends_at` = the
  message's timestamp + duration), and End poll does `POST .../end` after the edit. A sweep
  (every 5 s, only when run as the server; tests call `announceDue`) posts each due row once:
  a message in that chat's table with `system` = 'poll_end' (the other system row is a call,
  see DM calls), the poll's author as sender, the
  poll as parent and empty content, sent as the chat's usual new-message event (no pushes;
  unread like any message, in a group in the poll's epoch). Rows carry the poll (the parent,
  still encrypted, plus `parent_timestamp`; in groups also the poll's `parent_reply_to` and
  `parent_edited`, so its signature is checked) and its votes (`poll_reactions`, still
  encrypted), and each device works the result out (`pollResult`, votes up to the poll's own
  end). So the server learns that a message is a poll and when it closes (and who reacted when,
  as before), never the question, answers or result. It posts the rows, so in an encrypted chat
  it could post one early: a row that doesn't fit its poll (`pollEndFits`: not ended by then,
  give or take a minute) isn't shown, and neither is one whose poll can't be read (someone
  added to a group later never gets it: it's in the poll's epoch). Rows can't be edited;
  deleting a poll deletes its row (and timer). An app from before this shows them as unreadable.
- **Notifications when a poll closes** (`server/systemPushes.js`, see "Pinned" and "poll
  ended" notifications in `realtime.md`): its author ("Your poll “Q” has closed") and everyone
  who voted, in a guild also whoever gets every message in the channel. In DMs and groups the
  server can't tell a vote from an emoji, so there it's everyone who reacted to the poll.

## Mentions

Discord's forms, in message text: `<@id>` (a person; DMs, group DMs, channels, inside the
encryption where there is one), and in guilds only `<@&id>` (a role), `@everyone` and `@here`.
Helpers in `utils/mentions.js`. Only ids are stored, so a mention always shows the current
name, looked up when drawn: people from the chat's names (`ChatPane`'s `reactionNames`: the two
in a DM, everyone in a group's log, a guild's members; anyone else `@unknown-user`), roles from
`mentionRoles` (`{ id: { name, color } }`; gone: `@deleted-role`).
- **Who can be mentioned:** typing `@` (after a space/bracket or at the start) lists, in
  `MentionSuggestions` (`searchMentions`: people, then up to 3 roles, then @everyone/@here),
  `people` (`ChatPane` → `Composer`: the DM's two, the group's current members, or the members
  who can see the channel, from `GET /channels/:id/members`, refetched on any guild, member or
  role change; `GuildView` also shows only them in the member list), the roles you may mention
  (`mentionable`, or all with Mention Everyone) and, with Mention Everyone, @everyone and
  @here. Keys and clicks work as for `:emoji` suggestions. Picking puts a `mention` or
  `roleMention` node in the editor (`editor/messageDoc.js`; the editor's `mentionNames` /
  `mentionRoles` props turn text back into them); @everyone/@here stay text.
- **Server** (`server/mentions.js`), guild messages only (it can't read DMs or groups): on send
  and edit, `saveMentions` works out who's mentioned (nothing inside code; roles only if
  `mentionable` or the sender has Mention Everyone; @everyone/@here need it, else they're
  just text; @here = viewers not offline; only members who can see the channel; never the
  sender), stores them in `guild_mentions` (message, channel, user) and on the message
  (`mention_everyone` 0/1, `mention_roles` JSON; sent as an array). `/guild-unread` counts them
  per channel (`mentions`). A new message sends `guild_mention` to each person mentioned and
  pushes by each member's level for the guild (`guild_members.notify_level`: 'all', 'mentions'
  (default), 'none'; `PUT /guilds/:id/notifications`, `my_notify_level` in the layout; set in
  the guild menu's Notification Settings, `guild/NotificationDialog.jsx`), skipping whoever is
  looking at the channel. Guild pushes are plain text (guilds aren't end-to-end encrypted):
  title "sender (#channel, Guild)", body with names for mentions, `:name:` for custom emoji and
  attachment names (never their key-carrying links). Edits don't push (like Discord).
- **Client:** `rehypeMentions` (`utils/rehypeMentions.js`) marks them; `MessageList`'s `span`
  component draws `@name` (`.mention`, `.mention-me` for you), roles in their colour
  (`.role-mention`, `--role-color`), and @everyone/@here as mentions only if the message pinged
  them. A message for you (`mentionsMe`: names you, pinged @everyone/@here, or one of your
  roles, `myRoleIds`) gets `.mentioned` (tinted, bar on the left). Unread mentions show as red
  counts on the channel (`GuildSidebar`) and the server icon (`Sidebar`), from
  `useGuildList`'s `unread[].mentions`. Plain-text places use `mentionsToText` (reply previews,
  copying, DM push previews: the push carries `recipientName` for that).
- **Muted channels** (like Discord's Mute Channel; `server/channelMutes.js`,
  `guild_channel_mutes`: member, channel, `until` unix s or NULL): each member's own, for 15
  min, 1, 3, 8 or 24 h, or until unmuted (`PUT /channels/:id/mute { duration: s | null }`,
  `DELETE` unmutes, `GET /channel-mutes`; needs View Channel; `guild_channel_mute` to your
  other devices). A muted channel doesn't push (or play the Message sound) except when it
  mentions you (`notifyNewMessage`), isn't bold or marked unread in the channel list, and
  doesn't light the guild's rail dot or the desktop app's dot; mention counts still show.
  `/guild-unread` still counts it (the client hides it: `useGuildList` `mutes`, `isMuted`,
  `activeUnread`, dropping a mute when it runs out). Leaving the guild or deleting the
  channel deletes the mute. Client: `guild/ChannelMuteMenu.jsx`, from the bell in the channel
  header (crossed out and red while muted), or the channel menu (see Guilds); muted channels are
  dimmed with a crossed-out bell. Assignment pushes (list channels) aren't muted.
- **Muted guilds** (Discord's Mute Server; `channelMutes.js`, `guild_mutes`: member, guild,
  `until` unix s or NULL): the same choices and rules as a muted channel, for every channel
  and thread in the guild at once (`PUT /guilds/:id/mute { duration: s | null }`, `DELETE`
  unmutes, `GET /guild-mutes`; members only; `guild_mute` to your other devices). Its messages
  don't push or play the Message sound unless they mention you (even in a channel set to All
  Messages), nor do reactions to yours; the guild's rail dot, the favicon dot and the desktop
  app's badge stay off (`useGuildList` `guildMutes`, `isGuildMuted`, `activeUnread`), and the
  mention count still shows. Inside the guild the channel list still marks what's unread.
  Leaving or deleting the guild deletes the mute. Assignment pushes and events starting
  (things you're told about directly) aren't muted. Client: the guild's menu on the rail, Mute
  Guild ▸ / Unmute Guild (with when it ends).
- **Channel notification levels** (Discord's per-channel Notification Settings;
  `guild_channel_notify`: member, channel, level): your own 'all' / 'mentions' / 'none' for one
  channel, overriding your guild level for its messages (`notifyNewMessage`); no row means the
  guild's. `PUT /channels/:id/notifications { level | null }`, `GET /channel-notifications`
  (`useGuildList` `channelLevels`). A mute still wins over 'all'. Set from the channel menu;
  leaving the guild or deleting the channel deletes it.
- DMs and group DMs push every message already; mentioning someone there adds no notification
  (the server can't see it).
- **Channel mentions** `<#id>` (Discord's form): a link to a guild channel, notifying nobody;
  usable anywhere (DMs and groups too, inside the encryption). In a guild channel, typing `#`
  lists the channels you can see (`searchChannels`, the channel list's order with each one's
  category; `GuildView` → `ChatPane` `channels` → `Composer`), and picking puts a
  `channelMention` node (`#name`) in the editor. Names come from `ChannelMentionContext`
  (`contexts.js`, provided by `Layout`): every channel in the guild layouts opened so far.
  `MessageList`'s `ChannelMention` draws the icon and current name; clicking navigates to
  `/guild/<guild>/<channel>`. One not known yet calls `loadAll()`, which opens all your other
  guilds' layouts once (never a request about that one channel, so an encrypted message's
  channel isn't revealed); still unknown (can't see it, deleted, not your guild) it's
  `#unknown-channel`. Plain-text places pass the channels to `mentionsToText`; the service
  worker has none, so DM push previews say `#unknown-channel`. Guild pushes name a channel only
  for recipients who can see it (`mentionedChannels`, so the body can differ per person); search
  doesn't index the ids.
- **Channel links** (Copy Link in a channel's menu, `channelLink`): a bare one pasted into a
  message (the link's text is the link, not `[text](link)`) is drawn as that channel's mention
  for anyone who can see the channel (`MessageList`'s `MarkdownLink`, `parseChannelLink`: this
  site's or app.voicaw.com's `/guild/<guild>/<channel>`; the channel must be in that guild).
  For everyone else it stays the link. The message keeps the link as typed, so plain-text
  places (reply previews, pushes) show it as it is, and search finds it.

## Timestamps

Discord's `<t:unix>` / `<t:unix:style>` (unix seconds), in message text anywhere (DMs and groups
inside the encryption, guilds, bots and webhooks as they come): each reader sees the time in
their own time zone and Settings → Date & time format. Styles, Discord's letters: `t` 18:00,
`T` 18:00:00, `d` 09/10/2026, `D` 9 October 2026, `f` (also no style) 9 October 2026, 18:00,
`F` Friday 9 October 2026, 18:00, `R` in 8 hours (moment's rounding, as Discord's: "in a few
seconds", minutes under 45, hours under 22, days under 26, then months and years). Helpers in
`utils/timestamps.js`; `formatRelative` in `utils/dateFormat.js`. Anything out of a Date's range
stays text, as do timestamps inside code.
- **Messages:** `rehypeMentions` marks them, `MessageList`'s span draws `Timestamp` (a `<time>`
  on a faint pill, the `F` form on hover). Relative ones keep counting: one shared clock ticks
  each second while any is on screen (`onClockTick`), and each redraws only when its words change.
- **Message box:** a `timestamp` node in `editor/messageDoc.js` shows it as it will read (a node
  view in `MessageEditor` keeps `R` counting). Typed out in full (the closing `>`), pasted, put
  back by editing or inserted, it becomes one; the text keeps `<t:…>` exactly.
- **+ menu → Timestamps** (computers; on phones the last button of the + panel's bar):
  `TimestampDialog`, a date and time (the next full hour to start), the seven formats each
  previewed, the code it'll put in; Insert puts it where the cursor is.
- **Plain-text places** (reply previews, copying, DM push previews): `mentionsToText` writes them
  as they read now. Guild pushes are written by the server, which doesn't know the reader's time
  zone: `R` as it reads at sending, the rest in UTC ("9 October 2026, 17:00 UTC";
  `server/mentions.js` `timestampPreview`).

## Edit history

Edited messages keep their earlier versions (built 2026-10-09), in DMs, notes, group DMs and
guild channels (threads, voice channels' chat and document replies included), visible to
everyone who can see the message (Discord has no history; this is ours).
- **Server** (`server/editHistory.js`): each edit route (`PUT /guild-messages/:id`,
  `/update-message/:id`, `/group-dm-messages/:id`) calls `keepVersion(kind, row, newContent)` in
  its transaction before the update: the old `content` goes into `message_edits` (`kind`
  'guild' | 'dm' | 'group'), with `written_at` (the message's time, or its last `edited_at`) and
  `edited` (whether that version was itself an edit). Saving the same text keeps nothing. DMs
  and groups store the ciphertext as it was (the server already had it and still can't read it);
  `direct_messages` and `group_dm_messages` gained `edited_at`. Versions are never indexed for
  guild search. Deleting a message deletes its versions (triggers in `db.js`, so every delete
  path, purges and guild deletion included, takes them). Messages edited before this have no
  history (or a first version with `written_at` null).
- **Reading**: `GET /guild-messages/:id/edits` (anyone who can see the channel),
  `/dm-messages/:id/edits` (either person), `/group-dm-messages/:id/edits` (members with the
  message's epoch key) -> `{ versions: [{ content, written_at, edited }], edited_at }`, oldest
  first, the current version not among them.
- **Not kept**: bots' and webhooks' edits (they rewrite messages as they go, e.g. game
  boards), bot DMs, task comments and documents.
  Polls' edits are kept but not shown (mostly ending the poll).
- **Client**: each chat hook has `loadEdits(msg)` (`useChannel`, `useConversation`,
  `useGroupConversation`): DMs decrypt each version with the conversation key, groups with the
  message's epoch key and check its signature against the context it was signed with (`editOf`
  only when `edited`), showing "unverified" like the chat. On a computer "edited" beside a
  message is a button (`utils/editHistory.js` `hasEditHistory`; on phones it stays plain text, so
  a tap never opens it), and the right-click menu and the phone's long-press sheet have Edit history; all open `EditHistoryDialog` (Original / Edit / Now, with times). Attachments show
  as their names (`summarizeAttachments`): a file an edit removed is deleted (docs/uploads.md),
  so old versions can't show it.
- **Privacy**: editing no longer takes text back; deleting the message does. Said so in the
  privacy policy.

## Pinned messages

Any message in a DM, group DM or guild text channel can be pinned. Who may: either person in a
DM, any member of a group DM (a message they can read), Pin Messages in a channel. Max 250 per
chat (`MAX_PINS`, Discord's number; 400 past it).
- **Server** (`server/pins.js` `setPinned`, routes in `dms.js`, `groupDms.js`,
  `guildMessages.js`): `pinned_at` (unix s) / `pinned_by` columns on each message table, null
  when not pinned; message rows carry them, and deleting a message takes its pin with it.
  `PUT` / `DELETE /dm-messages/:id/pin`, `/group-dm-messages/:id/pin`, `/guild-messages/:id/pin`
  return `{ messageId, pinned_at, pinned_by }`; a change (not a repeat) sends `dm_pin` (with
  `sender_id`/`recipient_id`) / `group_dm_message_pin` / `guild_message_pin` to whoever can see
  the chat. Lists, most recently pinned first, as message rows: `GET /dm-pins/:otherUserId`,
  `/group-dms/:id/pins` (only epochs you have a key for), `/channels/:id/pins`.
- **Encrypted chats:** which message is pinned, by whom and when is visible to the server (like
  reply links and reactions), never what it says; the list is decrypted (and, in groups, its
  signatures checked) on the device like history. Pins aren't signed: in a group the server
  could claim someone pinned something, or unpin it.
- **Client:** the chat hooks (`useConversation`, `useGroupConversation`, `useChannel`) have
  `loadPins()`, `setPinned(msg, pinned)` and `pinsVersion` (bumped on every pin change there,
  so an open list reloads). `ChatPane` takes `canPin`, `pinsAnchor` (the header button's rect)
  and `onClosePins`: a pin button in the hover menu, "Pin / Unpin Message" in the right-click
  menu and "Pin / Unpin message" in the mobile action sheet, and `PinnedMessages` (floating under the header's pin button; full screen on a
  phone; Escape or a click outside closes it), which draws each with `MessageContent`
  (`MessageList`'s markdown, no menu) and has Jump (loads older pages until the message is
  there, then scrolls to it and flashes it, `.jump-highlight`) and Unpin. A pinned message shows
  a small pin by its time (after the text when grouped).
- **"Pinned a message" rows** (as Discord's system message): pinning (not unpinning) posts a
  message with `system` = 'pin' in the chat (`pins.js` `setPinned` in the pin's transaction,
  then `announcePin`): the pinner as sender, the pinned message as parent, no content, so in
  encrypted chats it tells the server nothing it didn't know. In a DM it's unread for the other
  person (not in notes); in a group it's in the pinned message's epoch, so only those who can
  read that message get it; it arrives as the chat's usual new-message event. `PinNotice.jsx`
  draws it ("X pinned *a message* to this chat. *See all pinned messages.*"): "a message" jumps
  to it, "See all" opens the list under the header's pin button (`ChatPane` `onShowPins`). It
  can't be pinned itself or edited; deleting the pinned message deletes its rows
  (`pollTimers.js` `removeLinkedRows`). Guild search leaves them out; bots see Discord's
  CHANNEL_PINNED_MESSAGE (type 6, `message_reference` the pinned message).
- **Notifications** (`server/systemPushes.js`, see "Pinned" and "poll ended" notifications in
  `realtime.md`): everyone else in a DM or group; in a guild channel the pinned message's
  author and whoever gets every message there.

## Unsent messages (drafts)

What's typed in a conversation's message box (DM, group DM, notes, guild or document channel)
is still there after going elsewhere in the app (another conversation, Settings, a guild) and
back, like Discord. `services/draftStore.js` keeps it by `ChatPane`'s `chatId`; `Composer`
saves on every edit and puts the draft back when it opens or its `chatId` changes (without
counting as typing, so no typing event is sent, and without `:shortcode:` conversion). Sending,
or emptying the box, forgets it.

Drafts are **only in memory**, never in `localStorage`, `sessionStorage` or IndexedDB: the text
of encrypted chats stays off the disk, as with messages (the device stores no message
plaintext; search's copy is encrypted, see Search in encrypted chats). So closing the tab, window or app forgets them, and so does a reload. Logging out
clears them all (`services/logout.js`), so the next account on that tab doesn't see them.
Attachments come back too (2026-10-22; they used to be dropped): leaving a conversation, or the
composer going away, keeps its attachment drafts (the files, previews and size readings) in
`draftStore` beside the text, whose placeholders stay; opening it again gives them back to
`useAttachmentDrafts`, and the editor redraws their chips from the placeholders. Draft ids come
from `draftStore` so kept and new ones never clash. A composer only going away after the logout
(its cleanup runs after `clearDrafts`) doesn't keep them: `clearDrafts` moves a generation on,
and older ones are dropped, their files let go. A reply being set up isn't kept.
`e2e/drafts.mjs` checks it in the browser.

## Messages that couldn't be sent

Built 2026-10-22, after a friend of the user lost messages to a dropped connection: the
composer is emptied when you send, and a failed message used to vanish with the chat's state.
Now a message (text, attachments, GIF, voice message, poll) that couldn't be sent stays at the
end of its chat, in red, with "Not sent." and **Retry** / **Delete** (no question: nothing on
the server to lose), as Discord does. The composer's error line still says why. Every chat
kind: DMs, notes, group DMs, guild channels and threads, bot DMs.

- **Kept** by `ChatPane` (`hooks/useUnsentMessages.js`, which wraps the chat hook's
  `sendMessage`; the chat hooks take their pending row out when a send throws) in
  `services/unsentStore.js`, by `chatId`, so it's still there after another chat, Settings or a
  guild. Only in memory, like drafts: closing or reloading forgets it, logging out clears it.
  Attachments keep their local files, and ones already uploaded aren't uploaded again.
- **Sent once.** Each message has a random `nonce`, the same on every retry; the four send
  routes (`/dm-send`, `/group-dms/:id/messages`, `/channels/:id/messages`,
  `/bot-dms/:id/messages`) go through `server/sendNonces.js`, which remembers (in memory, an
  hour, per sender) which message a nonce made and answers a repeat with it. So when the
  connection dropped after the request left, Retry can't make a second copy. A server restart
  forgets the nonces.
- **Found by itself.** A message of yours with the same text, newer than everything the chat
  had when the failed one was sent (our own websocket echo, or the chat catching up once the
  connection is back), means it arrived (or you sent it again by hand): it stops being unsent.
- Menus offer only Copy on it; no replies, edits, reactions or pins.
- **Not done yet:** sending by itself when the connection comes back, keeping unsent messages
  over a reload.

`e2e/unsent.mjs` checks it in the browser.

## Search in encrypted chats

DMs, group DMs and notes are searched **on the device** (built 2026-10-09): the server only has
ciphertext, so it can't, and it's never told what's searched for or what was found. The box is
guild search's (`MessageSearch.jsx`, see Guild search in docs/guilds.md) at the end of the chat's
header (`ChatSearch.jsx` in `Dm`, `GroupDm`, `Notes`; a button opening it full screen on a
phone): words (prefixes; `"quoted"` an exact phrase; an emoji as written), `from:`, `mentions:`,
`has:` (link, file, image, video, sound, poll; no `embed`, since an encrypted chat's link
previews arrive after the message), no `in:`. Matching follows the server's
(`utils/messageSearch.js`: its `searchText`/`searchHas` copy `server/searchText.js`, and a test
checks they agree; words without case or accents). Results are drawn with `MessageContent` (no
reactions); Jump is `ChatPane`'s `jumpTo`.

**The copy on the device** (`services/searchIndex.js`, IndexedDB `voicaw-search`), so memory
stays small and the history is downloaded once:
- The chat hooks give `searchMessages(params, options)` (`useConversation`,
  `useGroupConversation`): a source that fetches pages (100) and decrypts only the text. A group
  message whose signature fails, or that can't be opened, is left out; so are system rows.
- A conversation is kept as **segments** of about 200 messages covering id ranges, newest
  first, without overlap: `{ i, s, t, p, n, h, u }` (id, sender, time, text, its words, has: bits,
  unsigned), as JSON encrypted with AES-GCM under a **non-extractable key made on the device**
  and stored beside it (each bound to its conversation and range). The disk never holds
  plaintext. The copy is as readable as the private keys already in IndexedDB (keyStore.js),
  which open the whole history anyway. The meta (ranges, message counts, latest edit) isn't
  encrypted: it's only what the server knows.
- Each search syncs first: new messages (one page when nothing is new); then
  `POST /dm-messages/:id/ranges` / `/group-dms/:id/messages/ranges` (`server/messageRanges.js`)
  say how many messages each range holds now and its latest `edited_at`, and ranges that differ
  (something deleted or edited) are dropped and read again; then gaps (an interrupted read) and
  older history. So a deleted message leaves the copy at the next search, and the server learns
  only ranges, never which messages matched. The first search of a long chat reads the whole
  history and shows "Reading the history… N messages so far"; closing the search stops it, and
  the next search carries on from there. One sync per conversation at a time (Web Locks, so
  across tabs too).
- Searching decrypts 16 segments at a time and keeps only the matches it shows (25 a page), so
  memory doesn't grow with the history. Load more reads the copy again, without syncing.
- **Settings → Privacy → "Keep a search copy on this device"** (`searchCopy`, on by default):
  off deletes the copy, and every search then reads the history from the server again, keeping
  only matches. Logging out deletes it (`App.jsx`, `clearSearchIndex`).
- **Not done yet:** searching every conversation at once, `before:`/`after:`, building the copy
  in the background before the first search.

`e2e/dmsearch.mjs` checks it in the browser.

## Offline copy

Built 2026-10-14. DMs, group DMs and notes this device has shown can be read without a
connection: text only (no attachments, pictures or link previews' pictures; guild channels and bot
DMs aren't kept), read-only, on by default (Settings → Privacy → Storage on this device, "Keep an
offline copy", `utils/privacy.js` `offlineCopy`). The user chose: only the encrypted chats, no
sending queued while offline. Online, the app reads everything from the server as before; the copy
only follows.

- **The store** (`services/offlineCopy.js`, IndexedDB `voicaw-offline`): each message as its chat
  hook showed it (decrypted, reactions too, without the ciphertext fields), AES-GCM-encrypted one
  by one under a non-extractable key made on the device (as the search copy's), bound to its chat
  and id; per chat, the id ranges ("runs") it holds without gaps. Ids, edit times and who a chat
  is with are in the clear (the server knows them). About 1 KB per message.
- **Following a chat** (`hooks/useOfflineChat.js`, used by `useConversation` and
  `useGroupConversation`): while a chat's messages came from the server, what it shows (from the
  oldest loaded to now, so edits, deletes, reactions and pins seen live are in it) is saved at
  once when it opens, then 0.5 s after each change (only changed messages are re-encrypted);
  anything saved from the oldest shown on that isn't shown any more was deleted. The first save
  after opening also checks the older saved parts with the search copy's per-range counts
  (`checkChat`, ranges of 200) and drops ranges where something was deleted or edited since
  (reactions added there meanwhile aren't noticed). Runs that overlap join; ones that don't stay
  apart (ids are shared by every conversation, so there may be messages between), and offline a
  chat shows only its newest run, never passing a gap.
- **The lists** (`utils/api.js` `OFFLINE_GETS`): `/profile`, `/config`, `/dms-list`,
  `/dm-get-unread`, `/group-dms`, `/group-dms/:id` (members, log and wrapped epoch keys, so
  `openGroup` works offline), `/conversation-settings`, `/preferences`, `/blocks`, `/friends`.
  Each answer is saved (sealed the same way) for the account the request was sent as (the token's
  `id`), never after a logout or another login; and given back only when the server can't be
  reached (no answer, a timeout, or the proxy's 502/503/504; never for a refusal) and either in
  offline mode or when the request asks (`offlineCopy: 'fallback'`).
- **Offline mode** (`utils/offlineMode.js`): `AuthProvider`'s first `/profile` asks with
  `'fallback'`; answered from the copy, the app opens in offline mode instead of "Can't reach
  Voicaw": `OfflineBanner` ("You're offline", dismissible), no websocket, everyone shown offline,
  chats from the copy (`offlineCopy: true` from the hooks; ChatPane then locks the composer with a
  notice, no hover tools, and menus keep only what needs no server: Copy). A chat never saved says
  so. Search reads only what the search copy already holds. `/profile` is asked again every 5 s
  (`'never'`): once the server answers, the banner says so and Reconnect reloads the app; a
  refusal (logged out elsewhere meanwhile) forgets the login. Online, a chat whose history can't
  be fetched (the server gone mid-session) opens from the copy too, read-only.
- **The web app** needs its page without a network: the service worker answers a failed page
  load with the precached `index.html` (network first, so nothing changes online). The desktop
  and Android apps ship their pages.
- **Storage on this device** (`StorageSettings.jsx`, a subsection of Privacy): what the browser
  says Voicaw uses (`navigator.storage.estimate`), the offline and search copies' sizes with their
  switches (off deletes) and Clear, and on the web whether the browser keeps the storage when
  space runs low (`navigator.storage.persisted`, "Ask to keep it" = `persist()`; Chrome decides by
  itself, Firefox asks, Safari deletes a site's storage after 7 days without a visit unless it's
  on the Home Screen). Measuring never makes a deleted database again.
- **Logging out** deletes it (see Logging out in `docs/auth-and-encryption.md`).
- Checks: `e2e/offline.mjs`, `e2e/offlinepwa.mjs` (a production build, no network at all).

## DM message list and history loading

`MessageList` is deliberately **not virtualized**: every loaded message is rendered in a plain
scroll container. Virtualized lists (react-virtuoso was used before) must guess the height of
rows they haven't rendered and correct afterwards, which showed as the chat jumping while
scrolling up. Measured in headless Chrome, the plain list has no such jumps. The browser's CSS
scroll anchoring (`overflow-anchor`) keeps visible messages still when older pages are prepended
or content above resizes. Where that's unsupported (Safari), `MessageList` does the same manually
by tracking the first visible row's `offsetTop` (layout effect + ResizeObserver, both before paint).
It also keeps the view pinned to the bottom while the user is there, and sending a message
(a new pending row of your own at the end) goes back there, like Discord. Only the user
scrolling up stops that (2026-10-13): a scroll event that finds a gap below without the view
having moved up is content that grew first (scroll events run before `ResizeObserver` in a
frame), so it goes back to the bottom; and while following, the browser's scroll anchoring is
off (`overflow-anchor: none` on the scroller), since it could pull the view up as rows above
its anchor changed. Before, a burst of webhook embeds whose pictures load at random moments
could leave the chat a little above the bottom, and then no longer following.
`e2e/scrollpin.mjs` checks that.
"At the bottom" includes the blank space under the newest message (the list's bottom padding,
room for the typing line, plus 4px; 2026-10-16): a finger scroll on a phone that stops in it shows
the newest message whole, but used to count as scrolled away, so the message box growing while
typing (or a new message) didn't move the chat up. `e2e/composergrow.mjs` checks the box growing
on a phone, with the keyboard up or not.

**Speed on phones** (2026-10-19, measured with `e2e/mobileperf.mjs`: a Pixel 7 with a 4× slower
CPU taps through a DM and a guild):
- Rows (`MessageRow`) are memoised. `MessageList` gives each only what concerns it (`menuOpen`,
  `focused`, `replying`, `editing`, not the list-wide ids) and the same functions every render
  (wrappers calling the ones passed in; one not passed stays missing, since rows check for
  some), so a hover, a picker, a reply or a new message redraws only the rows it changes, not
  every loaded one.
- Drawn markdown is kept in memory by text (`drawMarkdown`, the 2,000 most recent, per plugin
  list; `messageRehypePlugins` gives every row the same list for an emoji index), so going back
  to a channel or chat doesn't parse its messages again. The elements depend only on the text:
  names, mentions and uploading attachments are read from context when they're drawn.
- Icons are drawn by `Icon` (`components/Icon.jsx`), not Font Awesome's component, whose
  per-icon pipeline took ~80 ms opening a guild on such a phone.
- Smaller: `isEmojiOnly` answers at once for text with a letter, `userLocale` is kept per
  browser language, day dividers use the kept date formatters.
Measured together (production build, medians of 3): switching guild channels went from ~250 ms
of blocked main thread to ~80 ms, the emoji picker from ~385 ms between tap and paint to ~90 ms,
opening a message's sheet, closing the picker and Direct Messages from the rail from 60–160 ms
to no long task. Not yet: opening a guild for the first time since the app started (~270 ms,
unchanged) draws its last channel's messages in the hidden pane, most of it first-time markdown.

Messages are grouped like Discord's (`utils/messageGroups.js` `continuesGroup`): one from the
same person within 7 minutes of the row above, on the same day and not a reply, drops its
avatar, name and date (`.grouped`; the time shows in the avatar column on hover, "(edited)"
goes after the text). A group DM message whose sender isn't verified (unsigned or a bad
signature) never groups, either way, so it can't pass as the person above.

The first message of a group has its avatar in the gutter (`--message-gutter`), out of the
text's flow, like Discord's: 44px, from the top of the name to the bottom of the first line of
text below it (two 24px lines less 2px each end). It's placed in px rather than lined up with
the text, so a message starting with a heading or big emoji doesn't move it. A reply's
connecting line comes down to its middle. `e2e/avatar.mjs` measures all of this.

Clicking a reply's snippet (the line above it quoting the message it answers) jumps to that
message the way search, the pinned list and View poll do (`ChatPane`'s `jumpToMessage`, passed
down as `onJumpToMessage`): older pages load until it's there, then it's scrolled to the middle
and flashed (`.jump-highlight`).

While a reply is being written (the composer's "Replying to" bar), the message it answers stays
highlighted, as in Discord: `ChatPane` passes `replyTo`'s id to `MessageList` as `replyingToId`
and that row gets `.replying`, tinted in the accent with a bar on the left (purple, so it reads
apart from a mention's yellow, and wins over it). It goes when the reply is sent or cancelled
(×, Escape).

Where a new day starts (on the device's calendar), a line with the date in words goes across
the chat, like Discord's (`startsNewDay` in the same file, `DayDivider` in `MessageList`,
`formatLongDate`: "11 September 2026" in the Date & time setting's order). The first loaded
row only gets one once there's no older history (`hasMore` false). Client-side only; it's
drawn inside the row's wrapper, so row keys and scroll anchoring are unchanged.

**The "New" divider** (2026-10-07, Discord's): opening a chat with unread messages draws a red
line with "New" at its end above the first of them (with the date in the middle, as one line,
when a new day starts there too), and that message starts a group of its own. Where comes from
marking the chat read on opening: `POST /dm-mark-read/:id`, `/channels/:id/read`,
`/group-dms/:id/read` and `/bot-dms/:id/read` answer `first_unread_id`, the oldest message by
someone else that was unread until then (null if none; read and marked in one transaction, so
it doesn't depend on the unread lists having loaded, e.g. when the app starts in a chat). DMs
only kept a count, so `dm_unread` has `first_unread_id`, set when the row is made (messages,
call logs, poll ends) and kept as it counts up; rows from before it have none (no divider).
The chat hooks keep the opening read's answer as `firstUnread` ({ id }); `useNewDivider`
(ChatPane) turns it into `MessageList`'s `newFrom`. It stays where it is while the chat is open
(live messages you see don't move it), goes when you send a message, and moves to the first
message from someone else that comes while the window is hidden or in the background (once per
time away). Not in document channels: their unread count is the whole channel's, not one
document's. The chat still opens at the newest message, not at the divider.

`hooks/useConversation.js` loads a conversation in exactly one effect (keyed on `id` + the other user's public key,
ignoring late responses after a chat switch). Older pages (`PAGE_SIZE`, sent as `limit`, server
clamps 1–100, default 10) are only ever prepended by `loadMoreMessages`, which guards against
overlapping loads and drops ids already present. Rows are keyed by `clientKey ?? id`
(`clientKey` carries a sent message's temp id). react-markdown's `components` must be a stable
object, or attachments remount on every render. Image/video attachments carry their dimensions so
their box is reserved before they load.

**Catching up** (2026-10-16): the chat hooks (`useConversation`, `useGroupConversation`,
`useChannel`, `useBotDm`) load history once and then follow the websocket, which misses whatever
is sent while it isn't listening. Mostly a phone: asleep in the background, the server's 30 s
heartbeat closes its socket and the phone only notices once it's awake again, so tapping a
notification opened the chat without the message it was for (until you left and came back).
So the open chat fetches its newest page again (`hooks/useCatchUp.js`) whenever
`utils/catchUp.js` says so: on every socket identify (the `presence_snapshot`; also closes the
gap between a chat's first fetch and the socket opening) and when the app becomes visible after
at least 5 s hidden. `mergeNewestPage` lays the page over what's shown: new rows added (and
marked read), edited ones replaced, deleted ones within the page dropped, unchanged ones kept as
the same objects (no redraw); messages being sent and ephemeral replies stay at the end. A full
page that doesn't reach anything shown replaces the list (`hasMore` again). Not while showing
the offline copy.

Drawing markdown is what makes rows expensive (a webhook embed is a dozen bits of it), and rows
redraw on every hover, page load and name change, so: `MessageMarkdown` and `WebhookParts` are
`memo`ed and take only what they draw (keep their props stable); react-markdown re-runs every
plugin's setup on each render, so plugins with costly setup must do it once
(`utils/rehypeHighlightShared.js`: rehype-highlight registers ~40 languages); text with nothing
for markdown to do skips the parser (`utils/plainText.js` `isPlainText`, tested against
react-markdown's output); Intl formatters are cached (`dateFormat.js`). `e2e/embedperf.mjs`
measures a channel of 150 embeds (open, hover, scroll; computer and a 4× slowed phone). Before
these (2026-10-01) it froze for seconds; now opening takes ~0.2 s of script on a computer.
