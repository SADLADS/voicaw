// Rich Presence: games that show what you're doing in Discord ("Playing X", "In a match, 2 of
// 4") do it through a local socket, `discord-ipc-N` (a named pipe on Windows), in Discord's RPC
// protocol. This listens on the first free one, so those games tell Voicaw instead, unchanged.
// Discord running already keeps discord-ipc-0, and games use the first that answers: then
// they keep talking to Discord. (arRPC does the same for other Discord clients.)
//
// The protocol: frames of [opcode u32 LE][length u32 LE][JSON]. The game sends a HANDSHAKE
// ({ v: 1, client_id }: its application id in Discord's portal) and gets READY; then
// SET_ACTIVITY frames ({ cmd, args: { pid, activity }, nonce }), each answered. An activity
// lasts until it's cleared (activity null) or the game disconnects.
// Nothing here asks Discord anything: the game's name and picture come from gameLookup.js.
const path = require('path');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const SLOTS = 10;
const MAX_FRAME = 64 * 1024;
const MAX_CONNECTIONS = 20;

// What READY says about "the Discord user". Games rarely show it; it's never the real account.
const READY_DATA = {
    v: 1,
    config: { cdn_host: 'cdn.discordapp.com', api_endpoint: '//discord.com/api', environment: 'production' },
    user: { id: '1', username: 'voicaw', discriminator: '0', global_name: 'Voicaw', avatar: null, bot: false, flags: 0, premium_type: 0 },
};

function socketPath(slot, { platform = process.platform, env = process.env } = {}) {
    if (platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${slot}`;
    const base = env.XDG_RUNTIME_DIR || env.TMPDIR || env.TMP || env.TEMP || '/tmp';
    return path.join(base, `discord-ipc-${slot}`);
}

function encode(op, data) {
    const json = Buffer.from(JSON.stringify(data));
    const header = Buffer.alloc(8);
    header.writeUInt32LE(op, 0);
    header.writeUInt32LE(json.length, 4);
    return Buffer.concat([header, json]);
}

// Splits what arrived into frames; returns { frames, rest } (rest: an unfinished frame), or
// null if the stream isn't this protocol.
function decode(buffer) {
    const frames = [];
    let offset = 0;
    while (buffer.length - offset >= 8) {
        const op = buffer.readUInt32LE(offset);
        const length = buffer.readUInt32LE(offset + 4);
        if (op > OP.PONG || length > MAX_FRAME) return null;
        if (buffer.length - offset - 8 < length) break;
        let data;
        try {
            data = JSON.parse(buffer.subarray(offset + 8, offset + 8 + length).toString('utf8'));
        } catch {
            return null;
        }
        frames.push({ op, data });
        offset += 8 + length;
    }
    return { frames, rest: buffer.subarray(offset) };
}

// `net` and `fs` are Node's (passed in for tests). `onChange(games)` gets every game showing
// an activity, the latest first: [{ id, clientId, pid, activity }] (activity as the game sent it).
function createRichPresenceServer({ net, fs, platform = process.platform, env = process.env, onChange }) {
    let server = null;
    let listening = null; // the socket path
    const connections = new Map(); // id -> { socket, clientId, pid, activity, at }
    let nextId = 1;

    function changed() {
        const games = [...connections.entries()]
            .filter(([, c]) => c.activity)
            .sort(([, a], [, b]) => b.at - a.at)
            .map(([id, c]) => ({ id, clientId: c.clientId, pid: c.pid, activity: c.activity }));
        onChange(games);
    }

    function reply(socket, data) {
        if (!socket.destroyed) socket.write(encode(OP.FRAME, data));
    }

    function handleCommand(conn, data) {
        const { cmd, args, nonce } = data ?? {};
        if (cmd === 'SET_ACTIVITY') {
            const pid = Number(args?.pid);
            if (Number.isInteger(pid) && pid > 0) conn.pid = pid;
            const activity = args?.activity && typeof args.activity === 'object' ? args.activity : null;
            const had = Boolean(conn.activity);
            conn.activity = activity;
            conn.at = Date.now();
            reply(conn.socket, { cmd, evt: null, data: activity, nonce });
            if (activity || had) changed();
        } else if (cmd === 'SUBSCRIBE' || cmd === 'UNSUBSCRIBE') {
            // Joining and spectating through Discord isn't ours; say yes so games carry on.
            reply(conn.socket, { cmd, evt: null, data: { evt: data.evt ?? null }, nonce });
        } else {
            reply(conn.socket, { cmd, evt: 'ERROR', data: { code: 4000, message: 'Not supported' }, nonce });
        }
    }

    function handleConnection(socket) {
        if (connections.size >= MAX_CONNECTIONS) return socket.destroy();
        const id = String(nextId++);
        const conn = { socket, clientId: null, pid: null, activity: null, at: 0 };
        let buffered = Buffer.alloc(0);
        connections.set(id, conn);

        socket.on('data', (chunk) => {
            const result = decode(Buffer.concat([buffered, chunk]));
            if (!result || result.rest.length > MAX_FRAME + 8) return socket.destroy();
            buffered = result.rest;
            for (const { op, data } of result.frames) {
                if (op === OP.HANDSHAKE) {
                    const clientId = data?.client_id;
                    if (conn.clientId || typeof clientId !== 'string' || !/^\d{1,20}$/.test(clientId)) {
                        socket.end(encode(OP.CLOSE, { code: 4000, message: 'Invalid handshake' }));
                        return;
                    }
                    conn.clientId = clientId;
                    reply(socket, { cmd: 'DISPATCH', evt: 'READY', data: READY_DATA, nonce: null });
                } else if (op === OP.FRAME) {
                    if (!conn.clientId) return socket.destroy();
                    handleCommand(conn, data);
                } else if (op === OP.PING) {
                    if (!socket.destroyed) socket.write(encode(OP.PONG, data));
                } else if (op === OP.CLOSE) {
                    socket.end();
                }
            }
        });
        socket.on('error', () => {});
        socket.on('close', () => {
            connections.delete(id);
            if (conn.activity) changed();
        });
    }

    // Is something answering on `file` (Discord, or another copy of this)?
    function inUse(file) {
        return new Promise((resolve) => {
            const probe = net.createConnection(file);
            probe.once('connect', () => { probe.destroy(); resolve(true); });
            probe.once('error', () => resolve(false));
        });
    }

    function listenOn(file) {
        return new Promise((resolve) => {
            const candidate = net.createServer(handleConnection);
            candidate.once('error', () => resolve(null));
            candidate.listen(file, () => resolve(candidate));
        });
    }

    // Resolves to the socket path it took, or null if all ten were busy.
    async function start() {
        if (server) return listening;
        for (let slot = 0; slot < SLOTS; slot++) {
            const file = socketPath(slot, { platform, env });
            if (platform !== 'win32' && fs.existsSync(file)) {
                if (await inUse(file)) continue;
                // Left behind by a client that crashed.
                try { fs.unlinkSync(file); } catch { continue; }
            }
            const candidate = await listenOn(file);
            if (candidate) {
                server = candidate;
                listening = file;
                return file;
            }
        }
        return null;
    }

    function stop() {
        const had = [...connections.values()].some((c) => c.activity);
        for (const { socket } of connections.values()) socket.destroy();
        connections.clear();
        if (server) {
            server.close();
            if (platform !== 'win32' && listening) {
                try { fs.unlinkSync(listening); } catch { /* already gone */ }
            }
        }
        server = null;
        listening = null;
        if (had) onChange([]);
    }

    return { start, stop, path: () => listening };
}

module.exports = { OP, socketPath, encode, decode, createRichPresenceServer };
