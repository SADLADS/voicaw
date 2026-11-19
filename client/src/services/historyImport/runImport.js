import { findEntry, openArchive } from './archive';
import { isExport, parseExport, SOURCE } from './discordChatExporter';
import {
  addMessages, createImport, finishImport, knownMessages, setMapping, uploadAuthorAvatar, uploadFile,
} from './importService';

// The history import as the browser runs it (docs/guilds.md, History imports): read the
// archive, start the import with its authors and channels, map them, then send each channel's
// messages oldest first in batches, uploading their files just before. Batches are skipped by
// the server when already in, and files of messages already in aren't uploaded again
// (knownMessages), so a stopped import picks up where it was. Files the archive only links to
// are downloaded by this browser when the importer allows it (`download`; only from the
// archive's own CDN, see discordChatExporter.js `downloadable`), then uploaded the same way.

// The most a batch holds: the server's 500 messages, and under the 1 MB a request may be.
const BATCH_MESSAGES = 500;
const BATCH_BYTES = 800_000;
// Files bigger than the server takes (its LIMITS.file) stay "not included".
export const MAX_FILE_BYTES = 90 * 1024 * 1024;
const UPLOADS_AT_ONCE = 3;
// The server's limit for an author's picture (guildImports.js LIMITS.avatar).
const AVATAR_BYTES = 8 * 1024 * 1024;

// A file of the archive (`path` in it, or `url` to download when `download`), as a Blob, or
// null when it isn't there, can't be had or is bigger than `max` bytes.
export async function archiveFile(read, { path, url }, { download = read.download, max = MAX_FILE_BYTES } = {}) {
  const entry = path && findEntry(read.archive, path);
  if (entry) return entry.size > max ? null : entry.blob();
  if (!url || !download) return null;
  const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  if (Number(res.headers.get('content-length')) > max) return null;
  const blob = await res.blob();
  return blob.size > max ? null : blob;
}

const IMAGE_TYPES = { png: 'image/png', gif: 'image/gif', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', avif: 'image/avif' };
// The server's limit for an emoji's picture (emojiImage.js MAX_EMOJI_UPLOAD_BYTES).
const EMOJI_BYTES = 10 * 1024 * 1024;

// An archive emoji's picture as a File the guild's emoji route takes (typed: a zip's entries
// have no type). Throws when it can't be had.
export async function emojiFile(read, emoji) {
  const blob = await archiveFile(read, { path: emoji.imagePath, url: emoji.imageUrl }, { max: EMOJI_BYTES });
  if (!blob) throw new Error('emoji picture unavailable');
  const source = emoji.imagePath ?? new URL(emoji.imageUrl).pathname;
  const extension = source.split('.').pop().toLowerCase();
  const type = Object.values(IMAGE_TYPES).includes(blob.type) ? blob.type : IMAGE_TYPES[extension] ?? (emoji.animated ? 'image/gif' : 'image/png');
  return new File([blob], `${emoji.name}.${type.split('/')[1]}`, { type });
}

// Reads picked files (JSON exports, a folder with them and their media, or a zip of that).
// -> { archive, source, guildName, channels: [{ sourceId, name, category, thread, messages,
// first, last }], authors: Map(sourceId -> author), emojis: Map(sourceId -> emoji), files: {
// total, included, downloadable, expired, tooBig }, unreadable: [paths], download (whether to
// download linked files: on when there are any; the summary has a box for it) }
export async function readArchive(picked, { pollText }) {
  const archive = await openArchive(picked);
  const channels = [];
  const authors = new Map();
  const emojis = new Map();
  const unreadable = [];
  let guildName = null;
  for (const entry of archive.entries.values()) {
    if (!/\.json$/i.test(entry.path)) continue;
    let json;
    try {
      json = JSON.parse(await (await entry.blob()).text());
    } catch {
      unreadable.push(entry.path);
      continue;
    }
    if (!isExport(json)) {
      unreadable.push(entry.path);
      continue;
    }
    const parsed = parseExport(json, entry.path, { pollText });
    guildName ??= parsed.guildName;
    for (const [id, author] of parsed.authors) {
      const known = authors.get(id);
      if (!known) authors.set(id, author);
      else {
        known.messageCount += author.messageCount;
        known.avatarPath ??= author.avatarPath;
        known.avatarUrl ??= author.avatarUrl;
        known.names = [...new Set([...known.names, ...author.names])];
      }
    }
    for (const [id, emoji] of parsed.emojis) {
      const known = emojis.get(id);
      if (!known) emojis.set(id, emoji);
      else {
        known.uses += emoji.uses;
        known.imagePath ??= emoji.imagePath;
        known.imageUrl ??= emoji.imageUrl;
      }
    }
    const existing = channels.find((c) => c.sourceId === parsed.channel.sourceId);
    if (existing) {
      // The same channel exported in parts: put together, without repeats.
      const ids = new Set(existing.messages.map((m) => m.sourceId));
      existing.messages.push(...parsed.messages.filter((m) => !ids.has(m.sourceId)));
      existing.messages.sort((a, b) => a.timestamp - b.timestamp);
    } else {
      channels.push({ ...parsed.channel, messages: parsed.messages });
    }
  }
  let total = 0;
  let included = 0;
  let linked = 0;
  let expired = 0;
  let tooBig = 0;
  for (const channel of channels) {
    channel.first = channel.messages[0]?.timestamp ?? null;
    channel.last = channel.messages[channel.messages.length - 1]?.timestamp ?? null;
    for (const m of channel.messages) {
      for (const a of m.attachments) {
        total += 1;
        const entry = a.mediaPath && findEntry(archive, a.mediaPath);
        if ((entry ? entry.size : a.size) > MAX_FILE_BYTES) tooBig += 1;
        else if (entry) included += 1;
        else if (a.remoteUrl) linked += 1;
        else if (a.expired) expired += 1;
      }
    }
  }
  return {
    archive, source: SOURCE, guildName, channels, authors, emojis,
    files: { total, included, downloadable: linked, expired, tooBig },
    unreadable,
    download: linked > 0 || [...authors.values()].some((a) => !a.avatarPath && a.avatarUrl),
  };
}

// Starts the import on the server. -> its view, with `suggested` ({ authorId: userId }).
export function startImport(guildId, read, { label }) {
  return createImport(guildId, {
    source: read.source,
    sourceGuildName: read.guildName,
    label,
    authors: [...read.authors.values()].map((a) => ({ sourceId: a.sourceId, name: a.name, names: a.names, isBot: a.isBot })),
    channels: read.channels.map((c) => ({ sourceId: c.sourceId, name: c.name })),
    emojis: [...read.emojis.values()].map((e) => ({ sourceId: e.sourceId, name: e.name })),
  });
}

export { setMapping };

// A picture's size, for its attachment (so the message keeps its place while it loads).
async function imageSize(blob, name) {
  if (!/\.(png|jpe?g|gif|webp|avif)$/i.test(name) || typeof createImageBitmap !== 'function' || blob.size > 30 * 1024 * 1024) return {};
  try {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return size;
  } catch {
    return {};
  }
}

// Runs `tasks` (functions returning promises) `n` at a time.
async function inParallel(tasks, n) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next;
      next += 1;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return results;
}

// Sends everything (the channels mapped somewhere, `targets`: Set of archive channel ids).
// `onProgress({ messages, files, totalMessages, channel })`; `signal` (AbortSignal) stops it
// between batches. `view` is the import as the server last returned it (its author rows).
export async function sendImport(guildId, view, read, { targets, signal, onProgress }) {
  const authorIds = new Map(view.authors.map((a) => [a.source_id, a]));
  const channels = read.channels.filter((c) => targets.has(c.sourceId));
  const totalMessages = channels.reduce((n, c) => n + c.messages.length, 0);
  const progress = { messages: 0, files: 0, failedFiles: 0, totalMessages, channel: null };
  const report = () => onProgress?.({ ...progress });

  // Authors' pictures first (once each; not again on a resumed import).
  for (const author of read.authors.values()) {
    if (signal?.aborted) return progress;
    const row = authorIds.get(author.sourceId);
    if (!row || row.avatar || !(author.avatarPath || author.avatarUrl)) continue;
    try {
      const blob = await archiveFile(read, { path: author.avatarPath, url: author.avatarUrl }, { max: AVATAR_BYTES });
      if (blob) await uploadAuthorAvatar(guildId, view.id, row.id, blob);
    } catch (err) {
      console.warn('An imported picture failed', err);
    }
  }

  for (const channel of channels) {
    progress.channel = channel.name;
    let i = 0;
    while (i < channel.messages.length) {
      if (signal?.aborted) return progress;
      // The next batch, under both limits.
      const batch = [];
      let bytes = 0;
      while (i < channel.messages.length && batch.length < BATCH_MESSAGES) {
        const size = JSON.stringify(channel.messages[i]).length;
        if (batch.length && bytes + size > BATCH_BYTES) break;
        batch.push(channel.messages[i]);
        bytes += size;
        i += 1;
      }
      const known = new Set(await knownMessages(guildId, view.id, batch.map((m) => m.sourceId)));
      const fresh = batch.filter((m) => !known.has(m.sourceId));
      const uploads = [];
      for (const m of fresh) {
        m.attachments.forEach((a, index) => {
          const entry = a.mediaPath && findEntry(read.archive, a.mediaPath);
          if (entry ? entry.size > MAX_FILE_BYTES : !(read.download && a.remoteUrl) || a.size > MAX_FILE_BYTES) return;
          uploads.push(async () => {
            try {
              const blob = await archiveFile(read, { path: a.mediaPath, url: a.remoteUrl });
              if (!blob) return null;
              const stored = await uploadFile(guildId, view.id, blob, { name: a.filename, ...(await imageSize(blob, a.filename)) });
              progress.files += 1;
              return { m, index, stored };
            } catch (err) {
              console.warn('An imported file failed', err);
              progress.failedFiles += 1;
              return null;
            } finally {
              report();
            }
          });
        });
      }
      const stored = await inParallel(uploads, UPLOADS_AT_ONCE);
      const outgoing = fresh.map((m) => ({
        ...m,
        attachments: m.attachments.map((a, index) => {
          const done = stored.find((s) => s && s.m === m && s.index === index);
          return done ? done.stored : { filename: a.filename, size: a.size, missing: true };
        }),
      }));
      if (outgoing.length) await addMessages(guildId, view.id, { channelSourceId: channel.sourceId, messages: outgoing });
      progress.messages += batch.length;
      report();
    }
  }
  if (!signal?.aborted) await finishImport(guildId, view.id);
  return progress;
}
