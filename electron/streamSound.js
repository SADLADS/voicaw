// A screen share's sound on Linux. Electron's own system sound ("loopback") is Windows only, so
// on a PipeWire desktop we make it ourselves: a virtual microphone ("Voicaw stream sound", a
// null-audio-sink node with media.class Audio/Source/Virtual), and every other program's
// playback linked into it as well as to the speakers, which keep playing everything as before.
// Voicaw's own playback (the call's voices, our sounds) is never linked, so viewers don't hear
// themselves, as on Windows. The page records the virtual microphone (getUserMedia, found by its
// name) and publishes it as the share's sound. Programs that start playing during the share are
// linked as they appear (`pw-dump` every POLL_MS). The node goes when the share stops, when the
// page reloads or closes, and when the app quits; one left by a crash is removed by the next share.
//
// Only PipeWire's own command-line tools (pw-cli, pw-dump, pw-link; in every PipeWire install),
// no native module. Plain PulseAudio can't link a program to two outputs: no sound there.

const NODE_PREFIX = 'voicaw-stream-sound-';
const LABEL = 'Voicaw stream sound';
const POLL_MS = 2000;
const RECHECK_MS = 30 * 1000;
const FIND_TRIES = 20;
const FIND_WAIT_MS = 100;
const TOOLS = ['pw-cli', 'pw-dump', 'pw-link'];

// pw-dump's output: a JSON array of objects, sometimes followed by more arrays of changes when
// the graph changed while it was dumping (a later entry replaces an earlier one with its id;
// `info: null` means it went). Read as one list.
function parseDump(text) {
    const byId = new Map();
    let depth = 0;
    let inString = false;
    let start = -1;
    for (let i = 0; i < text.length; i += 1) {
        const c = text[i];
        if (inString) {
            if (c === '\\') i += 1;
            else if (c === '"') inString = false;
        } else if (c === '"') inString = true;
        else if (c === '[' || c === '{') {
            if (depth === 0) start = i;
            depth += 1;
        } else if (c === ']' || c === '}') {
            depth -= 1;
            if (depth === 0) {
                const part = JSON.parse(text.slice(start, i + 1));
                for (const object of Array.isArray(part) ? part : [part]) {
                    if (object?.id == null) continue;
                    if (object.info === null) byId.delete(object.id);
                    else byId.set(object.id, object);
                }
            }
        }
    }
    return [...byId.values()];
}

// The objects pw-dump lists that matter here: nodes, ports and links.
function parseGraph(objects) {
    const nodes = new Map();
    const ports = [];
    const links = new Set();
    for (const object of Array.isArray(objects) ? objects : []) {
        const info = object?.info;
        if (!info) continue;
        const props = info.props ?? {};
        if (object.type === 'PipeWire:Interface:Node') nodes.set(object.id, { id: object.id, props });
        else if (object.type === 'PipeWire:Interface:Port') {
            ports.push({ id: object.id, node: props['node.id'], direction: info.direction, channel: props['audio.channel'], props });
        } else if (object.type === 'PipeWire:Interface:Link') links.add(`${info['output-port-id']}:${info['input-port-id']}`);
    }
    return { nodes, ports, links };
}

// Which of the virtual microphone's inputs a playback channel goes to: left ones left, right
// ones right, the rest (mono, centre...) to both. LFE is left out (a downmix drops it too).
function targetChannels(channel) {
    const c = String(channel ?? '').toUpperCase();
    if (c === 'LFE') return [];
    if (c === 'MONO' || c === 'FC' || c === 'RC' || c === 'TC') return ['FL', 'FR'];
    if (/L$|^L|LC$/.test(c)) return ['FL'];
    if (/R$|^R|RC$/.test(c)) return ['FR'];
    return ['FL', 'FR'];
}

// A program's playback: an audio stream out. Ours if its process is one of the app's.
const isPlayback = (node) => node.props['media.class'] === 'Stream/Output/Audio';
const isOwn = (node, ownPids) => ownPids.has(Number(node.props['application.process.id']));

// The links to make: [outputPortId, inputPortId] for every other program's playback channel
// not yet linked to the virtual microphone `sinkId`.
function linksToMake(graph, { sinkId, ownPids }) {
    const inputs = new Map(graph.ports
        .filter((p) => p.node === sinkId && p.direction === 'input')
        .map((p) => [String(p.channel).toUpperCase(), p.id]));
    if (!inputs.size) return [];
    const wanted = [];
    for (const port of graph.ports) {
        if (port.direction !== 'output' || port.props['port.monitor'] === true) continue;
        const node = graph.nodes.get(port.node);
        if (!node || !isPlayback(node) || isOwn(node, ownPids)) continue;
        for (const channel of targetChannels(port.channel)) {
            const input = inputs.get(channel);
            if (input != null && !graph.links.has(`${port.id}:${input}`)) wanted.push([port.id, input]);
        }
    }
    return wanted;
}

// Virtual microphones of ours left behind: by a crashed run (its process gone), or by this one.
function leftoverNodes(graph, { pid, alive }) {
    const found = [];
    for (const node of graph.nodes.values()) {
        const name = String(node.props['node.name'] ?? '');
        if (!name.startsWith(NODE_PREFIX)) continue;
        const owner = Number(name.slice(NODE_PREFIX.length));
        if (owner === pid || !alive(owner)) found.push(node.id);
    }
    return found;
}

function nodeProperties(pid) {
    // priority 0: never chosen as anyone's default microphone over a real one.
    return `{ factory.name=support.null-audio-sink node.name=${NODE_PREFIX}${pid} node.description="${LABEL}" `
        + 'media.class=Audio/Source/Virtual audio.position=[FL FR] object.linger=true '
        + 'priority.session=0 priority.driver=0 }';
}

// `run(command, args)` resolves to its stdout (rejects if it fails); `runSync` for quitting.
// `ownPids()` the app's processes (main, renderers, the audio service).
function createStreamSound({
    platform, run, runSync = null, ownPids, pid = process.pid, alive = processAlive, now = Date.now,
    setTimer = setInterval, clearTimer = clearInterval, wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
}) {
    let checked = null; // { at, result: Promise<boolean> }
    let active = null; // { nodeId, timer }
    let starting = null;

    // Whether this system can: Linux with PipeWire running and its tools installed.
    function available() {
        if (platform !== 'linux') return Promise.resolve(false);
        if (checked && (checked.ok || now() - checked.at < RECHECK_MS)) return checked.result;
        const entry = { at: now(), ok: false };
        entry.result = (async () => {
            try {
                for (const tool of TOOLS) await run(tool, ['--version']);
                await graph(); // only answers with the daemon running
                entry.ok = true;
                return true;
            } catch {
                return false;
            }
        })();
        checked = entry;
        return entry.result;
    }

    async function graph() {
        return parseGraph(parseDump(await run('pw-dump', [])));
    }

    // The node just made: pw-cli can return before pw-dump lists it.
    async function findNode() {
        for (let attempt = 0; attempt < FIND_TRIES; attempt += 1) {
            const node = [...(await graph()).nodes.values()].find((n) => n.props['node.name'] === `${NODE_PREFIX}${pid}`);
            if (node) return node;
            await wait(FIND_WAIT_MS);
        }
        return null;
    }

    async function removeOurs() {
        const current = await graph().catch(() => null);
        for (const node of current?.nodes.values() ?? []) {
            if (node.props['node.name'] === `${NODE_PREFIX}${pid}`) await run('pw-cli', ['destroy', String(node.id)]).catch(() => {});
        }
    }

    async function link(sinkId) {
        const current = await graph();
        const pids = new Set(ownPids());
        for (const [output, input] of linksToMake(current, { sinkId, ownPids: pids })) {
            // A stream can end between pw-dump and pw-link; the next round sorts that out.
            await run('pw-link', [String(output), String(input)]).catch(() => {});
        }
    }

    // Makes the virtual microphone and starts linking; resolves to { label } for the page, or
    // null if it couldn't.
    async function start() {
        if (active) return { label: LABEL };
        if (starting) return starting;
        starting = (async () => {
            try {
                if (!(await available())) return null;
                for (const id of leftoverNodes(await graph(), { pid, alive })) {
                    await run('pw-cli', ['destroy', String(id)]).catch(() => {});
                }
                await run('pw-cli', ['create-node', 'adapter', nodeProperties(pid)]);
                const node = await findNode();
                if (!node) throw new Error('The virtual microphone never appeared');
                let linking = false;
                const round = () => {
                    if (linking || active?.nodeId !== node.id) return;
                    linking = true;
                    link(node.id).catch(() => {}).finally(() => { linking = false; });
                };
                active = { nodeId: node.id, timer: setTimer(round, POLL_MS) };
                await link(node.id).catch(() => {});
                return { label: LABEL };
            } catch (err) {
                console.warn('Could not set up the stream sound', err?.message ?? err);
                // Not left behind half made (create-node may have worked, or timed out after).
                await removeOurs();
                return null;
            } finally {
                starting = null;
            }
        })();
        return starting;
    }

    async function stop() {
        if (starting) await starting;
        const was = active;
        active = null;
        if (!was) return;
        clearTimer(was.timer);
        await run('pw-cli', ['destroy', String(was.nodeId)]).catch(() => {});
    }

    // While quitting there's no waiting for promises.
    function stopNow() {
        const was = active;
        active = null;
        if (!was) return;
        clearTimer(was.timer);
        try {
            runSync?.('pw-cli', ['destroy', String(was.nodeId)]);
        } catch {
            // Gone already; the next share removes it otherwise.
        }
    }

    return { available, start, stop, stopNow, isActive: () => active !== null };
}

function processAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM';
    }
}

module.exports = { createStreamSound, parseDump, parseGraph, linksToMake, targetChannels, leftoverNodes, nodeProperties, LABEL, NODE_PREFIX, POLL_MS };
