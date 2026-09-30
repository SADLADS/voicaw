// Updates for the installed app (electron-updater, from the feed in builder.config.js): looks
// for one at start and every few hours, downloads it in the background, then the page offers
// "Update now" (its UpdateBanner / Settings), which restarts onto it. The client ships inside
// the app, so this is also how the app gets new versions of the page.
//
// A development run, or a package it can't update in place, reports 'unsupported'.
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

function createUpdater({ app, onReady }) {
    let updater = null;
    let state = 'idle'; // 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'error'

    if (app.isPackaged) {
        try {
            ({ autoUpdater: updater } = require('electron-updater'));
            updater.autoDownload = true;
            updater.autoInstallOnAppQuit = true;
            updater.on('checking-for-update', () => { state = 'checking'; });
            updater.on('update-available', () => { state = 'downloading'; });
            updater.on('update-not-available', () => { state = 'current'; });
            updater.on('update-downloaded', (info) => {
                state = 'ready';
                onReady(info.version);
            });
            updater.on('error', (err) => {
                state = 'error';
                console.error('Update failed:', err?.message);
            });
            if (!updater.isUpdaterActive()) updater = null;
        } catch (err) {
            console.error('Updates are unavailable:', err.message);
            updater = null;
        }
    }

    async function check() {
        if (!updater) return 'unsupported';
        if (state === 'ready') return 'available';
        if (state === 'downloading') return 'downloading';
        try {
            const result = await updater.checkForUpdates();
            if (state === 'ready') return 'available';
            return result?.isUpdateAvailable ? 'downloading' : 'current';
        } catch {
            return 'error';
        }
    }

    function start() {
        if (!updater) return;
        check();
        setInterval(check, CHECK_EVERY_MS);
    }

    function install() {
        if (updater && state === 'ready') updater.quitAndInstall();
    }

    return { check, install, start, isReady: () => state === 'ready' };
}

module.exports = { createUpdater };
