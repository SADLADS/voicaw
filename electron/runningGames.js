// Whether a game is running, for the in-game overlay (overlay.js), including games that don't
// use Rich Presence: a Steam game among this computer's processes, found by its Steam app id
// (Linux, from the process's environment, as Steam sets it for everything a game starts,
// Proton games included) or by its program's path under a library's steamapps/common (every
// system; Wine's Z:\ paths too). Steam's own tools (Proton, the runtime) aren't games.
// Only asked while the overlay could show (in voice, overlay on): main.js polls it.
const { STEAM_TOOL, steamGameForPaths } = require('./gameLookup');

const read = (fs, file) => {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
};

// The programs' paths (and on Linux the Steam app ids) of the processes we can see.
async function processes({ platform, fs, run }) {
    if (platform === 'linux') {
        let pids;
        try {
            pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
        } catch {
            return [];
        }
        const list = [];
        for (const pid of pids) {
            // Other users' processes can't be read: not ours, not our games.
            const environ = read(fs, `/proc/${pid}/environ`);
            if (environ === null) continue;
            const appId = /(?:^|\0)(?:SteamAppId|SteamGameId)=(\d+)/.exec(environ)?.[1] ?? null;
            const argv = (read(fs, `/proc/${pid}/cmdline`) ?? '').split('\0').filter(Boolean).slice(0, 4);
            if (appId || argv.some((a) => /steamapps[\\/]common/i.test(a))) list.push({ appId, paths: argv });
        }
        return list;
    }
    try {
        if (platform === 'win32') {
            // WMI has paths even for processes that refuse to be opened (anti-cheat), mostly.
            const script = "Get-CimInstance Win32_Process -Filter \"ExecutablePath LIKE '%steamapps%common%'\" | ForEach-Object { $_.ExecutablePath } | ConvertTo-Json -Compress";
            const out = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])).trim();
            if (!out) return [];
            const paths = [].concat(JSON.parse(out)).filter((p) => typeof p === 'string');
            return paths.map((p) => ({ appId: null, paths: [p] }));
        }
        const out = await run('ps', ['-axo', 'comm=']);
        return out.split('\n').filter((line) => /steamapps\/common/i.test(line)).map((line) => ({ appId: null, paths: [line.trim()] }));
    } catch {
        return [];
    }
}

// The Steam game running now ({ appId, name }), or null. `apps`: installed Steam apps
// (gameLookup.js steamApps).
async function runningSteamGame({ platform, fs, run, apps }) {
    if (!apps.length) return null;
    for (const { appId, paths } of await processes({ platform, fs, run })) {
        let app = appId && appId !== '0' ? apps.find((a) => a.appId === appId) : null;
        if (app && STEAM_TOOL.test(app.name)) app = null;
        app ??= steamGameForPaths(apps, paths);
        if (app) return { appId: app.appId, name: app.name };
    }
    return null;
}

module.exports = { runningSteamGame };
