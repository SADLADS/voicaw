// Start at login (Settings → Desktop App). The app then starts in the tray (`--hidden`).
// Windows and macOS have it built in; on Linux it's a .desktop file in ~/.config/autostart.
const fs = require('fs');
const path = require('path');
const os = require('os');

const HIDDEN_ARG = '--hidden';

function linuxAutostartFile(home = os.homedir()) {
    return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart', 'voicaw.desktop');
}

// What to run: the AppImage itself when it is one (its mounted path changes every start).
function linuxAutostartEntry(execPath) {
    const quoted = /[\s"'\\]/.test(execPath) ? `"${execPath.replace(/(["\\`$])/g, '\\$1')}"` : execPath;
    return [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Voicaw',
        `Exec=${quoted} ${HIDDEN_ARG}`,
        'X-GNOME-Autostart-enabled=true',
        'Terminal=false',
        '',
    ].join('\n');
}

function setStartAtLogin(app, enabled) {
    if (!app.isPackaged) return; // a development run would register the bare Electron binary
    if (process.platform === 'linux') {
        const file = linuxAutostartFile();
        try {
            if (enabled) {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, linuxAutostartEntry(process.env.APPIMAGE || process.execPath));
            } else if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        } catch (err) {
            console.error('Could not change start at login', err.message);
        }
        return;
    }
    app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_ARG] });
}

// Started at login: stay in the tray. (macOS reports it rather than passing the argument.)
function startedHidden(app, argv = process.argv) {
    return argv.includes(HIDDEN_ARG) || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
}

module.exports = { setStartAtLogin, startedHidden, linuxAutostartEntry, linuxAutostartFile, HIDDEN_ARG };
