// Files the app saved, for the page's download popup (client components/DownloadsPopup.jsx), as
// a browser shows one: Open, Show in folder, Delete. Both ways of saving end here: `<a
// download>` (Electron's own download, after its Save dialog: main.js `will-download`) and big
// attachments written a piece at a time (fileSave.js). The page only ever hears an id and the
// file's name; the path stays here, so the page can't open or delete anything else.
const path = require('path');

// How many saved files are remembered (the oldest forgotten first).
const KEEP = 50;

// Files the system would run rather than open: Open shows them in their folder instead, so a
// script in the page (the page can call open itself) never starts a program, even one it got
// the person to save (security audit, 2026-11-18). Running one stays the person's own double-click.
const PROGRAM = /\.(exe|msi|msix|msp|appx|appxbundle|bat|cmd|com|scr|pif|cpl|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|jar|lnk|url|reg|inf|application|appref-ms|gadget|sh|bash|zsh|csh|command|tool|run|bin|appimage|desktop|deb|rpm|snap|flatpak|flatpakref|app|pkg|mpkg|dmg|workflow|scpt|py|pyw|pl|rb|php)$/i;

// `shell` is Electron's; `fs` node:fs; `send(download)` tells the page of a new one.
function createDownloads({ shell, fs, send }) {
    const saved = new Map(); // id -> filePath
    let nextId = 1;

    function pathOf(id) {
        const filePath = saved.get(id);
        if (!filePath) throw new Error('No such download');
        return filePath;
    }

    return {
        // A file finished saving at `filePath`.
        add(filePath) {
            const id = nextId++;
            saved.set(id, filePath);
            if (saved.size > KEEP) saved.delete(saved.keys().next().value);
            send({ id, name: path.basename(filePath), folder: path.basename(path.dirname(filePath)) });
            return id;
        },
        // Resolves to '' once opened in the app for its type (a program: shown in its folder),
        // else why not (shell.openPath's).
        async open(id) {
            const filePath = pathOf(id);
            if (!fs.existsSync(filePath)) return 'missing';
            if (PROGRAM.test(filePath)) {
                shell.showItemInFolder(filePath);
                return '';
            }
            return shell.openPath(filePath);
        },
        showInFolder(id) {
            shell.showItemInFolder(pathOf(id));
        },
        // To the bin where there is one, else gone for good.
        async remove(id) {
            const filePath = pathOf(id);
            saved.delete(id);
            try {
                await shell.trashItem(filePath);
            } catch {
                await fs.promises.rm(filePath, { force: true });
            }
        },
    };
}

module.exports = { createDownloads };
