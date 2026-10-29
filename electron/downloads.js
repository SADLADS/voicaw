// Files the app saved, for the page's download popup (client components/DownloadsPopup.jsx), as
// a browser shows one: Open, Show in folder, Delete. Both ways of saving end here: `<a
// download>` (Electron's own download, after its Save dialog: main.js `will-download`) and big
// attachments written a piece at a time (fileSave.js). The page only ever hears an id and the
// file's name; the path stays here, so the page can't open or delete anything else.
const path = require('path');

// How many saved files are remembered (the oldest forgotten first).
const KEEP = 50;

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
        // Resolves to '' once opened in the app for its type, else why not (shell.openPath's).
        async open(id) {
            const filePath = pathOf(id);
            if (!fs.existsSync(filePath)) return 'missing';
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
