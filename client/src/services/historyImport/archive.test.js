import { describe, it, expect } from 'vitest';
import { findEntry, normalisePath, openArchive, resolvePath } from './archive';
import { zip } from '../../test/zipFixture';


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
