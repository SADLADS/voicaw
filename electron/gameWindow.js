// Where the game's window is, so the in-game overlay (overlay.js) goes on the game's screen
// rather than the one the pointer happens to be on. Electron can't see other programs'
// windows, so each system is asked its own way, given the game's process ids (Rich Presence's
// pid, runningGames.js' processes):
// - Windows: one PowerShell call, Win32's EnumWindows / GetWindowRect (works for games behind
//   anti-cheat too: it never opens the process), per-monitor DPI aware, so physical pixels.
// - Linux: X11's window list (`xprop`, `_NET_CLIENT_LIST`, else the root's children; then each
//   one's `_NET_WM_PID`) and `xwininfo`, from x11-utils; where
//   they're missing, or a Wayland game has no X window, nothing is found. Physical pixels.
// - macOS: CGWindowListCopyWindowInfo through `osascript` (owner pids and bounds need no
//   permission). Points, as Electron's.
// The answer is the centre of the biggest visible window of those processes, in the system's
// own screen coordinates (main.js turns physical pixels into Electron's), or null.

const MAX_PIDS = 64;
const MAX_X_WINDOWS = 200;

const cleanPids = (pids) => [...new Set((pids ?? []).filter((p) => Number.isInteger(p) && p > 0))].slice(0, MAX_PIDS);

const centre = (text) => {
    const match = /^\s*(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\s*$/.exec(text ?? '');
    return match ? { x: Math.round(Number(match[1])), y: Math.round(Number(match[2])) } : null;
};

// C# compiled by PowerShell's Add-Type (C# 5: no newer syntax).
const WINDOWS_SOURCE = `
using System;
using System.Runtime.InteropServices;
public static class VoicawGameWindow {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
    public static string Find(uint[] pids) {
        // Per-monitor aware (v2), so the rectangle is in physical pixels, not scaled.
        try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
        long best = 0;
        string found = "";
        EnumWindows(delegate (IntPtr hwnd, IntPtr lParam) {
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            if (Array.IndexOf(pids, pid) < 0 || !IsWindowVisible(hwnd) || IsIconic(hwnd)) return true;
            int cloaked = 0;
            try { DwmGetWindowAttribute(hwnd, 14, out cloaked, 4); } catch (Exception) { }
            if (cloaked != 0) return true;
            RECT r;
            if (!GetWindowRect(hwnd, out r)) return true;
            long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
            if (area > best) {
                best = area;
                found = ((r.Left + r.Right) / 2) + "," + ((r.Top + r.Bottom) / 2);
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}`;

async function windowsCentre(run, pids) {
    const script = `Add-Type -TypeDefinition @'\n${WINDOWS_SOURCE}\n'@\n[VoicawGameWindow]::Find([uint32[]]@(${pids.join(',')}))`;
    return centre(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]));
}

// JavaScript for Automation; 17 = kCGWindowListOptionOnScreenOnly | ExcludeDesktopElements.
const macScript = (pids) => `ObjC.import('CoreGraphics');
const pids = [${pids.join(',')}];
const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(17, 0))) || [];
let best = 0, found = '';
for (const w of list) {
    const b = w.kCGWindowBounds;
    if (!b || !pids.includes(w.kCGWindowOwnerPID)) continue;
    const area = b.Width * b.Height;
    if (area > best) { best = area; found = (b.X + b.Width / 2) + ',' + (b.Y + b.Height / 2); }
}
found;`;

async function macCentre(run, pids) {
    return centre(await run('osascript', ['-l', 'JavaScript', '-e', macScript(pids)]));
}

// `xprop -root _NET_CLIENT_LIST`: "_NET_CLIENT_LIST: window id # 0x1a00003, 0x2c00007".
const xWindowIds = (out) => (/#\s*(.*)$/m.exec(out ?? '')?.[1] ?? '').split(',').map((s) => s.trim()).filter((s) => /^0x[0-9a-f]+$/i.test(s));

// `xwininfo -root -children` (no window manager, so no client list): "  0x200001 "xeyes": ...".
const xChildIds = (out) => [...(out ?? '').matchAll(/^\s+(0x[0-9a-f]+)\s/gim)].map((m) => m[1]);

// `xwininfo -id W`: its absolute position, size and whether it's showing.
function xGeometry(out) {
    const number = (label) => Number(new RegExp(`${label}:\\s*(-?\\d+)`).exec(out ?? '')?.[1]);
    const geometry = { x: number('Absolute upper-left X'), y: number('Absolute upper-left Y'), width: number('Width'), height: number('Height') };
    if (!/Map State:\s*IsViewable/.test(out ?? '') || !Object.values(geometry).every(Number.isFinite)) return null;
    return geometry;
}

async function x11Centre(run, pids) {
    // The window manager's list of programs' windows; without one, the root's children.
    let ids = xWindowIds(await run('xprop', ['-root', '-notype', '_NET_CLIENT_LIST']).catch(() => ''));
    if (!ids.length) ids = xChildIds(await run('xwininfo', ['-root', '-children']));
    ids = ids.slice(0, MAX_X_WINDOWS);
    const owners = await Promise.all(ids.map((id) => run('xprop', ['-id', id, '-notype', '_NET_WM_PID'])
        .then((out) => Number(/=\s*(\d+)/.exec(out)?.[1]))
        .catch(() => null)));
    const mine = ids.filter((id, i) => pids.includes(owners[i]));
    let best = null;
    for (const id of mine) {
        const g = xGeometry(await run('xwininfo', ['-id', id]).catch(() => ''));
        if (g && (!best || g.width * g.height > best.width * best.height)) best = g;
    }
    return best ? { x: Math.round(best.x + best.width / 2), y: Math.round(best.y + best.height / 2) } : null;
}

// `run(command, args)` resolves to what the program printed (main.js `run`).
async function gameWindowCentre({ platform, run, env = process.env, pids }) {
    const list = cleanPids(pids);
    if (!list.length) return null;
    try {
        if (platform === 'win32') return await windowsCentre(run, list);
        if (platform === 'darwin') return await macCentre(run, list);
        if (platform === 'linux' && env.DISPLAY) return await x11Centre(run, list);
    } catch {
        // No PowerShell / x11-utils / osascript, or it failed: the pointer's screen it is.
    }
    return null;
}

module.exports = { gameWindowCentre, cleanPids, xWindowIds, xChildIds, xGeometry };
