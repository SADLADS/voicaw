// The page's window onto the desktop app: `window.voicawDesktop` (client/src/utils/desktop.js
// wraps it). Only these calls, never Node or ipcRenderer itself.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

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
    // Looks once more for a newer version, downloads it if there is one, then restarts onto
    // it; resolves to false if there was nothing to install.
    installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
    // Screen sharing: { canShareSound, sources: [{ id, name, kind, thumbnail, icon }] }; then
    // chooseScreenSource(id, audio) before getDisplayMedia (electron/screenShare.js).
    getScreenSources: () => ipcRenderer.invoke('desktop:screen-sources'),
    chooseScreenSource: (id, audio) => ipcRenderer.invoke('desktop:choose-screen-source', id, audio),
    // The page's right-click menu: Electron's own paste, and its checker for what the page
    // has no dictionary for (electron/spellcheck.js), kept to the account's words.
    paste: () => ipcRenderer.send('desktop:paste'),
    spelling: {
        isMisspelled: (word) => webFrame.isWordMisspelled(String(word)),
        suggestions: (word) => webFrame.getWordSuggestions(String(word)),
    },
    setSpellingWords: (words) => ipcRenderer.send('desktop:spelling-words', words),
    onNavigate: listen('desktop:navigate'),
    onShortcut: listen('desktop:shortcut'),
    onUpdateReady: listen('desktop:update-ready'),
    onUpdateProgress: listen('desktop:update-progress'), // 0 to 1, while downloading
});
