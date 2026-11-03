// The games running now, including those that don't use Rich Presence (FTL...), for the
// in-game overlay (overlay.js) and to share as "Playing X" (gameActivities.js): a Steam game among this computer's processes, found by its Steam app id
// (Linux, from the process's environment, as Steam sets it for everything a game starts,
// Proton games included) or by its program's path under a library's steamapps/common (every
// system; Wine's Z:\ paths too). Steam's own tools (Proton, the runtime) aren't games.
// main.js polls it while the overlay could show (in voice, overlay on) or Rich Presence is on.
const { STEAM_TOOL, steamGameForPaths } = require('./gameLookup');

const read = (fs, file) => {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
};

// The programs' paths (and on Linux the Steam app ids) of the processes we can see, with their
// process ids (for the overlay to find the game's window, gameWindow.js; null if unknown).
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
            if (appId || argv.some((a) => /steamapps[\\/]common/i.test(a))) list.push({ pid: Number(pid), appId, paths: argv });
        }
        return list;
    }
    try {
        if (platform === 'win32') {
            // WMI has paths even for processes that refuse to be opened (anti-cheat), mostly.
            const script = "Get-CimInstance Win32_Process -Filter \"ExecutablePath LIKE '%steamapps%common%'\" | ForEach-Object { @{ path = $_.ExecutablePath; pid = $_.ProcessId } } | ConvertTo-Json -Compress";
            const out = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])).trim();
            if (!out) return [];
            return [].concat(JSON.parse(out))
                .map((p) => (typeof p === 'string' ? { path: p } : p))
                .filter((p) => typeof p?.path === 'string')
                .map((p) => ({ pid: Number.isInteger(p.pid) ? p.pid : null, appId: null, paths: [p.path] }));
        }
        const out = await run('ps', ['-axo', 'pid=,comm=']);
        return out.split('\n').filter((line) => /steamapps\/common/i.test(line)).map((line) => {
            const [, pid, path] = /^\s*(\d+)\s+(.*)$/.exec(line) ?? [null, null, line];
            return { pid: pid ? Number(pid) : null, appId: null, paths: [path.trim()] };
        });
    } catch {
        return [];
    }
}

// Every Steam game running now, once each, as listed in `apps` (installed Steam apps,
// gameLookup.js steamApps: { appId, name, root... }), with `pids`: its processes' ids.
async function runningSteamGames({ platform, fs, run, apps }) {
    if (!apps.length) return [];
    const found = new Map();
    for (const { pid, appId, paths } of await processes({ platform, fs, run })) {
        let app = appId && appId !== '0' ? apps.find((a) => a.appId === appId) : null;
        if (app && STEAM_TOOL.test(app.name)) app = null;
        app ??= steamGameForPaths(apps, paths);
        if (!app) continue;
        const game = found.get(app.appId) ?? { ...app, pids: [] };
        if (pid) game.pids.push(pid);
        found.set(app.appId, game);
    }
    return [...found.values()];
}

// The Steam game running now ({ appId, name }), or null.
async function runningSteamGame(options) {
    const [app] = await runningSteamGames(options);
    return app ? { appId: app.appId, name: app.name } : null;
}

module.exports = { runningSteamGame, runningSteamGames };
