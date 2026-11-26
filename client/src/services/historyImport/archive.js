// An exported archive as the history import reads it (docs/guilds.md, History imports): its
// files by path, each read only when needed, so an export of several GB (its media folder) is
// never in memory at once. From files picked one by one, a picked folder (each File's
// webkitRelativePath), or a .zip read in place: its directory from the end of the file, then
// each entry's bytes sliced out and inflated by the browser (DecompressionStream). Zip64 (over
// 4 GB) is read too (utils/zip.js). Encrypted zips aren't.

import { normalisePath, openZip } from '../../utils/zip';

export { normalisePath };

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
