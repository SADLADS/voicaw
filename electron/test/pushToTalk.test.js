import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createPushToTalk, PUSH_TO_TALK_KEYS } = require('../pushToTalk.js');

// uiohook-napi as far as pushToTalk.js uses it.
function fakeHook({ failStart = false } = {}) {
    const uIOhook = new EventEmitter();
    uIOhook.running = false;
    uIOhook.start = vi.fn(() => {
        if (failStart) throw new Error('Failed to open X11 display.');
        uIOhook.running = true;
    });
    uIOhook.stop = vi.fn(() => { uIOhook.running = false; });
    return { uIOhook, UiohookKey: { V: 47, Backquote: 41, Ctrl: 29, F13: 91 } };
}

describe('push to talk in other apps (pushToTalk.js)', () => {
    let lib;
    let changes;
    let ptt;
    beforeEach(() => {
        lib = fakeHook();
        changes = [];
        ptt = createPushToTalk({ loadHook: () => lib, onChange: (down) => changes.push(down) });
    });

    it('hooks the keyboard only once asked, and reports only that key', () => {
        expect(lib.uIOhook.start).not.toHaveBeenCalled();
        expect(ptt.set('KeyV')).toBe(true);
        expect(lib.uIOhook.running).toBe(true);
        lib.uIOhook.emit('keydown', { keycode: 41 });
        lib.uIOhook.emit('keydown', { keycode: 47 });
        lib.uIOhook.emit('keydown', { keycode: 47 }); // repeating
        lib.uIOhook.emit('keyup', { keycode: 41 });
        lib.uIOhook.emit('keyup', { keycode: 47 });
        expect(changes).toEqual([true, false]);
    });

    it('takes mouse side buttons', () => {
        ptt.set('Mouse4');
        lib.uIOhook.emit('mousedown', { button: 1 });
        lib.uIOhook.emit('mousedown', { button: 4 });
        lib.uIOhook.emit('mouseup', { button: 4 });
        expect(changes).toEqual([true, false]);
    });

    it('stops the hook when no longer wanted, letting go of a held key', () => {
        ptt.set('ControlLeft');
        lib.uIOhook.emit('keydown', { keycode: 29 });
        expect(ptt.set(null)).toBe(true);
        expect(changes).toEqual([true, false]);
        expect(lib.uIOhook.running).toBe(false);
        expect(lib.uIOhook.listenerCount('keydown')).toBe(0);
        lib.uIOhook.emit('keydown', { keycode: 29 });
        expect(changes).toEqual([true, false]);
    });

    it('switches keys without restarting, letting go of the old one', () => {
        ptt.set('KeyV');
        lib.uIOhook.emit('keydown', { keycode: 47 });
        ptt.set('F13');
        expect(changes).toEqual([true, false]);
        expect(lib.uIOhook.start).toHaveBeenCalledTimes(1);
        lib.uIOhook.emit('keydown', { keycode: 91 });
        expect(changes).toEqual([true, false, true]);
    });

    it('refuses keys it does not know, and says when the system will not let it hook', () => {
        expect(ptt.set('Escape')).toBe(false);
        expect(lib.uIOhook.start).not.toHaveBeenCalled();
        const failing = fakeHook({ failStart: true });
        const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
        const broken = createPushToTalk({ loadHook: () => failing, onChange: () => {} });
        expect(broken.set('KeyV')).toBe(false);
        expect(failing.uIOhook.listenerCount('keydown')).toBe(0);
        const missing = createPushToTalk({ loadHook: () => { throw new Error('no native module'); }, onChange: () => {} });
        expect(missing.set('KeyV')).toBe(false);
        quiet.mockRestore();
    });

    // Read from the package's types: loading the native module where there's no display (a
    // test run) makes the process fail as it exits.
    it('knows the real hook\'s name for every key', () => {
        const types = fs.readFileSync(path.join(path.dirname(require.resolve('uiohook-napi')), 'index.d.ts'), 'utf8');
        const names = types.slice(types.indexOf('UiohookKey'));
        const UiohookKey = Object.fromEntries([...names.matchAll(/readonly (\w+): (\d+);/g)].map(([, name, code]) => [name, Number(code)]));
        const real = createPushToTalk({ loadHook: () => ({ uIOhook: fakeHook().uIOhook, UiohookKey }), onChange: () => {} });
        for (const key of PUSH_TO_TALK_KEYS) expect(real.set(key), key).toBe(true);
    });
});
