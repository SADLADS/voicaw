import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createUpdater } = require('../updater.js');
const { splashView } = require('../splash.js');

// A stand-in for electron-updater's autoUpdater: `latest` is what the feed says, `cached` the
// version already downloaded. Downloads finish when the test says (`finishDownload`).
function fakeAutoUpdater() {
    const updater = new EventEmitter();
    updater.latest = null;
    updater.cached = null;
    updater.downloads = 0;
    updater.isUpdaterActive = () => true;
    updater.quitAndInstall = vi.fn();
    updater.finishDownload = () => {
        updater.cached = updater.downloading;
        updater.emit('update-downloaded', { version: updater.downloading });
    };
    updater.checkForUpdates = vi.fn(async () => {
        updater.emit('checking-for-update');
        if (!updater.latest) {
            updater.emit('update-not-available', {});
            return { isUpdateAvailable: false };
        }
        updater.emit('update-available', { version: updater.latest });
        updater.downloading = updater.latest;
        if (updater.cached === updater.latest) {
            updater.emit('update-downloaded', { version: updater.latest });
        } else {
            updater.downloads += 1;
        }
        return { isUpdateAvailable: true };
    });
    return updater;
}

describe('desktop updates (updater.js)', () => {
    let autoUpdater;
    let onReady;
    let updater;
    beforeEach(() => {
        vi.useFakeTimers();
        autoUpdater = fakeAutoUpdater();
        onReady = vi.fn();
        updater = createUpdater({ app: { isPackaged: true }, onReady, autoUpdater });
    });
    afterEach(() => vi.useRealTimers());

    it('is unsupported in a development run', async () => {
        const dev = createUpdater({ app: { isPackaged: false }, onReady, autoUpdater });
        expect(await dev.check()).toBe('unsupported');
        expect(await dev.install()).toBe(false);
    });

    it('keeps looking once an update is ready, and offers a newer one', async () => {
        autoUpdater.latest = '1.1.0';
        expect(await updater.check()).toBe('downloading');
        autoUpdater.finishDownload();
        expect(onReady).toHaveBeenLastCalledWith('1.1.0');
        expect(await updater.check()).toBe('available');
        expect(onReady).toHaveBeenCalledTimes(1); // the same one again isn't news

        autoUpdater.latest = '1.2.0';
        updater.start();
        await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
        autoUpdater.finishDownload();
        expect(onReady).toHaveBeenLastCalledWith('1.2.0');
    });

    it('looks once more on "Update now" and restarts onto the newest version', async () => {
        autoUpdater.latest = '1.1.0';
        await updater.check();
        autoUpdater.finishDownload();

        autoUpdater.latest = '1.2.0'; // released since
        const beforeQuit = vi.fn();
        const installing = updater.install(beforeQuit);
        await vi.advanceTimersByTimeAsync(0);
        expect(autoUpdater.downloads).toBe(2);
        expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled(); // waits for it

        autoUpdater.finishDownload();
        expect(await installing).toBe(true);
        expect(beforeQuit).toHaveBeenCalled();
        expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
        expect(autoUpdater.cached).toBe('1.2.0');
    });

    it('installs what it has when nothing newer is out', async () => {
        autoUpdater.latest = '1.1.0';
        await updater.check();
        autoUpdater.finishDownload();
        expect(await updater.install()).toBe(true);
        expect(autoUpdater.downloads).toBe(1);
        expect(autoUpdater.quitAndInstall).toHaveBeenCalled();
    });

    it("doesn't wait long for a last look that hangs", async () => {
        autoUpdater.latest = '1.1.0';
        await updater.check();
        autoUpdater.finishDownload();
        autoUpdater.checkForUpdates.mockImplementation(() => new Promise(() => {}));
        const installing = updater.install();
        await vi.advanceTimersByTimeAsync(5000);
        expect(await installing).toBe(true);
    });

    it('reports a failed download instead of quitting', async () => {
        autoUpdater.latest = '1.1.0';
        await updater.check();
        const installing = updater.install();
        await vi.advanceTimersByTimeAsync(0);
        autoUpdater.emit('error', new Error('offline'));
        expect(await installing).toBe(false);
        expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    });

    describe('at launch (the splash)', () => {
        it('opens the app when there is nothing new', async () => {
            const onStatus = vi.fn();
            const launch = updater.launch({ onStatus });
            expect(await launch.result).toBe('start');
            expect(onStatus).toHaveBeenCalledWith({ state: 'checking' });
            expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
        });

        it('opens the app at once in a development run', async () => {
            const dev = createUpdater({ app: { isPackaged: false }, onReady, autoUpdater });
            expect(await dev.launch().result).toBe('start');
            expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
        });

        it('downloads an update and restarts onto it before opening', async () => {
            autoUpdater.latest = '1.1.0';
            const onStatus = vi.fn();
            const beforeQuit = vi.fn();
            const launch = updater.launch({ onStatus, beforeQuit });
            await vi.advanceTimersByTimeAsync(0);
            expect(onStatus).toHaveBeenLastCalledWith({ state: 'downloading', version: '1.1.0' });
            expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();

            autoUpdater.finishDownload();
            expect(await launch.result).toBe('installing');
            expect(onStatus).toHaveBeenLastCalledWith({ state: 'installing', version: '1.1.0' });
            expect(beforeQuit).toHaveBeenCalled();
            expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
        });

        it("opens the app when the look doesn't answer in time", async () => {
            autoUpdater.checkForUpdates.mockImplementation(() => new Promise(() => {}));
            const launch = updater.launch();
            await vi.advanceTimersByTimeAsync(5000);
            expect(await launch.result).toBe('start');
        });

        it('opens the app when the download fails', async () => {
            autoUpdater.latest = '1.1.0';
            const launch = updater.launch();
            await vi.advanceTimersByTimeAsync(0);
            autoUpdater.emit('error', new Error('offline'));
            expect(await launch.result).toBe('start');
            expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
        });

        it('"Start anyway" opens the app, and the page is offered the update later', async () => {
            autoUpdater.latest = '1.1.0';
            const launch = updater.launch();
            await vi.advanceTimersByTimeAsync(0);
            launch.startAnyway();
            expect(await launch.result).toBe('start');

            autoUpdater.finishDownload();
            await vi.advanceTimersByTimeAsync(0);
            expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
            expect(onReady).toHaveBeenCalledWith('1.1.0');
            expect(updater.readyVersion()).toBe('1.1.0');
        });
    });
});

describe('the splash window (splash.js)', () => {
    it('says what the launch is doing', () => {
        expect(splashView({ state: 'checking' })).toEqual({ ring: 'spin', text: 'Checking for updates' });
        expect(splashView({ state: 'downloading', version: '1.2.0' }))
            .toEqual({ ring: 'progress', text: 'Downloading update', detail: 'Version 1.2.0' });
        expect(splashView({ state: 'installing', version: '1.2.0' }).text).toBe('Installing update');
        expect(splashView(null)).toEqual({ ring: 'spin', text: 'Starting' });
    });
});
