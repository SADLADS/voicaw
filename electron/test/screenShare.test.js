import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createScreenShare, CHOICE_MS } = require('../screenShare.js');

const ORIGIN = 'voicaw://app';

function image(data) {
    return { isEmpty: () => data == null, toDataURL: () => `data:image/png;base64,${data}` };
}

const SOURCES = [
    { id: 'screen:0:0', name: 'Entire screen', thumbnail: image('s0'), appIcon: null },
    { id: 'window:11:0', name: 'Voicaw', thumbnail: image('own'), appIcon: image('i') },
    { id: 'window:12:0', name: 'Notes', thumbnail: image('w12'), appIcon: image('n') },
];

function setUp({ platform = 'win32', clock = { t: 1000 } } = {}) {
    const asked = [];
    const desktopCapturer = {
        getSources: async (options) => {
            asked.push(options);
            return SOURCES;
        },
    };
    const share = createScreenShare({
        desktopCapturer, platform, origin: ORIGIN, ownSourceId: () => 'window:11:0', now: () => clock.t,
    });
    return { share, asked, clock };
}

const request = (changes = {}) => ({
    securityOrigin: `${ORIGIN}/`, frame: { url: `${ORIGIN}/guild/1/2` }, videoRequested: true, audioRequested: true, ...changes,
});

function answer(share, req) {
    let streams;
    share.handleRequest(req, (s) => { streams = s; });
    return streams;
}

describe('screen sharing (screenShare.js)', () => {
    it('lists screens and windows with thumbnails, leaving out our own window', async () => {
        const { share, asked } = setUp();
        const { sources, canShareSound } = await share.listSources();
        expect(asked[0].types).toEqual(['screen', 'window']);
        expect(canShareSound).toBe(true);
        expect(sources).toEqual([
            { id: 'screen:0:0', name: 'Entire screen', kind: 'screen', thumbnail: 'data:image/png;base64,s0', icon: null },
            { id: 'window:12:0', name: 'Notes', kind: 'window', thumbnail: 'data:image/png;base64,w12', icon: 'data:image/png;base64,n' },
        ]);
    });

    it('answers the next request with the source picked, and system sound on Windows', async () => {
        const { share } = setUp();
        await share.listSources();
        expect(share.choose('window:12:0', true)).toBe(true);
        expect(answer(share, request())).toEqual({ video: { id: 'window:12:0', name: 'Notes' }, audio: 'loopback' });
        // Only once.
        expect(answer(share, request())).toEqual({});
    });

    it('shares no sound unless asked for, or where the system has none to give', async () => {
        const windows = setUp();
        await windows.share.listSources();
        windows.share.choose('screen:0:0', false);
        expect(answer(windows.share, request())).toEqual({ video: { id: 'screen:0:0', name: 'Entire screen' } });
        windows.share.choose('screen:0:0', true);
        expect(answer(windows.share, request({ audioRequested: false })).audio).toBeUndefined();

        const mac = setUp({ platform: 'darwin' });
        expect((await mac.share.listSources()).canShareSound).toBe(false);
        mac.share.choose('screen:0:0', true);
        expect(answer(mac.share, request())).toEqual({ video: { id: 'screen:0:0', name: 'Entire screen' } });
    });

    it('refuses without a pick, a pick it never listed, our own window, or a stale pick', async () => {
        const { share, clock } = setUp();
        expect(answer(share, request())).toEqual({});
        await share.listSources();
        expect(share.choose('window:99:0', false)).toBe(false);
        expect(answer(share, request())).toEqual({});
        expect(share.choose('window:11:0', false)).toBe(false);
        share.choose('screen:0:0', false);
        clock.t += CHOICE_MS + 1;
        expect(answer(share, request())).toEqual({});
    });

    it('refuses other pages', async () => {
        const { share } = setUp();
        await share.listSources();
        share.choose('screen:0:0', false);
        expect(answer(share, request({ securityOrigin: 'https://evil.example', frame: { url: 'https://evil.example/' } }))).toEqual({});
        share.choose('screen:0:0', false);
        // A frame of another site inside ours.
        expect(answer(share, request({ frame: { url: 'https://evil.example/' } }))).toEqual({});
    });
});
