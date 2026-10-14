// Updates for the installed app (electron-updater, from the feed in builder.config.js): looks
// for one at start and every few hours, downloads it in the background, then the page offers
// "Update now" (its UpdateBanner / Settings), which restarts onto it. The client ships inside
// the app, so this is also how the app gets new versions of the page.
//
// It keeps looking after one is ready, so a newer release replaces it, and "Update now" looks
// once more (briefly) first: the app restarts onto the latest version, not the first one it
// noticed. electron-updater keeps only one download, so while a newer one downloads there's
// nothing to install yet: "Update now" waits for it (the page shows its progress).
//
// At launch (`launch`, the splash window), it looks first and, if there's an update, downloads
// it and restarts onto it before the app opens, as Discord does.
//
// A development run, or a package it can't update in place, reports 'unsupported'.
//
// In the Steam Deck's Gaming Mode (`gamingMode`, gamingMode.js) a restart would leave Steam
// thinking the game had closed, so the page isn't told about updates there: one that's ready
// installs when the app is quit (and "Update now" in Settings quits without restarting).
// AppImages keep their file name across updates (appImageInstall.js).
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
// How long "Update now" waits for its last look before installing what it has.
const LAST_LOOK_MS = 5000;
// How long the launch waits for its look (offline or a slow server: open the app anyway).
const LAUNCH_LOOK_MS = 5000;

const { keepAppImageName } = require('./appImageInstall');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `autoUpdater` is for tests (electron-updater's otherwise).
function createUpdater({ app, onReady, onProgress = () => {}, autoUpdater, gamingMode = false }) {
    let updater = null;
    let state = 'idle'; // 'idle' | 'checking' | 'downloading' | 'current' | 'error'
    let readyVersion = null; // downloaded and installable
    let announced = null; // the version the page was last told about
    let download = null; // settles when the running download ends
    let endDownload = () => {};
    let installing = false;
    let onLaunchStatus = null; // the splash's, while the launch runs

    if (app.isPackaged) {
        try {
            updater = autoUpdater ?? require('electron-updater').autoUpdater;
            keepAppImageName(updater);
            updater.autoDownload = true;
            updater.autoInstallOnAppQuit = true;
            updater.on('checking-for-update', () => { state = 'checking'; });
            updater.on('update-available', (info) => {
                state = 'downloading';
                // The one already downloaded comes straight back from the cache; another
                // replaces it (electron-updater empties its cache first).
                if (info.version !== readyVersion) readyVersion = null;
                if (!download) download = new Promise((resolve) => { endDownload = resolve; });
                onLaunchStatus?.({ state: 'downloading', version: info.version });
            });
            updater.on('update-not-available', () => { state = 'current'; });
            updater.on('download-progress', (progress) => onProgress(progress.percent / 100));
            updater.on('update-downloaded', (info) => {
                state = 'idle';
                readyVersion = info.version;
                finishDownload();
                if (announced !== info.version && !gamingMode) {
                    announced = info.version;
                    onReady(info.version);
                }
            });
            updater.on('error', (err) => {
                state = 'error';
                finishDownload();
                console.error('Update failed:', err?.message);
            });
            if (!updater.isUpdaterActive()) updater = null;
        } catch (err) {
            console.error('Updates are unavailable:', err.message);
            updater = null;
        }
    }

    function finishDownload() {
        download = null;
        endDownload();
    }

    async function look() {
        try {
            await updater.checkForUpdates();
        } catch {
            // reported by the 'error' event
        }
    }

    async function check() {
        if (!updater) return 'unsupported';
        if (state !== 'downloading') await look();
        if (readyVersion) return 'available';
        return { downloading: 'downloading', error: 'error' }[state] ?? 'current';
    }

    // `lookNow` false: the launch has just looked.
    function start({ lookNow = true } = {}) {
        if (!updater) return;
        if (lookNow) check();
        setInterval(() => { if (!installing) check(); }, CHECK_EVERY_MS);
    }

    // Restarts onto the latest version: looks once more, waits for any download that starts,
    // then installs (`beforeQuit` runs just before the app quits). Resolves to false if there's
    // nothing to install (the download failed).
    async function install(beforeQuit = () => {}) {
        if (!updater || installing) return false;
        installing = true;
        try {
            if (state !== 'downloading') {
                await Promise.race([look(), new Promise((resolve) => setTimeout(resolve, LAST_LOOK_MS))]);
            }
            while (download) await download;
            if (!readyVersion) return false;
            beforeQuit();
            if (gamingMode) updater.quitAndInstall(true, false);
            else updater.quitAndInstall();
            return true;
        } finally {
            installing = false;
        }
    }

    // The launch: looks (for up to LAUNCH_LOOK_MS) and downloads any update, telling `onStatus`
    // ({ state: 'checking' | 'downloading' | 'installing', version }; progress goes to
    // onProgress), then restarts onto it. `result` resolves to 'installing', or to 'start' to
    // open the app: nothing new, no answer in time, a failed download, or `startAnyway()`
    // (the download carries on and the page offers it once it's ready).
    function launch({ onStatus = () => {}, beforeQuit = () => {} } = {}) {
        let startAnyway = () => {};
        const skipped = new Promise((resolve) => { startAnyway = () => resolve('start'); });
        async function run() {
            if (!updater) return 'start';
            onStatus({ state: 'checking' });
            await Promise.race([look(), wait(LAUNCH_LOOK_MS)]);
            while (download) await download;
            return readyVersion ? 'install' : 'start';
        }
        onLaunchStatus = onStatus;
        const result = Promise.race([run(), skipped]).then((outcome) => {
            onLaunchStatus = null;
            if (outcome !== 'install' || installing) return 'start';
            installing = true;
            onStatus({ state: 'installing', version: readyVersion });
            beforeQuit();
            updater.quitAndInstall();
            return 'installing';
        });
        return { result, startAnyway: () => startAnyway() };
    }

    return { check, install, start, launch, readyVersion: () => readyVersion };
}

module.exports = { createUpdater };
