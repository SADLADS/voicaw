// Names and pictures for Rich Presence games (richPresence.js), found on this computer only:
// never by asking Discord (the application id a game sends means nothing without Discord's
// catalogue). From the game's process id:
// 1. Steam: the app id Steam put in the game's environment (Linux), or the game's folder under
//    a library's steamapps/common matched to its appmanifest_<id>.acf; the name from the
//    manifest, the cover from Steam's own library cache.
// 2. Otherwise the program: Windows' product name (or description), a macOS .app's name, or
//    the file's name; its icon on Windows and macOS (main.js asks Electron for it).
const path = require('path');

// Steam's text format (KeyValues): "key" "value" and "key" { ... }. Returns nested objects.
function parseVdf(text) {
    const tokens = [];
    const pattern = /"((?:\\.|[^"\\])*)"|([{}])/g;
    let match;
    while ((match = pattern.exec(text))) {
        tokens.push(match[2] ? { brace: match[2] } : { text: match[1].replace(/\\(.)/g, '$1') });
    }
    let i = 0;
    function object() {
        const out = {};
        while (i < tokens.length) {
            const token = tokens[i++];
            if (token.brace === '}') return out;
            if (token.text === undefined) continue;
            const next = tokens[i++];
            if (!next) break;
            if (next.brace === '{') out[token.text] = object();
            else if (next.text !== undefined) out[token.text] = next.text;
        }
        return out;
    }
    return object();
}

// Where Steam may be installed. `registrySteamPath`: Windows' HKCU\Software\Valve\Steam SteamPath.
function steamRoots({ platform, home, registrySteamPath = null }) {
    if (platform === 'win32') {
        return [registrySteamPath, 'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'].filter(Boolean);
    }
    if (platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'Steam')];
    return [
        path.join(home, '.steam', 'steam'),
        path.join(home, '.local', 'share', 'Steam'),
        path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
        path.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam'),
    ];
}

const read = (fs, file) => {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
};

// Steam's tools, which games run inside (Proton, the Linux runtime): never the game.
const STEAM_TOOL = /^(proton|steam linux runtime|steamworks common|steamvr)/i;

// Every installed Steam app: [{ appId, name, installDir, library, root }].
function steamApps(fs, roots) {
    const apps = [];
    const seenRoots = new Set();
    const seenLibraries = new Set();
    for (const root of roots) {
        let real;
        try {
            real = fs.realpathSync(root);
        } catch {
            continue;
        }
        if (seenRoots.has(real)) continue;
        seenRoots.add(real);
        const folders = parseVdf(read(fs, path.join(real, 'steamapps', 'libraryfolders.vdf')) ?? '').libraryfolders ?? {};
        const libraries = [real, ...Object.values(folders).map((f) => (typeof f === 'object' ? f.path : f)).filter(Boolean)];
        for (const library of libraries) {
            const steamapps = path.join(library, 'steamapps');
            let files;
            try {
                files = fs.readdirSync(steamapps);
            } catch {
                continue;
            }
            if (seenLibraries.has(steamapps)) continue;
            seenLibraries.add(steamapps);
            for (const file of files) {
                if (!/^appmanifest_\d+\.acf$/.test(file)) continue;
                const state = parseVdf(read(fs, path.join(steamapps, file)) ?? '').AppState;
                if (!state?.appid || !state.name) continue;
                apps.push({ appId: String(state.appid), name: state.name, installDir: state.installdir ?? null, library, root: real });
            }
        }
    }
    return apps;
}

// The Steam game `paths` (the program and its arguments) belong to, if any.
function steamGameForPaths(apps, paths) {
    for (const raw of paths) {
        // Windows paths, also as Wine shows them on Linux (Z:\home\...).
        const normal = String(raw).replace(/\\/g, '/').toLowerCase();
        const match = /\/steamapps\/common\/([^/]+)(\/|$)/.exec(normal);
        if (!match) continue;
        const app = apps.find((a) => a.installDir?.toLowerCase() === match[1] && !STEAM_TOOL.test(a.name));
        if (app) return app;
    }
    return null;
}

// The best picture Steam keeps for an app: its library cover, else its header, else its icon.
// Older Steam names them <id>_library_600x900.jpg; newer keeps a folder per app (<id>/...,
// sometimes one folder deeper).
function steamPicture(fs, root, appId) {
    const cache = path.join(root, 'appcache', 'librarycache');
    const exists = (file) => {
        try {
            return fs.statSync(file).isFile();
        } catch {
            return false;
        }
    };
    const names = ['library_600x900.jpg', 'header.jpg', 'icon.jpg'];
    for (const name of names) {
        const file = path.join(cache, `${appId}_${name}`);
        if (exists(file)) return file;
    }
    const folder = path.join(cache, appId);
    const dirs = [folder];
    try {
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            if (entry.isDirectory()) dirs.push(path.join(folder, entry.name));
        }
    } catch {
        return null;
    }
    for (const name of names.slice(0, 2)) {
        for (const dir of dirs) {
            if (exists(path.join(dir, name))) return path.join(dir, name);
        }
    }
    // The icon: named by its hash.
    for (const dir of dirs) {
        try {
            const icon = fs.readdirSync(dir).find((f) => /^[0-9a-f]{40}\.jpg$/.test(f));
            if (icon) return path.join(dir, icon);
        } catch { /* gone */ }
    }
    return null;
}

// Programs that run someone else's code: the name is the script's, not theirs.
const RUNNERS = /^(java|javaw|python[\d.]*|pythonw|node|mono|love|wine.*|.*-preloader|godot.*)$/i;

// A name for a program from its path and arguments (no Steam): a Wine program's .exe, a
// runner's script, else the file name, without its extension (capitalised if it's all lower case).
function programName({ exe, argv = [], platform }) {
    const base = (p) => String(p).split(/[\\/]/).pop();
    // Linux programs are often all lower case ("feishin"): "Feishin".
    const bare = (p) => base(p).replace(/\.(exe|x86_64|x86|bin|sh|py|jar|love|app|appimage|js|cjs|mjs)$/i, '')
        .replace(/^[a-z][a-z0-9]*$/, (n) => n[0].toUpperCase() + n.slice(1));
    if (platform === 'darwin') {
        const app = /([^/]+)\.app(\/|$)/.exec(exe ?? '');
        if (app) return app[1];
    }
    const windowsExe = [exe, ...argv].find((p) => p && /\.exe$/i.test(String(p)) && !RUNNERS.test(bare(p)));
    if (windowsExe) return bare(windowsExe);
    if (exe && RUNNERS.test(bare(exe))) {
        const script = argv.slice(1).find((a) => a && !String(a).startsWith('-'));
        if (script) return bare(script);
    }
    const name = exe ? bare(exe) : null;
    return name || null;
}

// What the process `pid` is: { exe, argv, env: { SteamAppId... }, product, description }.
// `run(command, args)` runs a program and resolves to its output (main.js: execFile).
async function processInfo(pid, { platform, fs, run }) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
        if (platform === 'linux') {
            let exe = null;
            try {
                exe = fs.readlinkSync(`/proc/${pid}/exe`);
            } catch { /* not ours to read */ }
            const argv = (read(fs, `/proc/${pid}/cmdline`) ?? '').split('\0').filter(Boolean);
            const env = {};
            for (const entry of (read(fs, `/proc/${pid}/environ`) ?? '').split('\0')) {
                const [key, value] = entry.split(/=(.*)/s);
                if (['SteamAppId', 'SteamGameId', 'STEAM_COMPAT_APP_ID'].includes(key)) env[key] = value;
            }
            if (!exe && !argv.length) return null;
            return { exe, argv, env };
        }
        if (platform === 'win32') {
            const script = `$p = Get-Process -Id ${pid} -ErrorAction Stop; [pscustomobject]@{ Path = $p.Path; Product = $p.Product; Description = $p.Description } | ConvertTo-Json -Compress`;
            const out = JSON.parse(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]));
            if (!out?.Path) return null;
            return { exe: out.Path, argv: [], env: {}, product: out.Product || null, description: out.Description || null };
        }
        const exe = (await run('ps', ['-p', String(pid), '-o', 'comm='])).trim();
        return exe ? { exe, argv: [], env: {} } : null;
    } catch {
        return null;
    }
}

// Windows' version info often says only what made the program.
const GENERIC_PRODUCT = /^(unity player|unityplayer|unreal engine|ue4|ue5|godot engine|microsoft® windows® operating system|java\(tm\).*|python)$/i;

// { name, picture: a file to use as its picture, or null, steamAppId, exe } for `pid`, or null.
// `steamApps()` lists installed Steam apps (cached by the caller).
async function identifyGame(pid, { platform, fs, run, listSteamApps }) {
    const info = await processInfo(pid, { platform, fs, run });
    if (!info) return null;
    const apps = listSteamApps();
    const envId = info.env.SteamAppId || info.env.SteamGameId || info.env.STEAM_COMPAT_APP_ID;
    let app = envId && envId !== '0' ? apps.find((a) => a.appId === String(envId) && !STEAM_TOOL.test(a.name)) : null;
    app ??= steamGameForPaths(apps, [info.exe, ...info.argv].filter(Boolean));
    if (app) return { name: app.name, picture: steamPicture(fs, app.root, app.appId), steamAppId: app.appId, exe: info.exe };
    const product = [info.product, info.description].find((p) => p && !GENERIC_PRODUCT.test(p.trim()));
    const name = product?.trim() || programName({ exe: info.exe, argv: info.argv, platform });
    return name ? { name, picture: null, steamAppId: null, exe: info.exe } : null;
}

module.exports = { parseVdf, steamRoots, steamApps, steamGameForPaths, steamPicture, programName, processInfo, identifyGame, STEAM_TOOL };
