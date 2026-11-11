// electron-builder: packages the desktop app (`npm run dist:electron` from the repo root) into
// installers in dist-desktop/. The client, built for the desktop app into ../build, goes in
// as a resource (`app/`), served by protocol.js.
//
// Updates (updater.js) come from UPDATE_URL: after building, upload the installers and the
// latest*.yml files next to them there. VOICAW_UPDATE_URL overrides it at build time.
const UPDATE_URL = process.env.VOICAW_UPDATE_URL || 'https://updates.voicaw.com/desktop/';
// VOICAW_AUTO_UPDATE=off: the build starts with automatic updates off (desktopSettings.js), for
// people who build the app themselves and don't want it replaced by the published one.
const AUTO_UPDATE = !/^(off|false|0|no)$/i.test(process.env.VOICAW_AUTO_UPDATE ?? '');
// VOICAW_VERSION=X.Y.Z: the release's version, stamped into the build (GitHub's release
// workflow, .github/workflows/desktop-release.yml), so electron/package.json never changes.
const VERSION = process.env.VOICAW_VERSION;
if (VERSION && !/^\d+\.\d+\.\d+$/.test(VERSION)) throw new Error(`VOICAW_VERSION must be X.Y.Z, not ${VERSION}`);
// npm workspaces install electron in the repo root's node_modules, where electron-builder doesn't
// look, and package.json only gives a range: so tell it the installed version.
const { version: electronVersion } = require('electron/package.json');
const path = require('path');
const fs = require('fs');

// Game capture (gameCapture.js) ships on Windows: our helper and OBS's files, made by
// game-capture/prepare.mjs and the helper's build (README "Desktop app"). A Windows build
// without them would quietly lack it, so it fails instead.
const GAME_CAPTURE_DIR = path.join(__dirname, 'game-capture', 'dist');
const GAME_CAPTURE_FILES = [
    'voicaw-capture.exe', 'graphics-hook64.dll', 'graphics-hook32.dll', 'inject-helper64.exe', 'inject-helper32.exe',
    'get-graphics-offsets64.exe', 'get-graphics-offsets32.exe', 'LICENSE-OBS.txt', 'SOURCE-OBS.txt',
];

module.exports = {
    appId: 'com.voicaw.app',
    productName: 'Voicaw',
    electronVersion,
    extraMetadata: { voicawAutoUpdate: AUTO_UPDATE, ...(VERSION && { version: VERSION }) },
    directories: { output: '../dist-desktop' },
    files: [
        '*.js', 'assets/**', '!builder.config.js', '!vitest.config.js', '!test/**',
        // The push to talk hook (pushToTalk.js) ships ready-built for every system (N-API
        // prebuilds, picked when it loads), so its C sources stay out...
        '!**/node_modules/uiohook-napi/{libuiohook,src,binding.gyp}',
    ],
    // ...and nothing is rebuilt for Electron: it's the only native module, and compiling it
    // would need a compiler and X11 headers (and can't be done for Windows from Linux).
    npmRebuild: false,
    extraResources: [{ from: '../build', to: 'app' }],
    icon: '../client/public/logo512.png',
    publish: [{ provider: 'generic', url: UPDATE_URL }],
    linux: {
        target: ['AppImage', 'deb'],
        category: 'Network;InstantMessaging',
        executableName: 'voicaw',
        // Debian packages must name a maintainer (an address).
        maintainer: 'Voicaw <noreply@voicaw.com>',
    },
    deb: { depends: ['libnotify4', 'libxtst6', 'libnss3'] },
    win: {
        target: ['nsis'],
        extraResources: [{ from: 'game-capture/dist', to: 'game-capture', filter: GAME_CAPTURE_FILES }],
    },
    beforePack: async (context) => {
        if (context.electronPlatformName !== 'win32') return;
        const missing = GAME_CAPTURE_FILES.filter((file) => !fs.existsSync(path.join(GAME_CAPTURE_DIR, file)));
        if (missing.length) throw new Error(`Game capture files missing from ${GAME_CAPTURE_DIR}: ${missing.join(', ')} (README "Desktop app")`);
    },
    // installer/installer.nsh: the installer looks like the app's splash window.
    nsis: { oneClick: true, perMachine: false, include: path.join(__dirname, 'installer', 'installer.nsh') },
    // Auto-update on macOS needs the zip, and a signed app.
    mac: { target: ['dmg', 'zip'], category: 'public.app-category.social-networking' },
};
