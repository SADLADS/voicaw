import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { OP, encode, decode, socketPath, createRichPresenceServer } = require('../richPresence.js');
const { parseVdf, steamApps, steamGameForPaths, steamPicture, programName, identifyGame } = require('../gameLookup.js');
const { cleanActivity, createGameActivities, pictureUrl } = require('../gameActivities.js');

// A game: connects, and reads frames as they come.
function connectGame(file) {
    const socket = net.createConnection(file);
    let buffer = Buffer.alloc(0);
    const frames = [];
    const waiting = [];
    socket.on('data', (chunk) => {
        const { frames: got, rest } = decode(Buffer.concat([buffer, chunk]));
        buffer = rest;
        frames.push(...got);
        while (waiting.length && frames.length) waiting.shift()(frames.shift());
    });
    return {
        socket,
        ready: new Promise((resolve) => socket.once('connect', resolve)),
        send: (op, data) => socket.write(encode(op, data)),
        next: () => (frames.length ? Promise.resolve(frames.shift()) : new Promise((resolve) => waiting.push(resolve))),
    };
}

describe('Rich Presence socket (richPresence.js)', () => {
    let dir;
    let server;
    let changes;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicaw-rpc-'));
        changes = [];
        server = createRichPresenceServer({ net, fs, platform: 'linux', env: { XDG_RUNTIME_DIR: dir }, onChange: (games) => changes.push(games) });
    });
    afterEach(() => {
        server.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('frames round-trip, and a stream that is not this protocol is refused', () => {
        const both = Buffer.concat([encode(OP.FRAME, { a: 1 }), encode(OP.PING, { b: 2 })]);
        expect(decode(both)).toEqual({ frames: [{ op: OP.FRAME, data: { a: 1 } }, { op: OP.PING, data: { b: 2 } }], rest: Buffer.alloc(0) });
        expect(decode(both.subarray(0, both.length - 3)).frames).toHaveLength(1);
        expect(decode(Buffer.from('GET / HTTP/1.1\r\n\r\n'))).toBeNull();
        expect(socketPath(3, { platform: 'win32' })).toBe('\\\\?\\pipe\\discord-ipc-3');
        expect(socketPath(0, { platform: 'linux', env: { TMPDIR: '/t' } })).toBe('/t/discord-ipc-0');
    });

    it('takes the first free slot, skipping one in use and clearing one left behind', async () => {
        const busy = net.createServer().listen(path.join(dir, 'discord-ipc-0'));
        await new Promise((resolve) => busy.once('listening', resolve));
        // A dead socket file: nothing listens on it any more.
        const dead = net.createServer().listen(path.join(dir, 'discord-ipc-1'));
        await new Promise((resolve) => dead.once('listening', resolve));
        await new Promise((resolve) => dead.close(resolve));
        fs.writeFileSync(path.join(dir, 'discord-ipc-1'), '');
        expect(await server.start()).toBe(path.join(dir, 'discord-ipc-1'));
        busy.close();
    });

    it('answers the handshake, takes activities, and forgets them when the game leaves', async () => {
        const file = await server.start();
        const game = connectGame(file);
        await game.ready;
        game.send(OP.HANDSHAKE, { v: 1, client_id: '383226320970055681' });
        const ready = await game.next();
        expect(ready.data).toMatchObject({ cmd: 'DISPATCH', evt: 'READY' });

        const activity = { details: 'In a match', state: 'Ranked', party: { size: [2, 4] } };
        game.send(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: 4242, activity }, nonce: 'n1' });
        expect((await game.next()).data).toMatchObject({ cmd: 'SET_ACTIVITY', data: activity, nonce: 'n1' });
        expect(changes.at(-1)).toEqual([{ id: expect.any(String), clientId: '383226320970055681', pid: 4242, activity }]);

        game.send(OP.FRAME, { cmd: 'SUBSCRIBE', evt: 'ACTIVITY_JOIN', nonce: 'n2' });
        expect((await game.next()).data).toMatchObject({ cmd: 'SUBSCRIBE', data: { evt: 'ACTIVITY_JOIN' }, nonce: 'n2' });
        game.send(OP.PING, { x: 1 });
        expect(await game.next()).toEqual({ op: OP.PONG, data: { x: 1 } });

        const cleared = new Promise((resolve) => game.socket.once('close', resolve));
        game.socket.end();
        await cleared;
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(changes.at(-1)).toEqual([]);
    });

    it('clears an activity set to null, and closes on a bad handshake', async () => {
        const file = await server.start();
        const game = connectGame(file);
        await game.ready;
        game.send(OP.HANDSHAKE, { v: 1, client_id: '1' });
        await game.next();
        game.send(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: 1, activity: { state: 'Menu' } }, nonce: 'a' });
        await game.next();
        game.send(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: 1, activity: null }, nonce: 'b' });
        await game.next();
        expect(changes.map((c) => c.length)).toEqual([1, 0]);

        const bad = connectGame(file);
        await bad.ready;
        bad.send(OP.HANDSHAKE, { v: 1, client_id: 'not a number' });
        expect((await bad.next()).op).toBe(OP.CLOSE);
    });
});

describe('finding games on this computer (gameLookup.js)', () => {
    let home;
    let steam;
    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'voicaw-steam-'));
        steam = path.join(home, '.local', 'share', 'Steam');
        const other = path.join(home, 'games');
        fs.mkdirSync(path.join(steam, 'steamapps'), { recursive: true });
        fs.mkdirSync(path.join(other, 'steamapps'), { recursive: true });
        fs.writeFileSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'),
            `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${steam}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${other}"\n\t}\n}\n`);
        const manifest = (dir, id, name, installdir) => fs.writeFileSync(path.join(dir, 'steamapps', `appmanifest_${id}.acf`),
            `"AppState"\n{\n\t"appid"\t\t"${id}"\n\t"name"\t\t"${name}"\n\t"installdir"\t\t"${installdir}"\n}\n`);
        manifest(steam, 367520, 'Hollow Knight', 'Hollow Knight');
        manifest(steam, 2805730, 'Proton 9.0', 'Proton 9.0');
        manifest(other, 1145360, 'Hades', 'Hades');
        const cache = path.join(steam, 'appcache', 'librarycache');
        fs.mkdirSync(path.join(cache, '1145360', 'abc'), { recursive: true });
        fs.writeFileSync(path.join(cache, '367520_library_600x900.jpg'), 'jpg');
        fs.writeFileSync(path.join(cache, '1145360', 'abc', 'header.jpg'), 'jpg');
    });
    afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

    it("reads Steam's text files", () => {
        expect(parseVdf('"a" { "b" "c \\"d\\"" "e" { } }')).toEqual({ a: { b: 'c "d"', e: {} } });
    });

    it('finds Steam games by folder, also through Wine, skipping Proton', () => {
        const apps = steamApps(fs, [steam, path.join(home, '.steam', 'steam')]);
        expect(apps.map((a) => a.name).sort()).toEqual(['Hades', 'Hollow Knight', 'Proton 9.0']);
        const proton = `${steam}/steamapps/common/Proton 9.0/files/bin/wine64-preloader`;
        expect(steamGameForPaths(apps, [proton, 'Z:\\games\\steamapps\\common\\Hades\\x64\\Hades.exe'])?.name).toBe('Hades');
        expect(steamGameForPaths(apps, [proton])).toBeNull();
        expect(steamPicture(fs, steam, '367520')).toBe(path.join(steam, 'appcache', 'librarycache', '367520_library_600x900.jpg'));
        expect(steamPicture(fs, steam, '1145360')).toBe(path.join(steam, 'appcache', 'librarycache', '1145360', 'abc', 'header.jpg'));
        expect(steamPicture(fs, steam, '1')).toBeNull();
    });

    it('names programs without Steam', () => {
        expect(programName({ exe: '/usr/bin/wine64-preloader', argv: ['C:\\Games\\Celeste\\Celeste.exe'], platform: 'linux' })).toBe('Celeste');
        expect(programName({ exe: '/usr/bin/python3.12', argv: ['python3', '-u', '/home/me/mygame.py'], platform: 'linux' })).toBe('Mygame');
        expect(programName({ exe: '/Applications/Balatro.app/Contents/MacOS/love', platform: 'darwin' })).toBe('Balatro');
        expect(programName({ exe: '/opt/game/Game.x86_64', platform: 'linux' })).toBe('Game');
        expect(programName({ exe: '/opt/Feishin/feishin', platform: 'linux' })).toBe('Feishin');
        expect(programName({ exe: '/usr/bin/node', argv: ['node', '/home/me/bot.cjs'], platform: 'linux' })).toBe('Bot');
    });

    it('identifies a process: Steam first, then Windows product names', async () => {
        const listSteamApps = () => steamApps(fs, [steam]);
        // Linux: Steam's app id in the environment.
        const proc = {
            readlinkSync: () => '/usr/bin/wine64-preloader',
            readFileSync: (file) => {
                if (file.endsWith('/cmdline')) return 'wine\0Z:\\x\\hk.exe\0';
                if (file.endsWith('/environ')) return 'HOME=/h\0SteamAppId=367520\0';
                return fs.readFileSync(file, 'utf8');
            },
        };
        const linuxFs = { ...fs, ...proc };
        expect(await identifyGame(10, { platform: 'linux', fs: linuxFs, run: null, listSteamApps })).toMatchObject({ name: 'Hollow Knight', steamAppId: '367520' });

        const run = async () => JSON.stringify({ Path: 'D:\\Games\\Foo\\Foo-Win64-Shipping.exe', Product: 'Unreal Engine', Description: 'Foo Fighters' });
        expect(await identifyGame(11, { platform: 'win32', fs, run, listSteamApps })).toMatchObject({ name: 'Foo Fighters', picture: null });
        expect(await identifyGame(12, { platform: 'win32', fs, run: async () => { throw new Error('gone'); }, listSteamApps })).toBeNull();
    });

    it("finds anti-cheat games (no path, only a process name) by the program in a Steam folder", async () => {
        fs.writeFileSync(path.join(steam, 'steamapps', 'appmanifest_252490.acf'),
            '"AppState"\n{\n\t"appid"\t\t"252490"\n\t"name"\t\t"Rust"\n\t"installdir"\t\t"Rust"\n}\n');
        fs.mkdirSync(path.join(steam, 'steamapps', 'common', 'Rust', 'Bundles'), { recursive: true });
        fs.writeFileSync(path.join(steam, 'steamapps', 'common', 'Rust', 'RustClient.exe'), '');
        const listSteamApps = () => steamApps(fs, [steam]);
        // What PowerShell gives for a process Easy Anti-Cheat protects: its name, no path.
        const asked = [];
        const run = (name) => async (_cmd, args) => { asked.push(args.at(-1)); return JSON.stringify({ Name: name, Path: null, Product: null, Description: null }); };
        expect(await identifyGame(20, { platform: 'win32', fs, run: run('RustClient'), listSteamApps })).toMatchObject({ name: 'Rust', steamAppId: '252490', exe: null });
        expect(asked[0]).toContain('Win32_Process'); // WMI was tried for the path
        // Not in Steam: the process name, rather than "a game".
        expect(await identifyGame(21, { platform: 'win32', fs, run: run('ApexGame'), listSteamApps })).toMatchObject({ name: 'ApexGame', steamAppId: null });
    });
});

describe('activities for the page (gameActivities.js)', () => {
    it('cleans what games send', () => {
        expect(cleanActivity({
            type: 4, details: '  In   a match ', state: 'x'.repeat(300), timestamps: { start: 1700000000 },
            party: { size: [2, 4] }, assets: { large_image: 'map_1', large_text: 'Dust' }, buttons: [{ label: 'Join', url: 'https://x' }],
        }, 'Game')).toEqual({
            name: 'Game', type: 0, details: 'In a match', state: 'x'.repeat(128), start: 1700000000000, end: null,
            partySize: 2, partyMax: 4, imageText: 'Dust', smallIcon: null, smallText: null,
        });
        expect(cleanActivity({ assets: { small_image: 'paused', small_text: 'Paused' } }, 'Feishin')).toMatchObject({ smallIcon: 'paused', smallText: 'Paused' });
        expect(cleanActivity({ assets: { small_image: 'pl_icon', small_text: 'Playing' } }, 'X').smallIcon).toBe('playing');
        expect(cleanActivity({ assets: { small_image: 'rank_gold', small_text: 'Gold' } }, 'X').smallIcon).toBeNull();
    });

    it("finds pictures given as web addresses, not Discord's asset keys", () => {
        const cover = 'https://music.example.com/share/img/abc?size=600';
        expect(pictureUrl({ assets: { large_image: cover } })).toBe(cover);
        expect(pictureUrl({ assets: { large_image: 'mp:external/xyz/https/music.example.com/a.jpg' } })).toBe('https://music.example.com/a.jpg');
        expect(pictureUrl({ assets: { large_image: 'icon' } })).toBeNull();
        expect(pictureUrl({ assets: { large_image: 'file:///etc/passwd' } })).toBeNull();
        expect(pictureUrl({})).toBeNull();
    });

    it("uses a music player's cover (fetched once per address) over the program's picture", async () => {
        const fetched = [];
        const sent = [];
        const activities = createGameActivities({
            identify: async () => ({ name: 'Feishin' }),
            loadPicture: () => ({ id: 'icon', data: 'I' }),
            fetchPicture: async (url) => { fetched.push(url); return url.includes('broken') ? null : { id: url.slice(-1), data: 'C' }; },
            onChange: (list) => sent.push(list),
        });
        const song = (title, cover) => [{ id: '1', pid: 5, activity: { type: 2, details: title, assets: { large_image: cover } } }];
        await activities.update(song('One', 'https://m.example/a'));
        await activities.update(song('Two', 'https://m.example/a'));
        await activities.update(song('Three', 'https://m.example/b'));
        expect(sent.at(-1)[0]).toMatchObject({ name: 'Feishin', type: 2, details: 'Three', image: { id: 'b' } });
        await activities.update(song('Four', 'https://m.example/broken'));
        expect(sent.at(-1)[0].image).toEqual({ id: 'icon', data: 'I' });
        expect(fetched).toEqual(['https://m.example/a', 'https://m.example/b', 'https://m.example/broken']);
    });

    it('looks each game up once and gives the page the latest', async () => {
        const looked = [];
        const sent = [];
        const activities = createGameActivities({
            identify: async (pid) => { looked.push(pid); return pid === 1 ? { name: 'Hades', picture: '/p.jpg' } : null; },
            loadPicture: () => ({ id: 'abc', data: 'AAAA' }),
            onChange: (list) => sent.push(list),
        });
        await activities.update([{ id: '1', pid: 1, activity: { state: 'Tartarus' } }]);
        await activities.update([{ id: '1', pid: 1, activity: { state: 'Asphodel' } }, { id: '2', pid: 2, activity: { details: 'Menu' } }]);
        expect(looked).toEqual([1, 2]);
        expect(sent.at(-1)).toEqual([
            expect.objectContaining({ key: '1', name: 'Hades', state: 'Asphodel', image: { id: 'abc', data: 'AAAA' } }),
            expect.objectContaining({ key: '2', name: null, details: 'Menu', image: null }),
        ]);
        expect(activities.current()).toBe(sent.at(-1));
    });
});
