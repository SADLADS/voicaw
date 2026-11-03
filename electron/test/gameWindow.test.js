import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { gameWindowCentre, cleanPids, xWindowIds, xChildIds, xGeometry } = require('../gameWindow.js');

const xwininfo = (x, y, width, height, state = 'IsViewable') => `
xwininfo: Window id: 0x1 "game"
  Absolute upper-left X:  ${x}
  Absolute upper-left Y:  ${y}
  Relative upper-left X:  0
  Width: ${width}
  Height: ${height}
  Map State: ${state}
`;

describe("finding the game's window (gameWindow.js)", () => {
    it('takes only real process ids', () => {
        expect(cleanPids([3, 3, 0, -2, 1.5, '4', null, 8])).toEqual([3, 8]);
        expect(cleanPids(undefined)).toEqual([]);
    });

    it("reads X11's window list and geometry", () => {
        expect(xWindowIds('_NET_CLIENT_LIST: window id # 0x1a00003, 0x2c00007\n')).toEqual(['0x1a00003', '0x2c00007']);
        expect(xWindowIds('_NET_CLIENT_LIST:  not found.\n')).toEqual([]);
        // No window manager: the root's children.
        expect(xChildIds('xwininfo: Window id: 0x3c3 (the root window) (has no name)\n\n  Root window id: 0x3c3\n  2 children:\n     0x20000a "xclock": ("xclock" "XClock")  300x300+100+100  +100+100\n     0x40000c "xterm": ("xterm" "XTerm")  484x316+2500+400  +2500+400\n'))
            .toEqual(['0x20000a', '0x40000c']);
        expect(xGeometry(xwininfo(1920, 0, 2560, 1440))).toEqual({ x: 1920, y: 0, width: 2560, height: 1440 });
        expect(xGeometry(xwininfo(0, 0, 10, 10, 'IsUnMapped'))).toBeNull();
        expect(xGeometry('')).toBeNull();
    });

    it("on Linux, the centre of the biggest showing X window the game's processes own", async () => {
        const owners = { '0x1': 100, '0x2': 42, '0x3': 42, '0x4': 43 };
        const geometry = { '0x2': xwininfo(1920, 0, 800, 600), '0x3': xwininfo(1920, 0, 2560, 1440), '0x4': xwininfo(0, 0, 4000, 4000, 'IsUnMapped') };
        const run = vi.fn(async (command, args) => {
            if (command === 'xprop' && args[0] === '-root') return `_NET_CLIENT_LIST: window id # ${Object.keys(owners).join(', ')}\n`;
            if (command === 'xprop') return `_NET_WM_PID = ${owners[args[1]]}\n`;
            if (command === 'xwininfo') return geometry[args[1]];
            throw new Error('unexpected');
        });
        expect(await gameWindowCentre({ platform: 'linux', run, env: { DISPLAY: ':0' }, pids: [42, 43] })).toEqual({ x: 3200, y: 720 });
        // Other programs' windows' sizes aren't asked for.
        expect(run.mock.calls.filter(([c]) => c === 'xwininfo').map(([, a]) => a[1])).toEqual(['0x2', '0x3', '0x4']);
        expect(await gameWindowCentre({ platform: 'linux', run, env: { DISPLAY: ':0' }, pids: [7] })).toBeNull();
    });

    it('gives up quietly: no X display, no x11-utils, no processes', async () => {
        const run = vi.fn(async () => { throw new Error('ENOENT'); });
        expect(await gameWindowCentre({ platform: 'linux', run, env: {}, pids: [42] })).toBeNull();
        expect(run).not.toHaveBeenCalled();
        expect(await gameWindowCentre({ platform: 'linux', run, env: { DISPLAY: ':0' }, pids: [42] })).toBeNull();
        expect(await gameWindowCentre({ platform: 'win32', run, pids: [42] })).toBeNull();
        expect(await gameWindowCentre({ platform: 'win32', run, pids: [] })).toBeNull();
    });

    it("on Windows, asks PowerShell's Win32 calls about those processes only", async () => {
        const run = vi.fn(async () => '3200,720\r\n');
        expect(await gameWindowCentre({ platform: 'win32', run, pids: [42, 7] })).toEqual({ x: 3200, y: 720 });
        const [command, args] = run.mock.calls[0];
        expect(command).toBe('powershell.exe');
        expect(args.at(-1)).toContain('[VoicawGameWindow]::Find([uint32[]]@(42,7))');
        expect(args.at(-1)).toContain('EnumWindows');
        run.mockResolvedValueOnce('\r\n'); // no window
        expect(await gameWindowCentre({ platform: 'win32', run, pids: [42] })).toBeNull();
        run.mockResolvedValueOnce('-1200,-40\r\n'); // a screen left of the main one
        expect(await gameWindowCentre({ platform: 'win32', run, pids: [42] })).toEqual({ x: -1200, y: -40 });
    });

    it('on macOS, asks CoreGraphics through osascript', async () => {
        const run = vi.fn(async () => '2240.5,450\n');
        expect(await gameWindowCentre({ platform: 'darwin', run, pids: [812] })).toEqual({ x: 2241, y: 450 });
        expect(run.mock.calls[0][0]).toBe('osascript');
        expect(run.mock.calls[0][1].at(-1)).toContain('const pids = [812];');
    });
});
