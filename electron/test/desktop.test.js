import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveAppFile } = require('../protocol.js');
const { createSettingsStore, cleanChanges } = require('../desktopSettings.js');
const { cleanNotification } = require('../notifications.js');
const { paintDot, unreadLabel } = require('../tray.js');
const { linuxAutostartEntry } = require('../autoStart.js');
const { spellcheckLanguages, syncSpellingWords } = require('../spellcheck.js');
const { STREAM_WINDOW_NAME, windowOpenAction, streamWindowPermission } = require('../windowOpen.js');

describe('serving the app (protocol.js)', () => {
    let root;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'voicaw-app-'));
        fs.writeFileSync(path.join(root, 'index.html'), '<html>');
        fs.mkdirSync(path.join(root, 'assets'));
        fs.writeFileSync(path.join(root, 'assets', 'main.js'), '');
        fs.writeFileSync(path.join(os.tmpdir(), 'voicaw-secret.txt'), 'secret');
    });

    it('serves files, and the page for app routes', () => {
        expect(resolveAppFile(root, '/assets/main.js')).toBe(path.join(root, 'assets', 'main.js'));
        expect(resolveAppFile(root, '/')).toBe(path.join(root, 'index.html'));
        expect(resolveAppFile(root, '/dm/5')).toBe(path.join(root, 'index.html'));
        expect(resolveAppFile(root, '/guild/1/2')).toBe(path.join(root, 'index.html'));
    });

    it('404s a missing file rather than serving the page for it', () => {
        expect(resolveAppFile(root, '/assets/gone.js')).toBeNull();
    });

    it('never leaves the app folder', () => {
        const name = path.basename(root);
        expect(resolveAppFile(root, '/../voicaw-secret.txt')).toBeNull();
        expect(resolveAppFile(root, '/%2e%2e/voicaw-secret.txt')).toBeNull();
        expect(resolveAppFile(root, `/..%2f${name}-x/secret`)).toBeNull();
        expect(resolveAppFile(root, '/%E0%A4%A')).toBeNull(); // bad encoding
    });
});

describe('desktop settings (desktopSettings.js)', () => {
    it('keeps only known settings with the right types', () => {
        expect(cleanChanges({ closeToTray: false, startAtLogin: 'yes', evil: 1 })).toEqual({ closeToTray: false });
        expect(cleanChanges({ shortcuts: { toggleMute: 'Control+Shift+M', toggleDeafen: 'rm -rf /;', other: 'A' } }))
            .toEqual({ shortcuts: { toggleMute: 'Control+Shift+M' } });
        expect(cleanChanges({ shortcuts: { toggleMute: null } })).toEqual({ shortcuts: { toggleMute: null } });
        expect(cleanChanges(null)).toEqual({});
    });

    it('saves to the data folder and reads back, one shortcut at a time', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicaw-settings-'));
        const store = createSettingsStore(dir);
        expect(store.get()).toMatchObject({ closeToTray: true, startAtLogin: false, shortcuts: { toggleMute: null, toggleDeafen: null } });
        store.update({ shortcuts: { toggleMute: 'Control+Shift+M' } });
        store.update({ shortcuts: { toggleDeafen: 'Control+Shift+D' }, closeToTray: false });
        store.setWindow({ x: 1, y: 2, width: 800, height: 600, maximized: false });
        expect(createSettingsStore(dir).get()).toMatchObject({
            closeToTray: false,
            shortcuts: { toggleMute: 'Control+Shift+M', toggleDeafen: 'Control+Shift+D' },
            window: { width: 800 },
        });
    });

    it('starts from the defaults when the file is broken', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicaw-settings-'));
        fs.writeFileSync(path.join(dir, 'desktop-settings.json'), '{not json');
        expect(createSettingsStore(dir).get().closeToTray).toBe(true);
    });
});

describe('notifications from the page (notifications.js)', () => {
    it('keeps the fields, within limits', () => {
        expect(cleanNotification({ title: 'Alice', body: 'hi', url: '/dm/2', tag: 'dm-2', icon: 'data:image/png;base64,AAAA' }))
            .toEqual({ title: 'Alice', body: 'hi', url: '/dm/2', tag: 'dm-2', icon: 'data:image/png;base64,AAAA' });
        expect(cleanNotification({ title: 'x'.repeat(1000) }).title).toHaveLength(200);
    });

    it('only opens app paths and only takes image data', () => {
        expect(cleanNotification({ url: 'https://evil.example' }).url).toBe('/');
        expect(cleanNotification({ url: '//evil.example/x' }).url).toBe('/');
        expect(cleanNotification({ icon: 'file:///etc/passwd' }).icon).toBeNull();
        expect(cleanNotification({ icon: 'https://example.com/a.png' }).icon).toBeNull();
        expect(cleanNotification('nope')).toBeNull();
        expect(cleanNotification({}).title).toBe('Voicaw');
    });
});

describe('tray (tray.js)', () => {
    it('paints a red dot in the bottom right corner, leaving the top left alone', () => {
        const size = 16;
        const bitmap = paintDot(Buffer.alloc(size * size * 4, 0x80), size);
        const at = (x, y) => [...bitmap.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
        expect(at(13, 13)).toEqual([0x45, 0x42, 0xed, 255]); // BGRA
        expect(at(1, 1)).toEqual([0x80, 0x80, 0x80, 0x80]);
    });

    it('says what is unread', () => {
        expect(unreadLabel({ count: 3, dot: true })).toBe('Voicaw: 3 unread');
        expect(unreadLabel({ count: 0, dot: true })).toBe('Voicaw: unread messages');
        expect(unreadLabel({ count: 0, dot: false })).toBe('Voicaw');
    });
});

describe('start at login on Linux (autoStart.js)', () => {
    it('runs the app hidden, quoting paths with spaces', () => {
        expect(linuxAutostartEntry('/opt/Voicaw/voicaw')).toContain('Exec=/opt/Voicaw/voicaw --hidden');
        expect(linuxAutostartEntry('/home/a b/Voicaw.AppImage')).toContain('Exec="/home/a b/Voicaw.AppImage" --hidden');
        expect(linuxAutostartEntry('/x/"$y"')).toContain('Exec="/x/\\"\\$y\\"" --hidden');
    });
});

describe('spellcheck languages (spellcheck.js)', () => {
    it('picks the system languages it has, else British English', () => {
        expect(spellcheckLanguages(['fr-CA', 'en-US'], ['en-GB', 'en-US', 'fr'])).toEqual(['fr', 'en-US']);
        expect(spellcheckLanguages(['xx'], ['en-GB'])).toEqual(['en-GB']);
    });

    it("keeps Electron's dictionary to the account's words", async () => {
        const words = new Set(['old', 'kept']);
        const session = {
            listWordsInSpellCheckerDictionary: async () => [...words],
            addWordToSpellCheckerDictionary: (w) => words.add(w),
            removeWordFromSpellCheckerDictionary: (w) => words.delete(w),
        };
        await syncSpellingWords(session, ['kept', 'Voicaw', 42, '']);
        expect([...words].sort()).toEqual(['Voicaw', 'kept']);
        await syncSpellingWords(session, 'nonsense');
        expect([...words].sort()).toEqual(['Voicaw', 'kept']);
    });
});

describe('windows the page opens (windowOpen.js)', () => {
    function open(details) {
        const opened = [];
        const result = windowOpenAction(details, { icon: '/icon.png', openExternal: (url) => opened.push(url) });
        return { result, opened };
    }

    it('lets the popped-out stream open, as a window with the app icon', () => {
        const { result, opened } = open({ url: 'about:blank', frameName: STREAM_WINDOW_NAME });
        expect(result.action).toBe('allow');
        expect(result.overrideBrowserWindowOptions.icon).toBe('/icon.png');
        expect(opened).toEqual([]);
    });

    it('sends links to the browser and opens nothing else', () => {
        expect(open({ url: 'https://example.com/', frameName: '' })).toEqual({ result: { action: 'deny' }, opened: ['https://example.com/'] });
        expect(open({ url: 'mailto:a@example.com', frameName: '' }).opened).toEqual(['mailto:a@example.com']);
        // The stream window's name with a page in it, or a blank window by another name.
        expect(open({ url: 'voicaw://app/', frameName: STREAM_WINDOW_NAME })).toEqual({ result: { action: 'deny' }, opened: [] });
        expect(open({ url: 'about:blank', frameName: 'other' })).toEqual({ result: { action: 'deny' }, opened: [] });
        expect(open({ url: 'file:///etc/passwd', frameName: '' }).opened).toEqual([]);
    });

    it('gives the stream window full screen and nothing else', () => {
        expect(streamWindowPermission('fullscreen')).toBe(true);
        for (const permission of ['media', 'notifications', 'display-capture', 'clipboard-sanitized-write']) {
            expect(streamWindowPermission(permission)).toBe(false);
        }
    });
});
