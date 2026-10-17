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
// npm workspaces install electron in the repo root's node_modules, where electron-builder doesn't
// look, and package.json only gives a range: so tell it the installed version.
const { version: electronVersion } = require('electron/package.json');
const path = require('path');

module.exports = {
    appId: 'com.voicaw.app',
    productName: 'Voicaw',
    electronVersion,
    extraMetadata: { voicawAutoUpdate: AUTO_UPDATE },
    directories: { output: '../dist-desktop' },
    files: ['*.js', 'assets/**', '!builder.config.js', '!vitest.config.js', '!test/**'],
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
    win: { target: ['nsis'] },
    // installer/installer.nsh: the installer looks like the app's splash window.
    nsis: { oneClick: true, perMachine: false, include: path.join(__dirname, 'installer', 'installer.nsh') },
    // Auto-update on macOS needs the zip, and a signed app.
    mac: { target: ['dmg', 'zip'], category: 'public.app-category.social-networking' },
};
