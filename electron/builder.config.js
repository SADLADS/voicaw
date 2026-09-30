// electron-builder: packages the desktop app (`npm run dist:electron` from the repo root) into
// installers in dist-desktop/. The client, built for the desktop app into ../build, goes in
// as a resource (`app/`), served by protocol.js.
//
// Updates (updater.js) come from UPDATE_URL: after building, upload the installers and the
// latest*.yml files next to them there. VOICAW_UPDATE_URL overrides it at build time.
const UPDATE_URL = process.env.VOICAW_UPDATE_URL || 'https://voicaw.com/desktop/';

module.exports = {
    appId: 'com.voicaw.app',
    productName: 'Voicaw',
    directories: { output: '../dist-desktop' },
    files: ['*.js', 'assets/**', '!builder.config.js', '!vitest.config.js', '!test/**'],
    extraResources: [{ from: '../build', to: 'app' }],
    icon: '../client/public/logo512.png',
    publish: [{ provider: 'generic', url: UPDATE_URL }],
    linux: {
        target: ['AppImage', 'deb'],
        category: 'Network;InstantMessaging',
        executableName: 'voicaw',
    },
    deb: { depends: ['libnotify4', 'libxtst6', 'libnss3'] },
    win: { target: ['nsis'] },
    nsis: { oneClick: true, perMachine: false },
    // Auto-update on macOS needs the zip, and a signed app.
    mac: { target: ['dmg', 'zip'], category: 'public.app-category.social-networking' },
};
