# Uploads and attachments

## File uploads (S3-compatible object store)

`server/s3.js` wraps `@aws-sdk/client-s3` against `S3_ENDPOINT` (`forcePathStyle: true`, so this
targets a self-hosted/MinIO-style endpoint, not raw AWS). It auto-creates and makes public four
buckets on startup: `uploads`, `profile-pics`, `guild-icons`, `emojis`. Uploads are client-direct: the server only
issues short-lived (60s) pre-signed PUT URLs (`/api/upload_file`, and profile pictures' and
emoji originals, see Profiles and Guilds); the
client uploads the file straight to S3, bypassing the app server. Both routes require a `size` query
param, which is signed into the URL together with the content type (`s3.js` `signableHeaders`), so
the object store rejects a body of any other length or type (verified against the live MinIO).
Limits: 100MB for attachments (nginx's cap on media.voicaw.com), 8MB for profile picture originals,
which must be `image/*`. Profile pictures are unencrypted. Webhooks' files are the exception to
client-direct uploads: they arrive in the webhook request and the server stores them (see Webhooks).

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
- **Older clients** (a cached web app, an older desktop app) send no list: such a send keeps
  every upload of its sender from the last day that isn't linked yet, for good (`kept`), and
  their edits change nothing.
- **Files from before the registry** have no row and are never deleted. Migration 9 registered
  and linked the files guild messages and documents showed; DMs', notes' and group DMs' stay
  untracked (the server can't read those messages). A guild file from before that someone also
  pasted into a DM goes with the guild message.

## DM attachments (encrypted, uploaded on send)

Attachments are never uploaded when attached. The composer (`Composer.jsx`, `hooks/useAttachmentDrafts.js`) keeps them as local drafts
and inserts a markdown placeholder `![name](attachment:ID)` (`utils/attachmentMarkup.js`; the editor
shows it as a "📎 name" chip). Files come from the + menu, a paste, or a drop anywhere on the
window, as in Discord (`hooks/useFileDrop.js` `useWindowFileDrop`, while a composer is shown):
a file dragged in from outside the page covers the window with "Upload to <chat>"
(`FileDropOverlay.jsx`); drags that start in the page (an image from a message) and drags while
an `aria-modal` dialog is open are left alone. The tray
(`AttachmentTray.jsx`) previews drafts still referenced from the text. On send, each referenced
draft is encrypted with its own AES-GCM key (`services/attachmentCrypto.js`), uploaded as
`application/octet-stream` (`services/attachmentUpload.js`; server names it `<uuid>.bin`), and its
placeholder is replaced with `<fileUrl>#v=1&k=<key>&t=<mime>&s=<size>[&w=<px>&h=<px>][&p=<thumbnail>][&sp=1]` (image/video
dimensions, read at attach time by `utils/mediaDimensions.js`, let the renderer reserve the final
box before the file loads; `sp=1` marks a spoiler, see below). The fragment is never sent
to S3 and the URL only exists inside the E2EE message. `Attachment.jsx` renders every markdown image:
placeholders (pending messages, from local blob URLs), encrypted attachments (fetched, decrypted,
cached in `services/attachmentCache.js`; images inline, videos in the player below, anything else
a download box), and plain URLs (legacy unencrypted uploads, external images) as `<img>`.

**Image thumbnails** (since 2026-10-02): a big still image (JPEG, PNG, WebP or BMP that doesn't fit
the chat's 420×360 box at twice that, 840×720) also gets a smaller copy, made on the device at
attach time (`utils/mediaDimensions.js` `makeThumbnail`: drawn on a canvas, already turned the
way its EXIF says, so the copy carries no EXIF; a JPEG, or a WebP when it has transparency, a
PNG where the browser can't make WebPs). It's encrypted with the image's key, with additional
data `voicaw/attachment-thumbnail/v1` so neither can pass for the other
(`attachmentCrypto.js` `encryptAttachment` / `decryptThumbnail`), uploaded as its own
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
- **Streaming** (`services/videoStream.js` page side, `services/mediaStreamWorker.js` in the
  service worker): the `<video>` plays `/__voicaw-media/<random id>`; the worker asks the page
  for that id's file, key and size (over a `MessageChannel`, never in a URL), answers the
  browser's Range requests by fetching only the encrypted chunks they cover (`Range` on the object
  store, allowed by media.voicaw.com's CORS) and passes the bytes on only as the player reads them
  (`highWaterMark: 0`), with a small cache of decrypted chunks. So a seek to the middle downloads
  nothing before it, and the browser's own buffering decides how far ahead it reads (Chrome:
  ~6 MB at the start, then topping up as it plays). Needs a worker controlling the page that
  answers `voicaw-media-ping`: not the desktop app, a first visit, or an older worker. There (and
  for `v=1`), Play downloads and decrypts the whole file first, with a progress figure. If
  streaming fails (the worker reports `voicaw-media-failed`, or never served it), the player
  falls back to that; if the browser can't decode the video (e.g. HEVC from an iPhone in many
  desktop browsers) it says so over the poster and offers Download. That case used to show as a
  plain download box, the likely cause of "videos turned into download links" (not confirmed).

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
order. Its keys are caught at the window's capture phase, so Escape doesn't
also cancel a reply. Opening it pushes a history entry (keeping the router's state), so the
back button closes it.

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
message), so it offers Open Image instead (the decrypted copy in a new tab). Videos keep their
player's own download button.
