// The Steam Deck's Gaming Mode (and any other gamescope session started by Steam): the app
// runs as one full-screen "game" under gamescope, with no taskbar, no tray and no window
// manager, and Steam thinks the game is over once the process it started exits. So there
// main.js quits on close instead of hiding to a tray that isn't there, opens without the splash
// (whose update restarts the app outside Steam's view), and asks for X11 (gamescope runs X11
// apps through its own Xwayland); updater.js installs updates on quit without restarting.
// Desktop Mode is an ordinary KDE session and gets none of this.

// gamescope-session sets XDG_CURRENT_DESKTOP=gamescope; gamescope itself gives every app it
// runs GAMESCOPE_WAYLAND_DISPLAY.
function inGamingMode(env = process.env, platform = process.platform) {
    if (platform !== 'linux') return false;
    const desktops = String(env.XDG_CURRENT_DESKTOP ?? '').toLowerCase().split(':');
    return desktops.includes('gamescope') || Boolean(env.GAMESCOPE_WAYLAND_DISPLAY);
}

module.exports = { inGamingMode };
