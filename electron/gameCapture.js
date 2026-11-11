// Game capture on Windows (see Game capture in docs/desktop-and-site.md): a game in exclusive full
// screen never reaches the desktop, so Windows' own capture (getDisplayMedia, screenShare.js)
// shows its viewers a frozen picture. Like Discord's and OBS's game capture, OBS's graphics hook
// (game-capture/, shipped unmodified) is loaded into the game and copies each frame it presents;
// our helper, voicaw-capture.exe (game-capture/helper/), copies them into a few shared textures
// and says which one holds the newest frame. Here each frame is imported (Electron's
// sharedTexture: GPU to GPU, never through memory) and sent to the page (preload.js), which
// sends it as the screen share's video (client voice/gameCapture.js).
//
// listGames(): the windows of the games this computer is running (Rich Presence's and Steam's,
// `gamePids`), via the helper, for the picker's Games tab. start(hwnd, fps) only for a window
// just listed, resolving to { id, width, height } once frames come (or rejecting with
// { code, message }); then the page hears { id, state: 'live' | 'error' | 'stopped', ... }
// through `send` (`id` tells captures apart: starting one stops the last). One at a time.

const path = require('path');
const readline = require('readline');

const HELPER = 'voicaw-capture.exe';
// What the helper needs beside it (OBS 33's files, fetched by game-capture/prepare.mjs).
const HOOK_FILES = [
    'graphics-hook64.dll', 'graphics-hook32.dll', 'inject-helper64.exe', 'inject-helper32.exe',
    'get-graphics-offsets64.exe', 'get-graphics-offsets32.exe',
];
const START_TIMEOUT_MS = 60 * 1000; // past the helper's own (inject, load, first frame)
const LIST_TIMEOUT_MS = 5000;
const PIXEL_FORMATS = new Set(['bgra', 'rgba', 'rgbaf16']);

// A helper's handle value (a decimal string) as Electron's ntHandle: 8 bytes, little-endian.
function handleBuffer(value) {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt(value));
    return buffer;
}

// `spawn` and `execFile` are child_process's; `getFrame()` is the app window's main frame (or
// null); `log` gets the helper's log lines (no secrets in them: window titles at most).
function createGameCapture({ platform, dir, fs, spawn, execFile, sharedTexture, parentPid, gamePids, getFrame, send, log = () => {} }) {
    const helperPath = path.join(dir, HELPER);
    let listed = new Map(); // hwnd → window, from the last listing
    let session = null;
    let nextId = 1;

    function available() {
        if (platform !== 'win32' || !sharedTexture?.importSharedTexture) return false;
        return [HELPER, ...HOOK_FILES].every((file) => fs.existsSync(path.join(dir, file)));
    }

    // [{ hwnd, pid, title, width, height }]: the games' visible windows.
    async function listGames() {
        if (!available()) return [];
        const pids = [...new Set((await gamePids()).filter((pid) => Number.isInteger(pid) && pid > 0))];
        if (pids.length === 0) {
            listed = new Map();
            return [];
        }
        const output = await new Promise((resolve, reject) => {
            execFile(helperPath, ['--list', pids.join(',')], { timeout: LIST_TIMEOUT_MS, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
        });
        const windows = (JSON.parse(output).windows ?? []).filter((w) => /^\d+$/.test(w.hwnd));
        listed = new Map(windows.map((w) => [w.hwnd, w]));
        return windows;
    }

    function stop() {
        const current = session;
        if (!current) return;
        session = null;
        current.write('stop');
        current.child.stdin.end();
        // The helper stops the hook and closes its handles; if it hangs, it goes anyway.
        current.killTimer = setTimeout(() => current.child.kill(), 3000);
    }

    function setFrameRate(fps) {
        if (session && Number.isInteger(fps) && fps > 0 && fps <= 240) session.write(`fps ${fps}`);
    }

    function start(hwnd, fps) {
        if (!available()) return Promise.reject({ code: 'unavailable', message: 'Game capture isn\'t available here.' });
        if (typeof hwnd !== 'string' || !listed.has(hwnd)) return Promise.reject({ code: 'not_listed', message: 'That game isn\'t one listed.' });
        if (!Number.isInteger(fps) || fps <= 0 || fps > 240) fps = 60;
        stop();
        return new Promise((resolve, reject) => {
            const child = spawn(helperPath, ['--hwnd', hwnd, '--parent', String(parentPid), '--dir', dir, '--fps', String(fps)], {
                windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
            });
            const current = {
                id: nextId++,
                child,
                sets: new Map(), // gen → { width, height, format, handles }
                started: false,
                ended: false,
                write(line) {
                    if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(`${line}\n`);
                },
            };
            session = current;
            const timer = setTimeout(() => finish({ code: 'timeout', message: 'The game sent no frames.' }), START_TIMEOUT_MS);

            // Ends this capture once: rejects start() if it hadn't, or tells the page.
            function finish(error, reason = 'stopped') {
                if (current.ended) return;
                current.ended = true;
                clearTimeout(timer);
                if (session === current) {
                    session = null;
                    current.write('stop');
                    child.stdin.end();
                }
                if (!current.started) {
                    reject(error ?? { code: 'stopped', message: 'The capture stopped.' });
                    return;
                }
                send(error
                    ? { id: current.id, state: 'error', code: error.code, message: error.message }
                    : { id: current.id, state: 'stopped', reason });
            }

            function deliver(gen, slot, timestamp) {
                const set = current.sets.get(gen);
                const handle = set?.handles[slot];
                if (!set || !handle || session !== current) {
                    current.write(`free ${gen} ${slot}`);
                    return;
                }
                let freed = false;
                const free = () => {
                    if (freed) return;
                    freed = true;
                    current.write(`free ${gen} ${slot}`);
                };
                let imported;
                try {
                    imported = sharedTexture.importSharedTexture({
                        textureInfo: {
                            pixelFormat: set.format,
                            codedSize: { width: set.width, height: set.height },
                            visibleRect: { x: 0, y: 0, width: set.width, height: set.height },
                            timestamp,
                            handle: { ntHandle: handle },
                        },
                        allReferencesReleased: free,
                    });
                } catch (err) {
                    // Most likely the game draws on another graphics card than Voicaw's.
                    free();
                    finish({ code: 'import_failed', message: err.message });
                    return;
                }
                const frame = getFrame();
                if (!frame) {
                    imported.release();
                    return;
                }
                sharedTexture.sendSharedTexture({ frame, importedSharedTexture: imported }, { gen, slot })
                    .catch(() => {})
                    .finally(() => imported.release());
            }

            function onLine(line) {
                let event;
                try {
                    event = JSON.parse(line);
                } catch {
                    return;
                }
                if (event.event === 'log') {
                    log(String(event.message ?? ''));
                } else if (event.event === 'ready') {
                    const { gen, width, height, format, handles } = event;
                    if (!Number.isInteger(gen) || !PIXEL_FORMATS.has(format) || !Array.isArray(handles) || !(width > 0 && height > 0)) {
                        finish({ code: 'bad_helper', message: 'The capture helper said something unexpected.' });
                        return;
                    }
                    current.sets.set(gen, { width, height, format, handles: handles.map(handleBuffer) });
                    // Frames already imported keep their own copies: the older set can go.
                    for (const old of current.sets.keys()) {
                        if (old < gen) {
                            current.sets.delete(old);
                            current.write(`retire ${old}`);
                        }
                    }
                    if (!current.started) {
                        current.started = true;
                        clearTimeout(timer);
                        resolve({ id: current.id, width, height });
                    }
                    send({ id: current.id, state: 'live', width, height });
                } else if (event.event === 'frame') {
                    if (Number.isInteger(event.gen) && Number.isInteger(event.slot)) deliver(event.gen, event.slot, Number(event.timestamp) || 0);
                } else if (event.event === 'error') {
                    finish({ code: String(event.code ?? 'failed'), message: String(event.message ?? '') });
                } else if (event.event === 'stopped') {
                    finish(null, String(event.reason ?? 'stopped'));
                }
            }

            readline.createInterface({ input: child.stdout }).on('line', onLine);
            child.stderr?.on('data', () => {});
            child.on('error', (err) => finish({ code: 'helper_failed', message: err.message }));
            child.on('exit', (code) => {
                clearTimeout(current.killTimer);
                finish(code === 0 ? null : { code: 'helper_failed', message: `The capture helper ended (${code}).` });
            });
        });
    }

    return { available, listGames, start, stop, setFrameRate, isListed: (hwnd) => listed.has(hwnd) };
}

module.exports = { createGameCapture, HOOK_FILES, HELPER };
