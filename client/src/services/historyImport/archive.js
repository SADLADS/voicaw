// An exported archive as the history import reads it (docs/guilds.md, History imports): its
// files by path, each read only when needed, so an export of several GB (its media folder) is
// never in memory at once. From files picked one by one, a picked folder (each File's
// webkitRelativePath), or a .zip read in place: its directory from the end of the file, then
// each entry's bytes sliced out and inflated by the browser (DecompressionStream). Zip64 (over
// 4 GB) is read too. Encrypted zips aren't.

// A path as the archive's own JSON refers to it: forward slashes, no "./", decoded.
export function normalisePath(path) {
  let clean = String(path).replace(/\\/g, '/');
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // not URI-encoded
  }
  const parts = [];
  for (const part of clean.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

// `target` (relative, as a JSON file gives it) from the folder of `from` (a path in the archive).
export function resolvePath(from, target) {
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
  return normalisePath(dir + target);
}

// -> { entries: Map(path -> { path, size, blob(): Promise<Blob> }) } from picked Files.
export async function openArchive(files) {
  const list = [...files];
  if (list.length === 1 && /\.zip$/i.test(list[0].name)) return openZip(list[0]);
  const entries = new Map();
  for (const file of list) {
    const path = normalisePath(file.webkitRelativePath || file.name);
    entries.set(path, { path, size: file.size, blob: async () => file });
  }
  return { entries };
}

// Finds an entry by a path the JSON gave (exact, or by case, or URI-decoded).
export function findEntry(archive, path) {
  const exact = archive.entries.get(normalisePath(path));
  if (exact) return exact;
  const lower = normalisePath(path).toLowerCase();
  for (const [key, entry] of archive.entries) if (key.toLowerCase() === lower) return entry;
  return null;
}

// ---- Zip ----

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const EOCD64 = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const view = async (blob) => new DataView(await blob.arrayBuffer());
const u64 = (dv, at) => Number(dv.getBigUint64(at, true));

async function openZip(file) {
  // The end-of-directory record is in the last 64 kB + 22 bytes (its comment's longest).
  const tailStart = Math.max(0, file.size - 65_557);
  const tail = await view(file.slice(tailStart));
  let at = -1;
  for (let i = tail.byteLength - 22; i >= 0; i -= 1) {
    if (tail.getUint32(i, true) === EOCD) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new Error('not a zip');
  let count = tail.getUint16(at + 10, true);
  let dirSize = tail.getUint32(at + 12, true);
  let dirOffset = tail.getUint32(at + 16, true);
  // Zip64: the real numbers are in the zip64 record its locator points to.
  if (at >= 20 && tail.getUint32(at - 20, true) === EOCD64_LOCATOR) {
    const record = await view(file.slice(u64(tail, at - 20 + 8), u64(tail, at - 20 + 8) + 56));
    if (record.getUint32(0, true) === EOCD64) {
      count = u64(record, 32);
      dirSize = u64(record, 40);
      dirOffset = u64(record, 48);
    }
  }
  const dir = await view(file.slice(dirOffset, dirOffset + dirSize));
  const decoder = new TextDecoder();
  const entries = new Map();
  let p = 0;
  for (let n = 0; n < count && p + 46 <= dir.byteLength; n += 1) {
    if (dir.getUint32(p, true) !== CENTRAL) break;
    const flags = dir.getUint16(p + 8, true);
    const method = dir.getUint16(p + 10, true);
    let compressed = dir.getUint32(p + 20, true);
    let size = dir.getUint32(p + 24, true);
    const nameLength = dir.getUint16(p + 28, true);
    const extraLength = dir.getUint16(p + 30, true);
    const commentLength = dir.getUint16(p + 32, true);
    let localOffset = dir.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLength));
    // Zip64 sizes and offset, in the order the 0xffffffff fields came.
    let e = p + 46 + nameLength;
    const extraEnd = e + extraLength;
    while (e + 4 <= extraEnd) {
      const id = dir.getUint16(e, true);
      const length = dir.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = u64(dir, q); q += 8; }
        if (compressed === 0xffffffff) { compressed = u64(dir, q); q += 8; }
        if (localOffset === 0xffffffff) localOffset = u64(dir, q);
      }
      e += 4 + length;
    }
    p = extraEnd + commentLength;
    if (name.endsWith('/') || flags & 1) continue; // folders; encrypted entries
    if (method !== 0 && method !== 8) continue; // only stored and deflated
    const path = normalisePath(name);
    entries.set(path, {
      path,
      size,
      blob: async () => {
        const local = await view(file.slice(localOffset, localOffset + 30));
        if (local.getUint32(0, true) !== LOCAL) throw new Error('bad zip entry');
        const start = localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
        const raw = file.slice(start, start + compressed);
        if (method === 0) return raw;
        return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
      },
    });
  }
  return { entries };
}
