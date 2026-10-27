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

// Every Steam game running now, once each, as listed in `apps` (installed Steam apps,
// gameLookup.js steamApps: { appId, name, root... }).
async function runningSteamGames({ platform, fs, run, apps }) {
    if (!apps.length) return [];
    const found = new Map();
    for (const { appId, paths } of await processes({ platform, fs, run })) {
        let app = appId && appId !== '0' ? apps.find((a) => a.appId === appId) : null;
        if (app && STEAM_TOOL.test(app.name)) app = null;
        app ??= steamGameForPaths(apps, paths);
        if (app) found.set(app.appId, app);
    }
    return [...found.values()];
}

// The Steam game running now ({ appId, name }), or null.
async function runningSteamGame(options) {
    const [app] = await runningSteamGames(options);
    return app ? { appId: app.appId, name: app.name } : null;
}

module.exports = { runningSteamGame, runningSteamGames };
