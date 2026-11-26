// For tests: a zip of `files` ({ name: string or Uint8Array content }), the first stored, the
// rest deflated, as zip tools write them (local headers, then the central directory, then its
// end record). Node's own Blob and File, which jsdom's lack streams.
import { Blob, File } from 'node:buffer';

export async function zip(files, fileName = 'export.zip') {
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const entries = Object.entries(files);
  for (const [index, [name, text]] of entries.entries()) {
    const raw = typeof text === 'string' ? encoder.encode(text) : text;
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
  return new File([...parts, ...central, new Uint8Array(end.buffer)], fileName, { type: 'application/zip' });
}
