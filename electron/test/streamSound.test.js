import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createStreamSound, parseDump, parseGraph, linksToMake, targetChannels, leftoverNodes, NODE_PREFIX, LABEL } = require('../streamSound.js');

// A pw-dump of: our virtual microphone (id 50), another program's stereo playback (60),
// Voicaw's own playback (70, process 4242), a mono program (80), a microphone (90).
const node = (id, props) => ({ id, type: 'PipeWire:Interface:Node', info: { props } });
const port = (id, nodeId, direction, channel, extra = {}) => ({
    id, type: 'PipeWire:Interface:Port', info: { direction, props: { 'node.id': nodeId, 'audio.channel': channel, ...extra } },
});
const link = (id, out, input) => ({ id, type: 'PipeWire:Interface:Link', info: { 'output-port-id': out, 'input-port-id': input } });

function dump({ extra = [] } = {}) {
    return [
        { id: 0, type: 'PipeWire:Interface:Core', info: { props: {} } },
        node(50, { 'node.name': `${NODE_PREFIX}4242`, 'media.class': 'Audio/Source/Virtual' }),
        port(51, 50, 'input', 'FL'), port(52, 50, 'input', 'FR'), port(53, 50, 'output', 'FL'), port(54, 50, 'output', 'FR'),
        node(60, { 'media.class': 'Stream/Output/Audio', 'application.name': 'Music', 'application.process.id': 1000 }),
        port(61, 60, 'output', 'FL'), port(62, 60, 'output', 'FR'),
        node(70, { 'media.class': 'Stream/Output/Audio', 'application.name': 'Voicaw', 'application.process.id': 4243 }),
        port(71, 70, 'output', 'FL'), port(72, 70, 'output', 'FR'),
        node(80, { 'media.class': 'Stream/Output/Audio', 'application.name': 'Game', 'application.process.id': '2000' }),
        port(81, 80, 'output', 'MONO'),
        node(90, { 'media.class': 'Audio/Source', 'node.name': 'mic' }),
        port(91, 90, 'output', 'FL'), port(92, 90, 'output', 'FR', { 'port.monitor': true }),
        ...extra,
    ];
}

describe('stream sound on Linux (streamSound.js)', () => {
    it('links every other program\'s playback into the microphone, never our own', () => {
        const graph = parseGraph(dump({ extra: [link(100, 61, 51)] }));
        expect(linksToMake(graph, { sinkId: 50, ownPids: new Set([4242, 4243]) })).toEqual([
            [62, 52], // Music's left is linked already
            [81, 51], [81, 52], // mono to both sides
        ]);
        // Without our own processes it would take ours too.
        expect(linksToMake(graph, { sinkId: 50, ownPids: new Set() })).toContainEqual([71, 51]);
        // No microphone (yet): nothing.
        expect(linksToMake(graph, { sinkId: 999, ownPids: new Set() })).toEqual([]);
    });

    it('reads pw-dump\'s changes printed after its first list', () => {
        const first = [node(1, { 'node.name': 'a' }), node(2, { 'node.name': 'b "[x]"' })];
        const changes = [{ id: 1, type: 'PipeWire:Interface:Node', info: null }, node(3, { 'node.name': 'c' })];
        const text = `${JSON.stringify(first, null, 2)}\n${JSON.stringify(changes, null, 2)}\n`;
        expect(parseDump(text).map((o) => o.id)).toEqual([2, 3]);
        expect(parseDump('[]')).toEqual([]);
    });

    it('sends each channel to its side', () => {
        expect(targetChannels('FL')).toEqual(['FL']);
        expect(targetChannels('RR')).toEqual(['FR']);
        expect(targetChannels('SL')).toEqual(['FL']);
        expect(targetChannels('FLC')).toEqual(['FL']);
        expect(targetChannels('FRC')).toEqual(['FR']);
        expect(targetChannels('FC')).toEqual(['FL', 'FR']);
        expect(targetChannels('MONO')).toEqual(['FL', 'FR']);
        expect(targetChannels('AUX3')).toEqual(['FL', 'FR']);
        expect(targetChannels('LFE')).toEqual([]);
    });

    it('finds microphones left by a crashed run, or by this one', () => {
        const graph = parseGraph([
            node(1, { 'node.name': `${NODE_PREFIX}10` }), node(2, { 'node.name': `${NODE_PREFIX}20` }),
            node(3, { 'node.name': `${NODE_PREFIX}30` }), node(4, { 'node.name': 'other' }),
        ]);
        expect(leftoverNodes(graph, { pid: 30, alive: (pid) => pid === 20 || pid === 30 })).toEqual([1, 3]);
    });

    // `listedAfter`: how many pw-dumps after create-node before the new node is in them.
    function fakeSystem({ platform = 'linux', missing = [], listedAfter = 0 } = {}) {
        const calls = [];
        let objects = dump().filter((o) => o.id !== 50 && o.info.props['node.id'] !== 50);
        let hidden = null;
        const run = async (command, args) => {
            calls.push([command, ...args]);
            if (missing.includes(command)) throw new Error('ENOENT');
            if (command === 'pw-dump') {
                if (hidden && hidden.dumps-- <= 0) {
                    objects = [...objects, ...hidden.objects];
                    hidden = null;
                }
                return JSON.stringify(objects);
            }
            if (command === 'pw-cli' && args[0] === 'create-node') {
                hidden = { dumps: listedAfter, objects: dump().filter((o) => o.id === 50 || o.info.props['node.id'] === 50) };
            }
            if (command === 'pw-cli' && args[0] === 'destroy') objects = objects.filter((o) => o.id !== Number(args[1]));
            if (command === 'pw-link') objects = [...objects, link(1000 + calls.length, Number(args[0]), Number(args[1]))];
            return '';
        };
        const timers = [];
        const sound = createStreamSound({
            platform, run, runSync: (command, args) => calls.push(['sync', command, ...args]), ownPids: () => [4242, 4243], pid: 4242,
            alive: () => true, wait: async () => {}, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: (id) => { timers[id - 1] = null; },
        });
        return { sound, calls, timers };
    }

    it('makes the microphone, links what plays, keeps linking new programs, and removes it', async () => {
        const { sound, calls, timers } = fakeSystem();
        expect(await sound.available()).toBe(true);
        expect(await sound.start()).toEqual({ label: LABEL });
        expect(calls.find((c) => c[1] === 'create-node')[3]).toContain(`node.name=${NODE_PREFIX}4242`);
        const linking = (c) => c[0] === 'pw-link' && c[1] !== '--version';
        const links = calls.filter(linking).map((c) => c.slice(1));
        expect(links).toEqual([['61', '51'], ['62', '52'], ['81', '51'], ['81', '52']]);
        // A second start while sharing changes nothing; a round with nothing new links nothing.
        expect(await sound.start()).toEqual({ label: LABEL });
        timers[0]();
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        expect(calls.filter(linking)).toHaveLength(4);
        await sound.stop();
        expect(calls.at(-1)).toEqual(['pw-cli', 'destroy', '50']);
        expect(timers[0]).toBeNull();
        expect(sound.isActive()).toBe(false);
    });

    it('waits for the new microphone to be listed, and removes it if it never is', async () => {
        const slow = fakeSystem({ listedAfter: 3 });
        expect(await slow.sound.start()).toEqual({ label: LABEL });
        const never = fakeSystem({ listedAfter: 1000 });
        expect(await never.sound.start()).toBeNull();
        expect(never.sound.isActive()).toBe(false);
    });

    it('removes it at once when the app quits', async () => {
        const { sound, calls } = fakeSystem();
        await sound.start();
        sound.stopNow();
        expect(calls.at(-1)).toEqual(['sync', 'pw-cli', 'destroy', '50']);
    });

    it('is not there off Linux or without PipeWire\'s tools', async () => {
        const windows = fakeSystem({ platform: 'win32' });
        expect(await windows.sound.available()).toBe(false);
        expect(await windows.sound.start()).toBeNull();
        expect(windows.calls).toEqual([]);
        const noTools = fakeSystem({ missing: ['pw-link'] });
        expect(await noTools.sound.available()).toBe(false);
        expect(await noTools.sound.start()).toBeNull();
    });
});
