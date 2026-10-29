import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createDownloads } = require('../downloads.js');

describe('the download popup (downloads.js)', () => {
    let dir;
    beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicaw-downloads-')); });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    // Downloads with a shell that records what it was asked (and whose bin can fail).
    function downloads({ trashFails = false } = {}) {
        const sent = [];
        const asked = [];
        const shell = {
            openPath: async (p) => { asked.push(['open', p]); return ''; },
            showItemInFolder: (p) => asked.push(['show', p]),
            trashItem: async (p) => {
                asked.push(['trash', p]);
                if (trashFails) throw new Error('No bin');
                fs.rmSync(p);
            },
        };
        return { list: createDownloads({ shell, fs, send: (d) => sent.push(d) }), sent, asked };
    }

    function file(name) {
        const p = path.join(dir, name);
        fs.writeFileSync(p, 'x');
        return p;
    }

    it('tells the page only an id, the name and the folder', () => {
        const { list, sent } = downloads();
        const id = list.add(file('photo.png'));
        expect(sent).toEqual([{ id, name: 'photo.png', folder: path.basename(dir) }]);
    });

    it('opens and shows the saved file, and nothing else', async () => {
        const { list, asked } = downloads();
        const target = file('notes.txt');
        const id = list.add(target);
        expect(await list.open(id)).toBe('');
        list.showInFolder(id);
        expect(asked).toEqual([['open', target], ['show', target]]);
        await expect(list.open(id + 1)).rejects.toThrow();
        expect(() => list.showInFolder('/etc/passwd')).toThrow();
    });

    it("says a file that's gone is missing instead of opening it", async () => {
        const { list, asked } = downloads();
        const target = file('gone.txt');
        const id = list.add(target);
        fs.rmSync(target);
        expect(await list.open(id)).toBe('missing');
        expect(asked).toEqual([]);
    });

    it('deletes to the bin, or for good without one, and forgets it', async () => {
        for (const trashFails of [false, true]) {
            const { list } = downloads({ trashFails });
            const target = file(`delete-${trashFails}.bin`);
            const id = list.add(target);
            await list.remove(id);
            expect(fs.existsSync(target)).toBe(false);
            await expect(list.open(id)).rejects.toThrow();
        }
    });
});
