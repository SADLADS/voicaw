# Uploads and attachments

## File uploads (S3-compatible object store)

`server/s3.js` wraps `@aws-sdk/client-s3` against `S3_ENDPOINT` (`forcePathStyle: true`, so this
targets a self-hosted endpoint, not raw AWS: Garage since 2026-11-16, MinIO before; README
section 4b). It auto-creates five buckets on startup (`bucketSetup.js`): `uploads`,
`profile-pics`, `guild-icons`, `emojis`, `sounds`, made public by a bucket policy where the store
has them; Garage has none, so its buckets have website access on and media.voicaw.com's nginx
sends anonymous reads there (`server/nginx/media.voicaw.com`), keeping every address
`<S3_ENDPOINT>/<bucket>/<key>`. Uploads are client-direct: the server only
issues short-lived (60s) pre-signed PUT URLs (`/api/upload_file`, and profile pictures' and
emoji originals, see Profiles and Guilds). Each is signed only for a type that is never served as
a page (`uploadTypes.js`, security audit 2026-11-18): `/upload_file` and its multipart routes take
`application/octet-stream` alone (attachments are encrypted), pictures only png, jpeg, gif, webp,
avif and bmp, and `s3.js` refuses anything else that isn't sound or video; media.voicaw.com's reads
also send `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src
'none'`. The
client uploads the file straight to S3, bypassing the app server. Both routes require a `size` query
param, which is signed into the URL together with the content type (`s3.js` `signableHeaders`), so
the object store rejects a body of any other length or type (verified against the live MinIO,
and against Garage on 2026-11-16, which answers an expired URL with 400 "Date is too old").
Limits: attachments up to Settings → Admin's File size limit (`appSettings.js` `uploadLimit`:
500, 250, 100, 50 or 25 MB, 500 by default; `/api/config` tells clients as `maxUploadBytes`), one
request at most 100MB (nginx's cap on media.voicaw.com, so a bigger file comes in parts, see Big
files); 8MB for profile picture originals, which must be `image/*`. Profile pictures are
unencrypted. Webhooks' files are the exception to client-direct uploads: they arrive in the
webhook request and the server stores them (see Webhooks); bots' and webhooks' own limit is Settings → Admin's Bot file size limit
(`botUploadLimit`, the same choices, 25 MB like Discord by default).

### Big files

Since 2026-10-08 (the limit went from 100 MB to 500 MB), no file is ever whole in the page's
memory, sending or saving, since a phone would run out:
- **Sending** (`services/attachmentUpload.js`): every file is `v=2` (chunked, see Videos below),
  encrypted a run of chunks at a time straight from the file (`chunkedAttachment.js`
  `chunkedEncryptor`, `file.slice`). Up to 16 MB of ciphertext goes in one request as before;
  more goes as an S3 multipart upload (`routes/uploads.js`): `POST /upload_file/multipart`
  (`{ type, size }`, checked against the limit; at most 10 going per person) starts it and
  registers the file like any upload; each part is 32 encrypted chunks (`PART_BYTES`, 8 MiB and
  a bit, so the client encrypts part by part), its URL asked for just before it's sent
  (`POST …/parts/:n`, signed for 5 minutes with its exact length, so the store refuses any
  other); `POST …/complete` puts them together only once the store lists every part at its
  length (`s3.js` `listUploadedParts`: the client never sends ETags, which media.voicaw.com's
  CORS needn't expose); `DELETE` abandons it. The client sends three parts at a time and tries
  a failed part twice more before abandoning the upload (no resuming after a reload: the user
  chose that, as a browser can't reopen the file without it being picked again). Unfinished
  uploads are kept in the server's memory (a restart fails those going on) and dropped by the
  store after a day (Garage: each bucket's `AbortIncompleteMultipartUpload` lifecycle rule;
  MinIO: its default `stale_uploads_expiry`). Checked against a real MinIO and Garage: a part of
  the wrong length gets 403. A 300 MB send holds about 75 MB in the page (the parts in flight).
- **Saving** (`services/attachmentSave.js`): a `v2` file from 32 MB is decrypted a chunk at a
  time as it downloads (`chunkedAttachment.js` `decryptingStream`) and written as it comes:
  in the Android app into Downloads (`utils/android.js` `saveToDownloads` takes a stream), in
  the desktop app to where the Save dialog says (`electron/fileSave.js`, `desktop:save-*` IPC;
  cancelling or a failure deletes the part written), in a browser by the service worker
  (`mediaStreamWorker.js`), which answers a hidden frame opening `/__voicaw-media/<id>` (an id
  whose meta has `download`) with the whole file as a `Content-Disposition: attachment`, so the
  browser saves it with its own progress; the worker tells the page `voicaw-media-saving` (or
  `-failed`) and since 2026-10-08 answers the ping `{ stream, download }` (older ones `true`, and
  aren't asked to save). Without any of those, and for smaller or `v=1` files, it's the
  whole-file way (`attachmentCache.js`), whose cache now also stops at 256 MB of files. A file box
  shows "Downloading… n%" while the app is the one downloading.
- **Huge images** (over 50 MB, `mediaDimensions.js` `MAX_INLINE_IMAGE_BYTES`) aren't decoded
  when attached, so get no size or thumbnail, and are shown as a file to download.
- Checked by `e2e/largeuploads.mjs` (120 MB in a DM; `LARGE_MB` for more).

## Deleting files

A file in the `uploads` bucket goes once nothing shows it any more (`server/uploads.js`, since
2026-10-02): deleting the message, document, channel, guild or group DM that showed it, an edit
that drops it, or deleting an account (their notes). Profile pictures, guild icons and custom
emoji are deleted by their own code (a deleted guild takes its icon and emoji images).
- **The registry.** `/upload_file` (and webhooks' `storeFiles`) records every upload in
  `uploads` (name, uploader, time). `upload_refs` links each to what shows it: `dm`, `group`
  (message ids), `guild` (a guild message, `db.indexGuildMessage` does it, so every writer of a
  message's content links it), `doc` (a document's text and cover). Each write replaces its
  owner's links.
- **Guild files** are read from the text by the server (`uploadKeys.js` `uploadKeysIn`: every
  `<S3_ENDPOINT>/uploads/<name>`, plus a video's poster `p=`). **Encrypted chats' files** can't
  be: the client lists them with the message, `uploads: [names]` on send and edit
  (`utils/attachmentMarkup.js` `uploadNamesIn`: each encrypted attachment and its poster or thumbnail).
  Names that aren't registered uploads are ignored, so a list can only keep files, never
  delete someone else's. **Privacy:** the server learns which uploads each encrypted message
  holds (it could mostly guess from timing and sizes before), never what they are.
- **Cleaning up** (`cleanUpUploads`, run after every delete and edit and every 10 minutes):
  links whose owner is gone are dropped, then every file that was linked and isn't any more, or
  was never linked within a day (a send that failed or never happened), is deleted, row first;
  a file the object store fails to delete gets its row back and is tried again next time.
- **Older clients** (apps from before 2026-10-02) send no list: such a send links nothing, so
  its files are deleted after a day like any unsent upload, and their edits change nothing.
  Until 2026-11-19 such a send kept every upload of its sender from the last day that wasn't
  linked yet, for good (`kept`), which let anyone keep unlimited files with one bare message;
  those `kept` files still stay.
- **Files from before the registry** have no row and are never deleted. Migration 9 registered
  and linked the files guild messages and documents showed; DMs', notes' and group DMs' stay
  untracked (the server can't read those messages). A guild file from before that someone also
  pasted into a DM goes with the guild message.
- **Forwards** (see Forwarding in `docs/messages.md`) show the same file with the same key, so
  they link it like any message: a forwarded file stays until the last message showing it goes.

## DM attachments (encrypted, uploaded on send)

Attachments are never uploaded when attached. The composer (`Composer.jsx`, `hooks/useAttachmentDrafts.js`) keeps them as local drafts
and inserts a markdown placeholder `![name](attachment:ID)` (`utils/attachmentMarkup.js`; the editor
shows it as a "📎 name" chip). Plain-text places (reply snippets, notifications) show it as
"📎 name" too (`summarizeAttachments`), spaced from text written against it. Files come from the + button (see The + panel), a paste, or a drop anywhere on the
window, as in Discord (`hooks/useFileDrop.js` `useWindowFileDrop`, while a composer is shown):
a file dragged in from outside the page covers the window with "Upload to <chat>"
(`FileDropOverlay.jsx`); drags that start in the page (an image from a message) and drags while
an `aria-modal` dialog is open are left alone. The tray
(`AttachmentTray.jsx`) previews drafts still referenced from the text. On send, each referenced
draft is encrypted with its own AES-GCM key in 256 KiB chunks (`services/chunkedAttachment.js`,
see Videos; every file since 2026-10-08, before then only videos, the rest `v=1`, one AES-GCM
message, `services/attachmentCrypto.js`), uploaded as
`application/octet-stream` (`services/attachmentUpload.js`; server names it `<uuid>.bin`), and its
placeholder is replaced with `<fileUrl>#v=2&k=<key>&t=<mime>&s=<size>&n=<nonce>[&w=<px>&h=<px>][&d=<s>][&p=<thumbnail or poster>][&sp=1]` (image/video
dimensions, read at attach time by `utils/mediaDimensions.js`, let the renderer reserve the final
box before the file loads; `sp=1` marks a spoiler, see below). The fragment is never sent
to S3 and the URL only exists inside the E2EE message. `Attachment.jsx` renders every markdown image:
placeholders (pending messages, from local blob URLs), encrypted attachments (fetched, decrypted,
cached in `services/attachmentCache.js`; images inline, videos in the player below, anything else
a download box), and plain URLs (legacy unencrypted uploads, external images) as `<img>`.

**Attachment types** (security audit, 2026-11-18): `t=` is whatever the sender wrote, and becomes
the type of the decrypted `blob:` URL, which is the app's own origin. `parseAttachmentUrl` keeps
only types that can't hold script (`safeAttachmentType`: png, jpeg, gif, webp, avif and bmp
pictures, any video/ or audio/ type, pdf (see PDF reader), epub (see EPUB reader), a few archives, text/plain;
parameters dropped) and makes
the rest `application/octet-stream`, so an SVG (or HTML...) arrives as a download box, never a
picture, and the service worker never serves one with that type. `openInNewTab`
(`utils/saveFile.js`, the image menu's Open Image) only opens a blob whose type is a picture,
video or sound and downloads anything else: a page made of a blob would run as the app. The
Content-Security-Policy (see Content-Security-Policy in `docs/client.md`) is the second line.

**Only this server's files are attachments** (security audit, 2026-11-19): an attachment address
could be any site, and small pictures load as soon as the message is on screen, so a contact
could host one themselves and learn the reader's IP address and when they opened the chat.
`Attachment.jsx` now treats an address as an attachment (or a plain upload) only when it's in
the server's file store (`inOwnStore`, the config's `s3Endpoint`); anything else, encrypted-looking
or not, is drawn as another site's picture behind Settings → Privacy's "Show pictures and videos
from links straight away" (`SiteMediaGate`, see Link previews in `messages.md`). Until the config
has loaded, an encrypted attachment is only its name. **Download sizes:** `attachmentCache`
refuses a download whose sender's `s=` or the server's Content-Length is over the largest File
size limit (500 MB) before allocating anything, and stops one without a length once it passes it.

**The + panel** (2026-10-07, as in Discord's phone app): on a computer the + button is a menu
(Upload a file, Create poll, and Create thread in a guild text channel you may start threads in,
`ThreadContext` `startThread`). On a phone it's a panel in the keyboard's place
(`AttachPanel.jsx`), taking turns with the keyboard and the emoji panel and pulled up to full
screen the same way (`useSheetDrag`). A 4-wide grid: a camera tile (the file chooser with
`capture`; in the Android app Capacitor opens the camera app for it, which needs the manifest's
`<queries>` for `IMAGE_CAPTURE`: without it some phones got the photo picker instead), then, in the Android app only, the phone's photos and videos, newest first
(`hooks/useDeviceMedia.js`, `Media.java`; a web page can't list them, so mobile web shows a Photos
tile instead). Tapping one attaches it (a normal draft, tagged with its gallery id as `source`,
so the tile shows its number in the order picked) and tapping again takes it back out. Access is
asked for in the panel ("Allow access"; once refused, a button to Android's settings); on
Android 14+ people may allow only some photos, and "Choose more" asks again. Thumbnails are made
by Android (`mediaThumbnail`, data: URLs) as tiles scroll into view; a file is only read by the
page once picked (`readMedia`, through Capacitor's `_capacitor_content_` route), then sent like
any other attachment. Nothing about the gallery leaves the phone. Under the grid a bar: Photos
(the phone's own picker, `accept="image/*,video/*"`), Poll, Thread (when it can) and Files.
Google Play only lets apps keep `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO` after a declaration in
the Play Console (Photo and Video Permissions); Google accepted Voicaw's (2026-10-09). Should it
ever be withdrawn, the permissions go and the grid falls back to the Photos tile as on the web.

**Image thumbnails** (since 2026-10-02): a big still image (JPEG, PNG, WebP or BMP that doesn't fit
the chat's 420×360 box at twice that, 840×720) also gets a smaller copy, made on the device at
attach time (`utils/mediaDimensions.js` `makeThumbnail`: drawn on a canvas, already turned the
way its EXIF says, so the copy carries no EXIF; a JPEG, or a WebP when it has transparency, a
PNG where the browser can't make WebPs). It's encrypted with the image's key, with additional
data so neither can pass for the other (a `v=2` image's is sealed like a video's poster,
`voicaw/attachment-poster/v2`; a `v=1` one's, from before 2026-10-08, `voicaw/attachment-thumbnail/v1`,
`attachmentCrypto.js` `decryptThumbnail`), uploaded as its own
`<uuid>.bin`, and named in the image's URL as `p=` (like a video's poster, so the upload
registry and cleanup follow it with no change). The chat shows the copy, as does the viewer's
thumbnail strip; the file itself downloads only when it's opened in the viewer, saved or copied
(the sender keeps seeing their local file). **The file is sent exactly as it was chosen**, never
shrunk or re-encoded, EXIF and all (decided 2026-10-02). No copy is made for GIFs, SVGs and
anything else, for animated PNGs and WebPs (`mayBeAnimated`: an `acTL` chunk before the image
data, the VP8X animation flag; a PNG it can't tell about counts as animated), for images that
already fit, or when the copy wouldn't be under three quarters of the file's size. Messages from
before, and from older clients, have no `p=` and show the file; older clients ignore `p=` on an
image. If the copy fails to load, the file is shown. **Privacy:** the server sees two uploads
where it used to see one (as for videos), never what's in them.

**Videos** (since 2026-10-01) are `v=2` (`services/chunkedAttachment.js`): encrypted in 256 KiB
chunks, each its own AES-GCM message (IV = base nonce `n` XOR chunk index; additional data binds
the index and a last-chunk flag, so chunks can't be reordered or the file cut short), so any byte
range can be fetched, checked and decrypted alone. At attach time `mediaDimensions.js` also reads
the duration (`d`) and grabs the first frame as a JPEG poster (canvas, no processing of the video),
uploaded encrypted with the same key as its own `<uuid>.bin` (`p`, a name in the same folder; its
own additional data, so it can't pass for a chunk). Old `v=1` videos still play.
- **Nothing but the poster downloads before Play.** `components/VideoPlayer.jsx` is the player
  (also for webhook videos in `MessageFiles`): poster, length and size, then our own controls
  (seek bar showing what's buffered, time, volume and mute remembered per device in
  `localStorage videoPrefs`, download with progress, full screen; keys k/space, ←/→, m, f; they
  fade while playing; a tap on a phone shows them first). One video plays at a time.
- **Videos without a poster of ours** (bots' and webhooks' files, sites' videos) show their first
  frame through the browser (`preload="metadata"`). Android's WebView gives such a video its own
  poster (grey, with a play sign) and, like any poster, keeps it until the video plays or seeks,
  so the player seeks to the first instant once the metadata is in (e2e `webviewposter.mjs`).
- **Streaming** (`services/videoStream.js` page side, `services/mediaStreamWorker.js` in the
  service worker): the `<video>` plays `/__voicaw-media/<random id>`; the worker asks the page
  for that id's file, key and size (over a `MessageChannel`, never in a URL), answers the
  browser's Range requests by fetching only the encrypted chunks they cover (`Range` on the object
  store, allowed by media.voicaw.com's CORS) and passes the bytes on only as the player reads them
  (`highWaterMark: 0`), with a small cache of decrypted chunks. So a seek to the middle downloads
  nothing before it, and the browser's own buffering decides how far ahead it reads (Chrome:
  ~6 MB at the start, then topping up as it plays). A read-ahead of our own was tried
  (2026-10-08, 4 MB): it only added to Chrome's (11.7 MB read for 2 s of a 15.6 MB video), and
  can't help a connection slower than the video, so it was dropped. Needs a worker controlling the page that
  answers `voicaw-media-ping`: not the desktop app, a first visit, or an older worker. There (and
  for `v=1`), Play downloads and decrypts the whole file first, with a progress figure. If
  streaming fails (the worker reports `voicaw-media-failed`, or never served it), the player
  falls back to that; if the browser can't decode the video (e.g. HEVC from an iPhone in many
  desktop browsers) it says so over the poster and offers Download. That case used to show as a
  plain download box, the likely cause of "videos turned into download links" (not confirmed).

**Videos in the corner** (picture in picture, 2026-11-13): a video in a message (an attachment,
encrypted or not, a link to a video file, a bot's or webhook's; anything `VideoPlayer` plays, not
YouTube's players) that's playing when you leave it carries on small in the corner
(`FloatingVideo.jsx` `VideoCorner`, in Layout's `.corner-players`, dragged like the others): its
name and chat, Go to message, Pop out (computers), Close, and the player's own controls (seek,
volume, time, full screen). Leaving is its message going from the page (another chat or page) or
its chat going out of sight while still on it (a phone's chat pane slid away to the list, a side
chat closed); with Settings → Appearance → Picture in picture's second box, also the player
alone scrolled under half in view (`utils/pipPrefs.js`, per device: "Keep videos playing in a
corner when I leave the chat" on, "Also when I scroll a playing video out of view" off by
default). A paused video just stops, as before.
- **The same element, never a copy** (`services/floatingVideo.js`). `VideoPlayer` makes its
  `<video>` in code (in `.video-slot`) instead of rendering it, and when it goes, hands it over in
  a layout-effect cleanup: React runs that in the same task as removing it, and a media element
  moved within the page in one task doesn't even pause (left out past the task, it would). It
  waits in a parking spot in the page until the corner draws it, so nothing is downloaded,
  decrypted or buffered again (a stream's URL and a decrypted copy are kept: `release` and
  `attachmentCache`'s `pinObjectUrl` until it's closed). The message's player, shown again (by
  `mediaKey`, the file's URL), takes it back still playing; while the video is elsewhere it says
  "Playing in the corner" / "in its own window" with Bring back. A player shown again makes its
  own new element first; it counts as away by key (not only by element) from its first render,
  so that element never takes the slot, and taking the video back throws it away (once it sat
  over the playing video as a still frame, with the sound and time going on underneath).
- **Go to message** opens the chat with `state.jumpToMessage: { chatId, messageId }`
  (`hooks/useLocationJump.js` in `ChatPane`, which loads older history until the message is
  there; chat and message read from the page around the player: `data-chat-id`,
  `data-chat-name`, `data-msg-id`).
- **Pop out** (computers; from the corner or the message's controls): a blank window
  (`services/videoWindow.js` on `voice/popoutWindow.js`, `voicaw-video`, allowed by the desktop
  app) showing a copy of the picture (`captureStream()`), while the element stays in the page
  playing the sound, so it doesn't reload: moving a media element into another window's document
  makes the browser load it afresh. Its controls drive the page's element. Another site's video
  can't be captured (SecurityError), so that one is moved into the window and carries on from the
  same point (a short reload). Closing the window brings it back: its message if on the page,
  else the corner, else it stops.
- **One at a time**: starting another video closes it (`claimPlayback`), and the corner shows one
  player (see The corner in `docs/voice-and-calls.md`): a video that leaves while a stream or
  Watch Together has the corner stops, as before.
- `e2e/videocorner.mjs` checks it all (no pause or reload on the way, the pop-out's frames, the
  phone's back arrow, themes).

**Spoilers:** an image or video draft can be marked as a spoiler with the eye button in the
tray (`toggleSpoiler`; the thumbnail blurs), which puts `sp=1` in its URL (inside the
encryption, like the rest of the fragment). `MediaCover` (also NSFW channels' cover, see NSFW
channels in `docs/guilds.md`; a spoiler there has just the one cover, "Spoiler", and stays
covered whatever Settings → Content says) shows it blurred
with "Spoiler" over it for everyone, the sender too, until clicked or tapped; then it stays
shown (per device, not remembered). Until revealed it's out of the image viewer's gallery (its
thumbnails would give it away) and a video has no controls. Previews (`summarizeAttachments`,
guild pushes in `server/mentions.js`) say "📎 spoiler" instead of the file name. GIFs and
other files can't be marked. Because placeholders are
shorter than final URLs, the send-time length check uses same-length stand-in URLs.

Clicking an image opens `ImageViewer` (full screen, from `ImageViewerProvider` in `App.jsx`
via `ImageViewerContext`, portalled to `<body>` so its touches don't reach the message's long
press). It shows the already-decrypted blob URL: zoom by wheel, pinch, double click/tap,
buttons or `+ - 0` keys (geometry in `utils/imageZoom.js`), drag to pan, save and open in a new
tab (`utils/saveFile.js`). It steps through the other images in the same message (arrows,
← → keys, swiping an unzoomed image, a thumbnail strip): each image registers itself on its
element (`utils/imageGallery.js` `galleryItemRef`, including ones still decrypting), and
`MessageList` marks the message content `data-image-gallery`; opening collects them in reading
order. Pictures attached to a message still being written open in it too: clicking (tapping)
a thumbnail in the composer's tray (`AttachmentTray`) shows the local copy, stepping through
the tray's other pictures. Its keys are caught at the window's capture phase, so Escape doesn't
also cancel a reply. Opening it pushes a history entry (keeping the router's state), so the
back button closes it. A tap (or click) beside the picture closes it on `pointerup`; the click the
browser sends after it is swallowed (`utils/swallowNextClick.js`), or on a phone it would land on
the picture behind in the chat and open the viewer again.

**Image menu** (`components/ImageMenu.jsx`, actions in `utils/imageActions.js`), in place of
the browser's: right-click a picture in a message (an attachment, a GIF, a webhook's embed or
file image), a document's cover (feed card, page, editor) or a picture in a document (on its
page or in the editor; the cover and editor pictures register as gallery items,
`galleryItemFromUrl`) (`PageMenus` in `App.jsx` listens on the page, not on phones, where
holding a message opens its actions), or in the viewer (there also by holding it on a phone;
the menu sits above the viewer, `overViewer`, and has the keys while open, so Escape closes
only it). On a phone, holding a picture in a document channel (cover, page, editor) opens it
as a sheet too (`hooks/useImageHold.js`, on `DocChannelView`).
Copy Image (a PNG on the clipboard, the one type browsers take, so a GIF copies its first
frame; other sites' pictures are fetched without a referrer and can't be copied if the site
doesn't allow it), Save Image, and Copy Link / Open Link for a plain picture. An encrypted
attachment has no link worth sharing (the file is ciphertext and its key lives only in the
message), nor has a picture on the device (a `blob:` copy: one being written or just sent), so
it offers Open Image instead (the decrypted copy in a new tab). Videos keep their
player's own download button.

**Saving to Photos on iPhones and iPads** (2026-11-02, `utils/saveFile.js` `triggerDownload`):
a download from Safari goes into Files, and a web page can't reach the photo library, so there
a picture or video (anything saved whole, by Save Image, the viewer's Save or a file's download
button) opens the share sheet with the file instead (`navigator.share`), whose Save Image /
Save Video puts it in Photos. Other files, and big videos saved as they download (Big files),
still go to Files. If the sheet can't open (an older iOS, or the tap was too long ago because a
big file was still decrypting), it's the ordinary download.

**Open Image in the desktop app** (2026-10-28, `utils/imageLink.js`): the app has no tabs, and
Electron hands only `http(s)` links to the browser, so the decrypted `blob:` copy can't go there
(Open Image used to do nothing). Nor can the picture's own URL: it carries its key, and the
uploads bucket is public, so anyone with the link (or the browser's history) could read it,
logged in or not. So Open Image (and the viewer's Open in new tab button, `imageOpener`) opens
the web app (`shareOrigin()`, the server's own) at the chat it's in, with `in` (ChatPane's
`chatId`), `message`, `image` (the file's object name, `<uuid>.bin`) and `as` (the account),
and no key: `/dm/12?in=12&message=345&image=….bin&as=7` (other query parameters of the page,
such as `thread`, are kept, so the same pane opens). Gallery items learn where they are from
the page (`placeOf`: ChatPane's wrapper is marked `data-chat-id`, rows `data-msg-id`); a
picture with nowhere to link to (search results, pins, a document, one being written) has no
Open Image in the desktop app. In the browser: logged out, `/dm/*` and `/guild/*` show the
login and stay at the link (App's routes, as invite links do); logged in as another account,
`ImageLinkAccount` says whose picture it is and offers Log out (keeping the link) or Cancel
(drops it). With the right account, `hooks/useImageLink.js` in the chat's ChatPane waits for
the history, takes the link out of the address, scrolls to the message (loading older pages,
`jumpToMessage`) and opens the viewer on that file with the message's other pictures; the
browser decrypts with its own keys. A spoiler still covered isn't in the gallery, so the chat
just stops at the message.

## Voice messages

Since 2026-10-09, as Discord's. **Recording:** on a phone the mic button takes Send's place while
the message box is empty (`VoiceRecorder.jsx` `MicButton`, right of the emoji button; typing or
attaching brings Send back): hold to record, let go to send; slide left to cancel, slide up to the
lock to keep recording hands-free; a tap only shows "Hold to record, release to send". On a
computer, the + menu's Voice message starts it locked. Locked, the box gives way to a bar
(`VoiceRecorderBar`): Delete, the time and a live waveform, Stop (then the recording to play
back before sending) and Send; Escape deletes it. `hooks/useVoiceRecording.js` holds the state;
`services/voiceMessage.js` records: the microphone chosen in Settings → Voice, with the browser's
echo cancellation, noise suppression and gain (not the call chain), MediaRecorder at 48 kbps in
the first type the browser has (Opus in WebM on Chrome and Android, Ogg on Firefox, AAC in MP4
on Safari), at most 20 minutes (then it stops and waits), under half a second is a tap and
nothing is sent. Not in bot DMs nor while editing. Android gives a page out of sight digital
silence instead of the microphone (found 2026-10-14: a 3-minute message recorded locked, the
phone held without a touch, went silent each time the screen timed out, about 35 s after the
last touch, until it was woken). So the screen is kept on while recording
(`utils/keepScreenOn.js`: the Android app's `keepScreenOn`, FLAG_KEEP_SCREEN_ON, as its
WebView has no Screen Wake Lock API; browsers' wake lock elsewhere), and on a phone, leaving
the app or locking the screen stops the recording (`stopWhenHidden`), to be played, sent or
deleted on coming back (the user chose stopping over carrying on with a foreground service,
as calls do). A hold whose touch the phone cancels (it does on leaving the app, before the
page is hidden) is locked rather than deleted. Computers' browsers keep recording in a
background tab. The waveform's levels are kept one per 100 ms of recording however late the
timer runs (a hidden page's are slowed), so it stays in time with the audio.
- **Sending:** its own message (`Composer` `sendVoice`, replying if a reply is set up; what's
  typed stays), `voice-message.<ext>` as an ordinary `v=2` encrypted attachment (see DM
  attachments above; guilds, DMs and groups alike), its URL fragment adding `vm=1`, `d=` (the
  length) and `wf=` (the waveform: 64 bytes, the average loudness (RMS) of each 64th of the
  recording, linear and relative to the loudest 64th, as WhatsApp's and Telegram's, measured
  live by an analyser beside the recorder, so the file is never decoded for it; a decibel
  scale with each 64th's loudest moment, before 2026-10-13, drew ordinary speech solid, since
  the microphone's auto gain makes it loud, and those messages still look that way). The
  server sees one more upload, never what it is (in guilds, where it can read the message, it
  sees `vm=1`; guild pushes say "🎤 Voice message", `server/mentions.js`). Older clients show
  it as a file to download.
- **Playing** (`VoiceMessage.jsx`): play/pause, the waveform (40 bars, filled as it plays; click,
  drag or ← → to seek), the time (its length until played), speed 1×/1.5×/2×, download. The file
  is downloaded and decrypted whole on the first Play (a minute is about 360 KB). One plays at a
  time. Chrome's recordings carry no length, so the player reads to the end once
  (`findDuration`) before it can seek.
- Voice messages can't be edited (`isVoiceMessage` in `utils/attachmentMarkup.js`: one, alone);
  previews and replies say "🎤 Voice message".
- Checked by `e2e/voicemessages.mjs`. Not yet tried on a real iPhone: Safari records AAC, which
  everything plays, but Safari may not play others' WebM/Opus.

## EPUB reader

Books (`.epub`) sent as attachments are read in the app (2026-11-26, Kan card VOI-275), in DMs,
group DMs, notes and guilds, without leaving it and without anything going to the server or
another site. A book is someone else's HTML, so the design is mostly about what it can't do.

- **In the chat** (`Attachment.jsx` `DocumentBox`, shared with PDFs): the book's cover, its name and size, **Read** and
  the download button. A book is told by its type (`application/epub+zip`, kept by
  `safeAttachmentType`) or a `.epub` name (some systems give the file no type, and older apps
  sent it as `application/octet-stream`; `utils/epub.js` `isEpub`, and new uploads are typed by
  the name when the system gave none). A spoiler book's cover is covered like an image, as in
  an NSFW channel. Webhooks' and bots' books (`MessageFiles.jsx`) get Read too when they're in
  our own store, without a cover.
- **The cover** is made on the sender's device when the book is attached
  (`utils/mediaDimensions.js` → `services/epub/epubCover.js`) and sent as the attachment's
  thumbnail (`p=` with `w`/`h`, encrypted with the file's key like an image's, see Image
  thumbnails), so others see it without downloading the book. It's found as the manifest's
  `cover-image` (EPUB 3), the item `<meta name="cover">` names (EPUB 2), or the first picture of
  a first page called a cover; only a PNG, JPEG, GIF or WebP (by its bytes) is used, decoded and
  redrawn on a canvas as a new JPEG (at most 280×400), so nothing of the book's own file is
  passed on and an SVG cover (which could carry script) means no cover. The tray shows it too.
  Books sent before this, or by older apps, have no cover; older apps show a book with one as a
  plain file. Readers never download a book to find its cover.
- **The reader** (`EpubReader.jsx`, loaded with its parser and DOMPurify only when a book is
  first opened; `ReaderProvider.jsx`, shared with the PDF reader, adds a history entry, so Back closes it, as the image
  viewer): full screen, the book's title and author, text size (−/+, kept per device in
  `epubTextSize`), Contents (EPUB 3's `nav`, else the EPUB 2 NCX), chapters that scroll one at a
  time with Previous/Next chapter at the end, keys (Escape, ← →, ↑ ↓, Page Up/Down, Space,
  Home/End). The app's theme colours are laid over the book's own CSS (text, links, no
  backgrounds), pictures fit the page. Where a book was left (chapter and how far down) is kept
  in this device's localStorage only (`epubPosition:<the file's name in the store>`,
  `utils/epubPosition.js`), deleted at logout (`services/logout.js`). The book is downloaded and
  decrypted whole when Read is pressed (`loadDecryptedAttachment`), read in place as a zip
  (`utils/zip.js`, shared with the history import), each chapter parsed when shown.
- **Nothing in a book runs** (`services/epub/sanitize.js`):
  - Chapters are parsed by `DOMParser` (inert documents: no scripts, nothing loaded, no external
    entities or DTDs) and sanitised by DOMPurify into nodes (never turned back into HTML and
    parsed again): no `script`, `iframe`/`object`/`embed`, forms and their fields, `base`, `meta`,
    `link`, `video`/`audio`, `template`, SVG `foreignObject` and animation elements, no `on*`
    attribute (a hook removes any that's left), no `data-*`. They're drawn into a **shadow root**,
    never as a page of their own (no iframe, no new tab).
  - The app's Content-Security-Policy is the second line (no inline script or handler runs in a
    built app), but the reader doesn't rely on it: `e2e/epubreader.mjs` runs against the dev
    server, which has none.
- **Nothing is fetched from another site**: every address left is rewritten. A file of the book
  becomes a `blob:` URL of its bytes, typed by what the bytes are (`services/epub/imageType.js`:
  PNG, JPEG, GIF or WebP only, never the manifest's type; anything else is no picture). An SVG
  picture is sanitised (DOMPurify's SVG profile) and put inline in the `<img>`'s place, never a
  blob typed `image/svg+xml` (opened from the browser's own menu, that would be a page of the
  app's origin). A link to a chapter jumps there (`#epub:<chapter>:<place>`, handled by the
  reader; the address bar never changes); a link to another site (`http(s):`, `mailto:` only)
  stays a link that opens in the browser, `noopener noreferrer`, and is never loaded inline;
  anything else loses its address (`srcset`, `poster`, `background` and the like are removed).
  CSS (stylesheets, `<style>`, `style` attributes) has its escapes written out first, then every
  `url()` resolved inside the book (pictures only) or replaced with `none`, `@import`,
  `@font-face` and `@namespace` dropped, and functions that could still fetch (`image-set()`,
  `image()`, `src()`, `cross-fade()`, `element()`, `paint()`, `expression()`, and any `url(` the
  pattern didn't take) made invalid, so the browser drops the declaration. A book's own fonts
  aren't used (a shadow root doesn't apply `@font-face` anyway).
- **The book stays in its box**: the page has `contain: paint`, so even `position: fixed`
  content is drawn inside it, under the reader's toolbar.
- **Broken or hostile files**: each zip entry inflates only up to the size its directory gave
  and 50 MB at most (zip bombs), at most 20,000 entries and 5,000 chapters, chapters up to 10 MB,
  stylesheets 2 MB, SVGs 5 MB. A file that can't be read says "This book couldn't be opened"
  (damaged, copy-protected or not an EPUB); Download still works.
- Not done: fixed-layout books (comics, picture books) open as ordinary chapters; no page
  turning (the user chose scrolling); no audio or video in books; positions aren't synced
  between devices (nothing about reading reaches the server).
- **Privacy:** the server sees one more upload (the cover) beside the book, never what's in
  either, as for image thumbnails; in guilds, where it can read the message, it could read both,
  as any guild file. Checked by `e2e/epubreader.mjs`.

## PDF reader

PDFs sent as attachments are read in the app (2026-11-26, Kan card VOI-276), in DMs, group DMs,
notes and guilds, without leaving it and without anything going to the server or another site.
Drawn by Mozilla's PDF.js (`pdfjs-dist`, Apache-2.0, credited in Settings → About), its legacy
build: the modern one needs JavaScript newer than many phones' WebViews (`Uint8Array.toHex`), and
the legacy one is only ~60 KB bigger. Not the browser's own viewer: Android's WebView has none,
Electron's needs plugins on, and opening a `blob:` PDF as a page is what Attachment types avoid.

- **In the chat** (`Attachment.jsx` `DocumentBox`, shared with books): the PDF's first page, its
  name, "12 pages · 3.4 MB", **Open** and the download button. A PDF is told by its type
  (`application/pdf`) or a `.pdf` name (`utils/pdf.js` `isPdf`; new uploads with no type are typed
  by the name, `utils/fileTypeFromName.js`). A spoiler's page is covered like an image.
  Webhooks' and bots' PDFs (`MessageFiles.jsx`) get Open when they're in our own store, without a
  preview or page count (they don't carry our fragment).
- **The preview and page count** are made on the sender's device when the PDF is attached
  (`utils/mediaDimensions.js` → `services/pdf/pdfPreview.js`), for PDFs up to 50 MB (PDF.js reads a
  whole file into memory): page 1 drawn by PDF.js on a canvas and saved as a new JPEG (at most
  280×400), sent as the attachment's thumbnail (`p=` with `w`/`h`, encrypted with the file's key,
  see Image thumbnails), and the number of pages as `pg=` in the attachment's URL (inside the
  message's encryption in DMs and groups; `attachmentCrypto.js`, at most 10,000). Bigger, locked
  and broken PDFs get neither. Older apps ignore both and show a plain file. Readers never
  download a PDF to find either.
- **The reader** (`PdfReader.jsx`, loaded with PDF.js only when a PDF is first opened; the same
  provider as books, `ReaderProvider.jsx`, so Back closes it): full screen, pages scrolling,
  laid out and drawn by PDF.js's `PDFViewer` (only pages near the screen are drawn; far ones are
  let go), with selectable text. Toolbar: the page number (type one to jump), zoom (−/+ and a menu:
  Automatic, the page's width up to 125%, the default; Fit width; Fit page; percentages; pinch and
  Ctrl+wheel too; on a phone only the menu and pinching), Find (PDF.js's find controller: every
  match highlighted, next/previous, "3 of 12"), Contents (the PDF's outline, when it has one) and
  Download. Keys: Escape (Find, then Contents, then the PDF), ← → and Page Up/Down by a page,
  Home/End, Ctrl/⌘+F, Ctrl/⌘ +/−/0. Pages stay white, like paper (the user chose no dark pages);
  everything around them is the theme's (`pdfReader.css`; `pdfjsViewer.css` is the part of PDF.js's
  `pdf_viewer.css` the reader uses, copied because the whole file styles global names such as
  `.dialog` and `.sidebar`; regenerate it when updating `pdfjs-dist`). Where a PDF was left (page and
  how far down it) is kept in this device's localStorage (`pdfPosition:<the file's name in the
  store>`, `utils/pdfPosition.js`), deleted at logout; the zoom is the device's own (`pdfZoom`).
- **Locked PDFs** (the user's choice): the reader asks for the password (PDF.js's `onPassword`),
  says when one was wrong and asks again; Cancel closes it. The password is only handed to PDF.js
  in this page, never saved or sent anywhere.
- **What PDF.js may do** (`services/pdf/pdfjs.js`, the only place it's set up):
  - Its worker is our own file (`pdf.worker.min-*.js`; Vite emits it as `.js`, so the precache takes
    it and servers give it a script's type), allowed by the CSP's `script-src 'self'`.
  - PDF JavaScript never runs: no scripting sandbox (`PDFScriptingManager`) is ever made, XFA is off,
    and PDF.js 6 has no eval-based font path (CVE-2024-4367's route; the CSP refuses eval anyway).
  - Forms are drawn but can't be filled in (`annotationMode: ENABLE`), and files attached inside a
    PDF are never opened (no download manager).
  - Links: the PDF's own (`#...`) go to their page; a link to another site opens in the browser
    (target `_blank`, `noopener noreferrer`), and only `http(s):` and `mailto:` ones (the reader
    stops anything else). PDF.js itself makes a plain web link of a script that only opens an
    address (`app.launchURL`) and of a link to another site's PDF (GoToR); Launch, form
    submissions and `javascript:` become no link at all.
  - Caps against hostile files: pictures over 50 megapixels aren't decoded, a canvas is at most
    256 MB, and a PDF of more than 10,000 pages isn't opened.
- **Nothing is fetched from another site**: PDF.js's data files (character maps, standard fonts,
  colour profiles, and its JPEG 2000/JBIG2 decoders as WebAssembly with JavaScript fallbacks) are
  served by us at `/pdfjs/<folder>/` (`vite.config.js` `pdfjsAssets`: from the npm package in dev,
  copied into the build), and left out of the precache: only some PDFs want them, so a PDF that
  needs one (CJK text without its own fonts, say) may not draw fully offline. PDF.js and its
  worker are precached.
- **Broken or other files**: one that can't be read says "This PDF couldn't be opened" (damaged or
  not a PDF); Download still works.
- Not done: streaming big PDFs in ranges (the whole file is downloaded and decrypted first, as for
  books); filling in forms, printing, annotating; positions synced between devices.
- **Privacy:** the server sees one more upload (the preview) beside the PDF, never what's in
  either, as for image thumbnails; in guilds, where it can read the message, it could read both,
  as any guild file. The page count is inside the encrypted message in DMs and groups. Passwords
  and reading positions never leave the device. Checked by `e2e/pdfreader.mjs`.
