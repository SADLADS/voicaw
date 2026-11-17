import { describe, it, expect } from 'vitest';
import { findEntry, normalisePath, openArchive, resolvePath } from './archive';

// A zip of `files` ({ name: string content }), the first stored, the rest deflated, as zip
// tools write them (local headers, then the central directory, then its end record).
async function zip(files) {
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const entries = Object.entries(files);
  for (const [index, [name, text]] of entries.entries()) {
    const raw = encoder.encode(text);
    const deflate = index > 0;
    const data = deflate
      ? new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())
      : raw;
    const nameBytes = encoder.encode(name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, deflate ? 8 : 0, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(10, deflate ? 8 : 0, true);
    dir.setUint32(20, data.length, true);
    dir.setUint32(24, raw.length, true);
    dir.setUint16(28, nameBytes.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const dirSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  return new File([...parts, ...central, new Uint8Array(end.buffer)], 'export.zip', { type: 'application/zip' });
}

describe('archives', () => {
  it('normalises and resolves paths as the export writes them', () => {
    expect(normalisePath('./a\\b/../c%20d.png')).toBe('a/c d.png');
    expect(resolvePath('exports/general.json', 'general.json_Files/x.png')).toBe('exports/general.json_Files/x.png');
    expect(resolvePath('general.json', 'general.json_Files/x.png')).toBe('general.json_Files/x.png');
  });

  it('reads picked files and a folder by their paths', async () => {
    const file = new File(['{"a":1}'], 'general.json');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'export/general.json' });
    const archive = await openArchive([file]);
    expect([...archive.entries.keys()]).toEqual(['export/general.json']);
    expect(await (await findEntry(archive, 'EXPORT/General.json').blob()).text()).toBe('{"a":1}');
  });

  it('reads a zip, stored and deflated entries, one at a time', async () => {
    const archive = await openArchive([await zip({
      'export/general.json': '{"channel":{"id":"1"}}',
      'export/general.json_Files/note.txt': 'hello '.repeat(200),
    })]);
    expect([...archive.entries.keys()]).toEqual(['export/general.json', 'export/general.json_Files/note.txt']);
    expect(await (await findEntry(archive, 'export/general.json').blob()).text()).toBe('{"channel":{"id":"1"}}');
    const note = findEntry(archive, 'export/general.json_Files/note.txt');
    expect(note.size).toBe(1200);
    expect(await (await note.blob()).text()).toBe('hello '.repeat(200));
  });

  it("refuses what isn't a zip", async () => {
    await expect(openArchive([new File(['nope'], 'x.zip')])).rejects.toThrow('not a zip');
  });
});
