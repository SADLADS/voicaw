import { describe, it, expect } from 'vitest';
import { normalisePath, openZip } from './zip';
import { zip } from '../test/zipFixture';

describe('zip', () => {
  it('normalises paths', () => {
    expect(normalisePath('./a\\b/../c%20d.png')).toBe('a/c d.png');
    expect(normalisePath('../../x')).toBe('x');
  });

  it('reads stored and deflated entries', async () => {
    const { entries } = await openZip(await zip({ mimetype: 'application/epub+zip', 'OEBPS/a.xhtml': '<p>hi</p>' }));
    expect(await (await entries.get('mimetype').blob()).text()).toBe('application/epub+zip');
    expect(await (await entries.get('OEBPS/a.xhtml').blob()).text()).toBe('<p>hi</p>');
  });

  it('refuses an entry over the cap, stored or deflated', async () => {
    const big = 'x'.repeat(5000);
    const { entries } = await openZip(await zip({ stored: big, deflated: big }), { maxEntryBytes: 1000 });
    await expect(entries.get('stored').blob()).rejects.toThrow('too big');
    await expect(entries.get('deflated').blob()).rejects.toThrow('too big');
  });

  it('stops inflating past the size the directory gave (a zip bomb)', async () => {
    const file = await zip({ a: 'small', b: 'y'.repeat(100_000) });
    // Make b's directory record claim 10 bytes.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const dv = new DataView(bytes.buffer);
    for (let i = bytes.length - 22; i >= 0; i -= 1) {
      if (dv.getUint32(i, true) === 0x02014b50 && String.fromCharCode(bytes[i + 46]) === 'b') {
        dv.setUint32(i + 24, 10, true);
        break;
      }
    }
    const { entries } = await openZip(new Blob([bytes]));
    await expect(entries.get('b').blob()).rejects.toThrow();
    expect(await (await entries.get('a').blob()).text()).toBe('small');
  });

  it('refuses a directory with too many entries', async () => {
    await expect(openZip(await zip({ a: '1', b: '2', c: '3' }), { maxEntries: 2 })).rejects.toThrow('too many');
  });
});
