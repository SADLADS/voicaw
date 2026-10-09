// Turns what Rich Presence games send (richPresence.js) into the activities the page shares
// (client/src/services/activityService.js): named and pictured by gameLookup.js, cleaned,
// each game looked up once. The page gets
// [{ key, name, type, details, state, start, end, partySize, partyMax, imageText, image }],
// `image` being { id, data } (a small JPEG or PNG, base64; id its hash) or null.
// A game whose big picture is a web address (a music player's album cover on the person's own
// server, as Feishin sends with Navidrome) gets that picture instead: fetched by this computer
// (`fetchPicture`), never by the server or the people looking, and the address isn't shared.
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

// `identify(pid)` → { name, picture, exe } or null (gameLookup.identifyGame); `loadPicture(game)`
// → a nativeImage-made picture ({ id, data }) or null; `fetchPicture(url)` → the same for a web
// address, or null; `onChange(activities)`. A game nothing
// could be found about has no name (the page says "a game").
const MAX_URL_PICTURES = 50;

function createGameActivities({ identify, loadPicture, fetchPicture = async () => null, onChange }) {
    const identities = new Map(); // connection id + pid -> Promise<{ name, picture }>
    const urlPictures = new Map(); // web address -> Promise<picture or null>, the latest used last
    let latest = [];
    let current = [];
    let running = Promise.resolve();

    function identityOf(game) {
        const key = `${game.id}:${game.pid ?? ''}`;
        if (!identities.has(key)) {
            identities.set(key, (async () => {
                const found = game.pid ? await identify(game.pid).catch(() => null) : null;
                const image = found ? await Promise.resolve(loadPicture(found)).catch(() => null) : null;
                return { name: found?.name ?? null, image };
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
        const games = latest;
        const activities = [];
        for (const game of games) {
            const { name, image } = await identityOf(game);
            const url = pictureUrl(game.activity);
            const own = url ? await urlPicture(url) : null;
            const activity = cleanActivity(game.activity, text(name));
            activities.push({ key: game.id, ...activity, image: own ?? image });
        }
        // Forget games that left.
        const live = new Set(games.map((g) => `${g.id}:${g.pid ?? ''}`));
        for (const key of identities.keys()) if (!live.has(key)) identities.delete(key);
        if (games !== latest) return; // a newer change is on its way
        current = activities;
        onChange(current);
    }

    return {
        update(games) {
            latest = games;
            running = running.then(rebuild, rebuild);
            return running;
        },
        current: () => current,
    };
}

module.exports = { cleanActivity, pictureFrom, pictureUrl, createGameActivities, GAME_TYPES };
