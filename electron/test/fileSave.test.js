import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createFileSaver, safeFileName } = require('../fileSave.js');

describe('saving a file a piece at a time (fileSave.js)', () => {
    let dir;
    beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicaw-save-')); });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    // A saver whose Save dialog answers `answer(defaultPath)`, recording what it was offered.
    function saver(answer) {
        const offered = [];
        const fileSaver = createFileSaver({
            showSaveDialog: async ({ defaultPath }) => {
                offered.push(defaultPath);
                return answer(defaultPath);
            },
            fs,
            downloadsDir: () => '/home/someone/Downloads',
        });
        return { fileSaver, offered };
    }

    it('writes the pieces to where the person chose, offering Downloads', async () => {
        const target = path.join(dir, 'film.mp4');
        const { fileSaver, offered } = saver(() => ({ canceled: false, filePath: target }));
        const id = await fileSaver.start('film.mp4');
        expect(offered).toEqual([path.join('/home/someone/Downloads', 'film.mp4')]);
        await fileSaver.append(id, new Uint8Array([1, 2, 3]));
        await fileSaver.append(id, new Uint8Array([4, 5]).subarray(1));
        expect(await fileSaver.finish(id)).toBe(target);
        expect([...fs.readFileSync(target)]).toEqual([1, 2, 3, 5]);
        await expect(fileSaver.append(id, new Uint8Array([6]))).rejects.toThrow();
    });

    it('starts nothing when the dialog is cancelled', async () => {
        const { fileSaver } = saver(() => ({ canceled: true }));
        expect(await fileSaver.start('a.txt')).toBeNull();
    });

    it('deletes what was written when cancelled', async () => {
        const target = path.join(dir, 'half.bin');
        const { fileSaver } = saver(() => ({ canceled: false, filePath: target }));
        const id = await fileSaver.start('half.bin');
        await fileSaver.append(id, new Uint8Array(1000));
        await fileSaver.cancel(id);
        expect(fs.existsSync(target)).toBe(false);
        await fileSaver.cancel(id); // twice is fine
    });

    it('offers only a plain file name', () => {
        expect(safeFileName('../../etc/passwd')).toBe('passwd');
        expect(safeFileName('a<b>:c?.txt')).toBe('a_b__c_.txt');
        expect(safeFileName('')).toBe('download');
        expect(safeFileName('..')).toBe('download');
    });
});
