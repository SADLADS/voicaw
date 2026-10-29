// Turns what Rich Presence games send (richPresence.js) into the activities the page shares
// (client/src/services/activityService.js): named and pictured by gameLookup.js, cleaned,
// each game looked up once. The page gets
// [{ key, name, type, details, state, start, end, partySize, partyMax, imageText, image, statusShows }],
// `image` being { id, data } (a small JPEG or PNG, base64; id its hash) or null.
// A game whose big picture is a web address (a music player's album cover on the person's own
// server, as Feishin sends with Navidrome) gets that picture instead: fetched by this computer
// (`fetchPicture`), never by the server or the people looking, and the address isn't shared.
// Steam games that don't use Rich Presence (FTL...) are found among the running programs
// (runningGames.js, `setSteamGames`) and shared as a plain "Playing X" from when they were
// first seen, unless the same game already says more through Rich Presence.
// The order (the first is the one shown under names): games (Playing, Competing) before music
// and videos, then the one started last first.
const crypto = require('crypto');

const MAX_TEXT = 128;
// Discord's activity types a game can set: Playing, Listening to, Watching, Competing in.
const GAME_TYPES = new Set([0, 2, 3, 5]);

const text = (value) => {
    if (typeof value !== 'string') return null;
    const clean = value.replace(/\s+/g, ' ').trim();
    return clean ? [...clean].slice(0, MAX_TEXT).join('') : null;
};

// Games send seconds (the old discord-rpc library) or milliseconds (newer SDKs).
const time = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n < 1e12 ? n * 1000 : n);
};

// The small picture's meaning, when it's one we know: music players send Discord asset keys
// such as 'playing' / 'paused' (Feishin), which only Discord could draw, so the page draws its
// own play or pause icon instead. Anything else isn't shown.
function smallIconOf(assets) {
    for (const value of [assets?.small_image, assets?.small_text]) {
        const word = typeof value === 'string' ? value.trim().toLowerCase() : '';
        if (word === 'playing' || word === 'play') return 'playing';
        if (word === 'paused' || word === 'pause') return 'paused';
    }
    return null;
}

// Which text the short line under names shows instead of the program's name: Discord's
// `status_display_type` (0 the name, 1 the state, 2 the details), which music players offer as
// a setting (Feishin's "Discord presence display type": its name, the song or the artists).
const STATUS_SHOWS = { 1: 'state', 2: 'details' };

function cleanActivity(activity, name) {
    const size = Array.isArray(activity.party?.size) ? activity.party.size.map(Number) : [];
    const [partySize, partyMax] = size.length === 2 && size.every((n) => Number.isInteger(n) && n >= 0 && n < 1e6) ? size : [null, null];
    const type = Number(activity.type);
    return {
        name,
        type: GAME_TYPES.has(type) ? type : 0,
        details: text(activity.details),
        state: text(activity.state),
        start: time(activity.timestamps?.start),
        end: time(activity.timestamps?.end),
        partySize,
        partyMax,
        // What the game says about its big picture ("Level 3"); the picture itself is ours.
        imageText: text(activity.assets?.large_text),
        // 'playing' | 'paused' | null (smallIconOf), with the small picture's hover text.
        smallIcon: smallIconOf(activity.assets),
        smallText: text(activity.assets?.small_text),
        statusShows: STATUS_SHOWS[activity.status_display_type] ?? null,
    };
}

// The web address in a game's big picture, if it's one: `https://…`, or Discord's media proxy
// form (`mp:external/<hash>/https/host/path`). Other values are Discord asset keys (only
// Discord can look those up).
function pictureUrl(activity) {
    const value = activity?.assets?.large_image;
    if (typeof value !== 'string' || value.length > 2048) return null;
    const proxied = /^mp:external\/[^/]+\/(https?)\/(.+)$/.exec(value);
    const url = proxied ? `${proxied[1]}://${proxied[2]}` : value;
    try {
        const parsed = new URL(url);
        return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
    } catch {
        return null;
    }
}

// Square, at most 128 px: a cover as JPEG, an icon (which may be see-through) as PNG.
// `image` is an Electron nativeImage.
function pictureFrom(image, { photo }) {
    if (!image || image.isEmpty()) return null;
    const { width, height } = image.getSize();
    const side = Math.min(width, height);
    if (!side) return null;
    let square = image.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
    if (side > 128) square = square.resize({ width: 128, height: 128, quality: 'good' });
    const bytes = photo ? square.toJPEG(82) : square.toPNG();
    if (!bytes?.length) return null;
    return { id: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32), data: bytes.toString('base64') };
}

// `identify(pid)` → { name, picture, steamAppId, exe } or null (gameLookup.identifyGame);
// `loadPicture(game)` → a nativeImage-made picture ({ id, data }) or null for what identify
// found or a Steam game ({ picture }); `fetchPicture(url)` → the same for a web address, or
// null; `onChange(activities)`. A game nothing could be found about has no name (the page
// says "a game").
const MAX_URL_PICTURES = 50;

// Playing and Competing before Listening and Watching, then the latest started first.
const isGame = (activity) => activity.type === 0 || activity.type === 5;
const byShown = (a, b) => (isGame(b) - isGame(a)) || (b.since - a.since);

function createGameActivities({ identify, loadPicture, fetchPicture = async () => null, onChange }) {
    const identities = new Map(); // connection id + pid -> Promise<{ name, image, steamAppId }>
    const urlPictures = new Map(); // web address -> Promise<picture or null>, the latest used last
    const steamGames = new Map(); // app id -> { appId, name, since, image: Promise<picture or null> }
    let latest = [];
    let current = [];
    let version = 0;
    let running = Promise.resolve();

    function identityOf(game) {
        const key = `${game.id}:${game.pid ?? ''}`;
        if (!identities.has(key)) {
            identities.set(key, (async () => {
                const found = game.pid ? await identify(game.pid).catch(() => null) : null;
                const image = found ? await Promise.resolve(loadPicture(found)).catch(() => null) : null;
                return { name: found?.name ?? null, image, steamAppId: found?.steamAppId ?? null };
            })());
        }
        return identities.get(key);
    }

    function urlPicture(url) {
        let picture = urlPictures.get(url);
        if (picture) {
            urlPictures.delete(url);
        } else {
            picture = Promise.resolve().then(() => fetchPicture(url)).catch(() => null);
        }
        urlPictures.set(url, picture);
        while (urlPictures.size > MAX_URL_PICTURES) urlPictures.delete(urlPictures.keys().next().value);
        return picture;
    }

    async function rebuild() {
        const asOf = version;
        const games = latest;
        const activities = [];
        const steamIds = new Set();
        const names = new Set();
        for (const game of games) {
            const { name, image, steamAppId } = await identityOf(game);
            const url = pictureUrl(game.activity);
            const own = url ? await urlPicture(url) : null;
            const activity = cleanActivity(game.activity, text(name));
            if (steamAppId) steamIds.add(steamAppId);
            if (activity.name) names.add(activity.name.toLowerCase());
            activities.push({ key: game.id, ...activity, image: own ?? image, since: game.since ?? 0 });
        }
        for (const game of steamGames.values()) {
            const name = text(game.name);
            if (steamIds.has(game.appId) || (name && names.has(name.toLowerCase()))) continue;
            activities.push({
                key: `steam:${game.appId}`,
                ...cleanActivity({ type: 0, timestamps: { start: game.since } }, name),
                image: await game.image,
                since: game.since,
            });
        }
        // Forget games that left.
        const live = new Set(games.map((g) => `${g.id}:${g.pid ?? ''}`));
        for (const key of identities.keys()) if (!live.has(key)) identities.delete(key);
        if (asOf !== version) return; // a newer change is on its way
        current = activities.sort(byShown).map(({ since, ...activity }) => activity);
        onChange(current);
    }

    function changed() {
        version++;
        running = running.then(rebuild, rebuild);
        return running;
    }

    return {
        // What Rich Presence games say (richPresence.js onChange).
        update(games) {
            latest = games;
            return changed();
        },
        // The Steam games running now ([{ appId, name, picture }], picture a file or null;
        // runningGames.js), each kept from when it was first seen until it's gone.
        setSteamGames(list) {
            const ids = new Set(list.map((g) => g.appId));
            let moved = false;
            for (const appId of steamGames.keys()) {
                if (!ids.has(appId)) {
                    steamGames.delete(appId);
                    moved = true;
                }
            }
            for (const game of list) {
                if (steamGames.has(game.appId)) continue;
                const image = Promise.resolve().then(() => loadPicture({ picture: game.picture ?? null, exe: null })).catch(() => null);
                steamGames.set(game.appId, { appId: game.appId, name: game.name, since: Date.now(), image });
                moved = true;
            }
            return moved ? changed() : running;
        },
        current: () => current,
    };
}

module.exports = { cleanActivity, pictureFrom, pictureUrl, createGameActivities, GAME_TYPES };
