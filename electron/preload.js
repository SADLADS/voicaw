// The page's window onto the desktop app: `window.voicawDesktop` (client/src/utils/desktop.js
// wraps it). Only these calls, never Node or ipcRenderer itself.
const { contextBridge, ipcRenderer } = require('electron');

function listen(channel) {
    return (callback) => {
        const listener = (_event, value) => callback(value);
        ipcRenderer.on(channel, listener);
        return () => ipcRenderer.removeListener(channel, listener);
    };
}

contextBridge.exposeInMainWorld('voicawDesktop', {
    platform: process.platform,
    getInfo: () => ipcRenderer.invoke('desktop:info'),
    notify: (notification) => ipcRenderer.send('desktop:notify', notification),
    setUnread: (unread) => ipcRenderer.send('desktop:unread', unread),
    getSettings: () => ipcRenderer.invoke('desktop:settings'),
    // Resolves to { settings, failedShortcuts }.
    updateSettings: (changes) => ipcRenderer.invoke('desktop:update-settings', changes),
    // 'available' | 'downloading' | 'current' | 'unsupported' | 'error'
    checkForUpdates: () => ipcRenderer.invoke('desktop:check-updates'),
    installUpdate: () => ipcRenderer.send('desktop:install-update'),
    onNavigate: listen('desktop:navigate'),
    onShortcut: listen('desktop:shortcut'),
    onUpdateReady: listen('desktop:update-ready'),
});
