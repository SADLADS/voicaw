// Screen sharing in the desktop app. A browser shows its own picker for getDisplayMedia;
// Electron has none, so the page shows ours (ScreenPicker in the client): it asks for the
// screens and windows (`listSources`, with thumbnails), the person picks one, the page says
// which (`choose`), then calls getDisplayMedia as usual, and `handleRequest` (the session's
// display media handler) answers it with that source. A choice is good for one request, for
// a minute, and only for a source we listed.
//
// Sound: Electron can only capture the whole system's sound ("loopback"), and only on Windows.
// The page asks for it with restrictOwnAudio, and Electron then captures it without this app's
// own sound (the call's voices), like Discord.

const CHOICE_MS = 60 * 1000;
const THUMBNAIL = { width: 384, height: 216 };

const canShareSound = (platform) => platform === 'win32';

function createScreenShare({ desktopCapturer, platform, origin, ownSourceId = () => null, now = Date.now }) {
    let listed = new Map(); // id → source, from the last listing
    let choice = null; // { source, audio, at }

    // Screens first, then windows (not our own), each { id, name, kind, thumbnail, icon }.
    async function listSources() {
        const sources = await desktopCapturer.getSources({
            types: ['screen', 'window'],
            thumbnailSize: THUMBNAIL,
            fetchWindowIcons: true,
        });
        const own = ownSourceId();
        const kept = sources.filter((source) => source.id !== own);
        listed = new Map(kept.map((source) => [source.id, source]));
        return {
            canShareSound: canShareSound(platform),
            sources: kept.map((source) => ({
                id: source.id,
                name: source.name,
                kind: source.id.startsWith('screen:') ? 'screen' : 'window',
                thumbnail: source.thumbnail?.isEmpty?.() ? null : source.thumbnail?.toDataURL() ?? null,
                icon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null,
            })),
        };
    }

    // The page's pick, for its next getDisplayMedia. False if it wasn't one we listed.
    function choose(id, audio) {
        const source = listed.get(id);
        if (!source) {
            choice = null;
            return false;
        }
        choice = { source, audio: audio === true && canShareSound(platform), at: now() };
        return true;
    }

    // setDisplayMediaRequestHandler's handler.
    function handleRequest(request, callback) {
        const picked = choice;
        choice = null;
        // Electron gives the origin as "voicaw://app/".
        const ours = request.securityOrigin?.replace(/\/$/, '') === origin && (request.frame?.url ?? `${origin}/`).startsWith(`${origin}/`);
        if (!ours || !picked || now() - picked.at > CHOICE_MS || !request.videoRequested) {
            callback({});
            return;
        }
        const streams = { video: { id: picked.source.id, name: picked.source.name } };
        if (picked.audio && request.audioRequested) streams.audio = 'loopback';
        callback(streams);
    }

    return { listSources, choose, handleRequest };
}

module.exports = { createScreenShare, canShareSound, CHOICE_MS };
