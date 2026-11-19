// The saved login (the page's login token), kept by the desktop app in its own file rather
// than only in the page's localStorage. On one Windows PC (2026-11-16 to 19) Chromium's storage
// kept giving the page a month-old, expired token after every login: deleting `Local Storage`
// didn't help, and the page's in-memory guard (client/src/utils/loginToken.js) was lost on
// every reload. Node writes this file itself, so whatever Chromium does, the page reads back
// the login it last saved. Plain JSON, as localStorage keeps it, in the same data folder.
//
// `{ v: 1, token }`: token null means logged out. No file means the app never saved one here
// (an older version did, in localStorage): the page then falls back to localStorage.
const fs = require('fs');
const path = require('path');

const TOKEN = /^[A-Za-z0-9_\-.]{1,4096}$/;

function createLoginStore(dir) {
    const file = path.join(dir, 'login.json');
    let kept;

    function read() {
        try {
            const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (saved?.v !== 1) return { known: false, token: null };
            return { known: true, token: typeof saved.token === 'string' && TOKEN.test(saved.token) ? saved.token : null };
        } catch {
            return { known: false, token: null };
        }
    }

    // A whole file or none: written beside it, then moved over it.
    function write(text) {
        fs.mkdirSync(dir, { recursive: true });
        const temp = `${file}.tmp`;
        const fd = fs.openSync(temp, 'w');
        try {
            fs.writeSync(fd, text);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        try {
            fs.renameSync(temp, file);
        } catch {
            // Windows can refuse the move while something (a virus scanner) has the file open.
            fs.writeFileSync(file, text);
            fs.rmSync(temp, { force: true });
        }
    }

    return {
        // { known, token }: known false when no login was ever saved here.
        get() {
            kept ??= read();
            return { ...kept };
        },
        // A token, or null for logged out. False for anything that isn't a token.
        set(token) {
            if (token !== null && !(typeof token === 'string' && TOKEN.test(token))) return false;
            kept = { known: true, token };
            try {
                write(JSON.stringify({ v: 1, token }));
            } catch (err) {
                console.error('Could not save the login', err.message);
            }
            return true;
        },
    };
}

module.exports = { createLoginStore };
