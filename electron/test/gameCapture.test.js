import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

const require = createRequire(import.meta.url);
const { createGameCapture, HOOK_FILES, HELPER } = require('../gameCapture.js');

const DIR = 'C:\\Voicaw\\resources\\game-capture';

// A stand-in voicaw-capture.exe: say(event) prints a line, `written` is what it was told.
function fakeHelper() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.written = [];
    child.stdin = new PassThrough();
    child.stdin.on('data', (data) => child.written.push(...String(data).trim().split('\n')));
    child.kill = vi.fn(() => child.emit('exit', 1));
    child.say = (event) => child.stdout.write(`${JSON.stringify(event)}\n`);
    return child;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function setUp({ platform = 'win32', files = [HELPER, ...HOOK_FILES], windows = [{ hwnd: '4242', pid: 7, title: 'Dota 2', width: 1920, height: 1080 }], pids = [7] } = {}) {
    const children = [];
    const spawn = vi.fn(() => {
        const child = fakeHelper();
        children.push(child);
        return child;
    });
    const execFile = vi.fn((file, args, options, callback) => callback(null, JSON.stringify({ windows })));
    const imports = [];
    const sends = [];
    const sharedTexture = {
        importSharedTexture: vi.fn((options) => {
            const imported = { options, release: vi.fn() };
            imports.push(imported);
            return imported;
        }),
        sendSharedTexture: vi.fn(async (options, ...args) => { sends.push({ options, args }); }),
    };
    const sent = [];
    const frame = { id: 'main frame' };
    const capture = createGameCapture({
        platform,
        dir: DIR,
        fs: { existsSync: (file) => files.some((name) => file.endsWith(name)) },
        spawn,
        execFile,
        sharedTexture,
        parentPid: 999,
        gamePids: async () => pids,
        getFrame: () => frame,
        send: (state) => sent.push(state),
    });
    return { capture, spawn, execFile, children, imports, sends, sent, sharedTexture, frame };
}

const READY = { event: 'ready', gen: 1, width: 1920, height: 1080, format: 'bgra', handles: ['1000', '1004', '1008', '1012'] };

describe('game capture (desktop app, Windows)', () => {
    let t;
    beforeEach(() => { t = setUp(); });

    it('is there only on Windows, with the helper and every hook file', () => {
        expect(t.capture.available()).toBe(true);
        expect(setUp({ platform: 'linux' }).capture.available()).toBe(false);
        expect(setUp({ files: [HELPER] }).capture.available()).toBe(false);
    });

    it('lists the games\' windows through the helper', async () => {
        const games = await t.capture.listGames();
        expect(games).toEqual([{ hwnd: '4242', pid: 7, title: 'Dota 2', width: 1920, height: 1080 }]);
        expect(t.execFile.mock.calls[0][1]).toEqual(['--list', '7']);
        // No games running: the helper isn't even asked.
        const none = setUp({ pids: [] });
        expect(await none.capture.listGames()).toEqual([]);
        expect(none.execFile).not.toHaveBeenCalled();
    });

    it('only starts a window it just listed', async () => {
        await expect(t.capture.start('4242', 60)).rejects.toMatchObject({ code: 'not_listed' });
        await t.capture.listGames();
        await expect(t.capture.start('31337', 60)).rejects.toMatchObject({ code: 'not_listed' });
        expect(t.spawn).not.toHaveBeenCalled();
    });

    it('starts the helper for the game and resolves with the first set of textures', async () => {
        await t.capture.listGames();
        const started = t.capture.start('4242', 30);
        await tick();
        expect(t.spawn.mock.calls[0][1]).toEqual(['--hwnd', '4242', '--parent', '999', '--dir', DIR, '--fps', '30']);
        t.children[0].say({ event: 'log', message: 'injecting the 64-bit hook' });
        t.children[0].say(READY);
        await expect(started).resolves.toEqual({ id: 1, width: 1920, height: 1080 });
        expect(t.sent).toEqual([{ id: 1, state: 'live', width: 1920, height: 1080 }]);
    });

    it('imports each frame, sends it to the page, and frees its slot once everyone is done with it', async () => {
        await t.capture.listGames();
        const started = t.capture.start('4242', 60);
        await tick();
        const helper = t.children[0];
        helper.say(READY);
        await started;
        helper.say({ event: 'frame', gen: 1, slot: 2, timestamp: 123456 });
        await tick();
        const [imported] = t.imports;
        const info = imported.options.textureInfo;
        expect(info.pixelFormat).toBe('bgra');
        expect(info.codedSize).toEqual({ width: 1920, height: 1080 });
        expect(info.timestamp).toBe(123456);
        expect(info.handle.ntHandle.readBigUInt64LE()).toBe(1008n);
        expect(t.sends[0].options).toEqual({ frame: t.frame, importedSharedTexture: imported });
        expect(imported.release).toHaveBeenCalled();
        expect(helper.written).not.toContain('free 1 2');
        imported.options.allReferencesReleased();
        imported.options.allReferencesReleased();
        await tick();
        expect(helper.written.filter((line) => line === 'free 1 2')).toHaveLength(1);
    });

    it('moves to a new set of textures after a resize and retires the old one', async () => {
        await t.capture.listGames();
        const started = t.capture.start('4242', 60);
        await tick();
        const helper = t.children[0];
        helper.say(READY);
        await started;
        helper.say({ ...READY, gen: 2, width: 1280, height: 720, handles: ['2000', '2004', '2008', '2012'] });
        helper.say({ event: 'frame', gen: 1, slot: 0, timestamp: 1 }); // in flight from the old set
        helper.say({ event: 'frame', gen: 2, slot: 0, timestamp: 2 });
        await tick();
        expect(helper.written).toContain('retire 1');
        expect(helper.written).toContain('free 1 0'); // never imported
        expect(t.imports).toHaveLength(1);
        expect(t.imports[0].options.textureInfo.codedSize).toEqual({ width: 1280, height: 720 });
        expect(t.sent.at(-1)).toEqual({ id: 1, state: 'live', width: 1280, height: 720 });
    });

    it('rejects with the helper\'s reason when the game can\'t be hooked', async () => {
        await t.capture.listGames();
        const started = t.capture.start('4242', 60);
        await tick();
        t.children[0].say({ event: 'error', code: 'hook_not_loaded', message: 'The game didn\'t load the capture hook.' });
        await expect(started).rejects.toEqual({ code: 'hook_not_loaded', message: 'The game didn\'t load the capture hook.' });
        expect(t.sent).toEqual([]);
    });

    it('tells the page when a live capture ends or fails, and stops on a failed import', async () => {
        await t.capture.listGames();
        let started = t.capture.start('4242', 60);
        await tick();
        t.children[0].say(READY);
        await started;
        t.children[0].say({ event: 'stopped', reason: 'game_closed' });
        await tick();
        expect(t.sent.at(-1)).toEqual({ id: 1, state: 'stopped', reason: 'game_closed' });

        started = t.capture.start('4242', 60);
        await tick();
        t.children[1].say(READY);
        await started;
        t.sharedTexture.importSharedTexture.mockImplementationOnce(() => { throw new Error('Failed to create shared image'); });
        t.children[1].say({ event: 'frame', gen: 1, slot: 0, timestamp: 1 });
        await tick();
        expect(t.sent.at(-1)).toMatchObject({ id: 2, state: 'error', code: 'import_failed' });
        expect(t.children[1].written).toContain('free 1 0');
        expect(t.children[1].written).toContain('stop');
    });

    it('stop() asks the helper to stop and hangs up; starting another stops the last', async () => {
        await t.capture.listGames();
        const first = t.capture.start('4242', 60);
        await tick();
        t.children[0].say(READY);
        await first;
        t.capture.setFrameRate(30);
        expect(t.children[0].written).toContain('fps 30');
        const second = t.capture.start('4242', 60);
        await tick();
        expect(t.children[0].written).toContain('stop');
        t.children[0].emit('exit', 0);
        t.children[1].say(READY);
        await expect(second).resolves.toMatchObject({ id: 2 });
        // The first one's end is tagged with its own id, so the page ignores it.
        expect(t.sent.filter((s) => s.state === 'stopped').map((s) => s.id)).toEqual([1]);
        t.capture.stop();
        expect(t.children[1].written).toContain('stop');
    });

    it('fails a start that never gets a frame, and one whose helper dies', async () => {
        vi.useFakeTimers();
        try {
            await t.capture.listGames();
            const started = t.capture.start('4242', 60);
            const result = expect(started).rejects.toMatchObject({ code: 'timeout' });
            await vi.advanceTimersByTimeAsync(61 * 1000);
            await result;
        } finally {
            vi.useRealTimers();
        }
        const crashed = t.capture.start('4242', 60);
        await tick();
        t.children[1].emit('exit', 3221225477);
        await expect(crashed).rejects.toMatchObject({ code: 'helper_failed' });
    });
});
