// Saving a file the page decrypts as it downloads (client/src/services/attachmentSave.js): a
// big attachment is never whole in the page, so it can't be a blob: link to <a download>. The
// page asks where to save it (the system's Save dialog, in Downloads), then sends it a piece
// at a time, written as it comes; cancelling (or a failure) deletes what was written.
const path = require('path');

// A name the file system takes: no folders, no characters Windows refuses.
function safeFileName(name) {
    const base = path.basename(String(name ?? '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
    return base && base !== '.' && base !== '..' ? base.slice(0, 200) : 'download';
}

// `showSaveDialog(options)` resolves { canceled, filePath } (Electron's dialog, for the window);
// `fs` is node:fs.
function createFileSaver({ showSaveDialog, fs, downloadsDir }) {
    const open = new Map(); // id -> { stream, filePath }
    let nextId = 1;

    function close(id) {
        const file = open.get(id);
        open.delete(id);
        return file;
    }

    return {
        // Resolves to an id, or null if the person cancelled.
        async start(name) {
            const { canceled, filePath } = await showSaveDialog({ defaultPath: path.join(downloadsDir(), safeFileName(name)) });
            if (canceled || !filePath) return null;
            const stream = fs.createWriteStream(filePath);
            await new Promise((resolve, reject) => {
                stream.once('open', resolve);
                stream.once('error', reject);
            });
            const id = nextId++;
            open.set(id, { stream, filePath });
            stream.on('error', () => {});
            return id;
        },
        // Resolves once `bytes` (a Uint8Array) is written, so the page waits for slow disks.
        async append(id, bytes) {
            const file = open.get(id);
            if (!file) throw new Error('No such file');
            await new Promise((resolve, reject) => {
                file.stream.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), (err) => (err ? reject(err) : resolve()));
            });
        },
        async finish(id) {
            const file = close(id);
            if (!file) throw new Error('No such file');
            await new Promise((resolve, reject) => file.stream.end((err) => (err ? reject(err) : resolve())));
            return file.filePath;
        },
        async cancel(id) {
            const file = close(id);
            if (!file) return;
            await new Promise((resolve) => {
                if (file.stream.closed) return resolve();
                file.stream.once('close', resolve);
                file.stream.destroy();
            });
            await fs.promises.rm(file.filePath, { force: true });
        },
    };
}

module.exports = { createFileSaver, safeFileName };
