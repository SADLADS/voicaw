// Installing an AppImage update over the running AppImage, under the same name.
// electron-updater's own install moves the download in under the new version's name
// (Voicaw-1.0.1.AppImage) and deletes the old file, so anything pointing at the old name (a
// Steam shortcut for the Steam Deck's Gaming Mode, a menu entry, a script) stops launching
// anything after the first update. This replaces its `doInstall` on the AppImage updater
// with the same steps, writing over the file the app was started from.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

function keepAppImageName(updater, { env = process.env, fsApi = fs, run = execFileSync } = {}) {
    if (updater?.constructor?.name !== 'AppImageUpdater') return false;
    updater.doInstall = function doInstall(options) {
        const appImageFile = env.APPIMAGE;
        if (!appImageFile || !path.isAbsolute(appImageFile) || appImageFile.includes('\0')) {
            throw new Error(`Not an AppImage to update: "${appImageFile}"`);
        }
        const installerPath = this.installerPath;
        if (installerPath == null) {
            this.dispatchError(new Error("No update filepath provided, can't quit and install"));
            return false;
        }
        // Unlinked first (the running file is busy), then the download takes its name.
        fsApi.unlinkSync(appImageFile);
        run('mv', ['-f', installerPath, appImageFile]);
        const childEnv = { ...env, APPIMAGE_SILENT_INSTALL: 'true' };
        if (options.isForceRunAfter) {
            this.spawnLog(appImageFile, [], childEnv).catch((err) => console.error('Could not start the update:', err.message));
        } else {
            run(appImageFile, [], { env: { ...childEnv, APPIMAGE_EXIT_AFTER_INSTALL: 'true' } });
        }
        return true;
    };
    return true;
}

module.exports = { keepAppImageName };
