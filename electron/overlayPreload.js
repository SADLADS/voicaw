// The in-game overlay's page (client overlay.html, overlay.js): what to show, and its buttons.
// Nothing else of the app's is reachable from it.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (callback) => ipcRenderer.on(channel, (event, value) => callback(value));

contextBridge.exposeInMainWorld('voicawOverlay', {
    platform: process.platform,
    // { voice: { title, status, selfMute, selfDeaf, members: [...] }, unlocked, position, shortcut }
    onState: listen('overlay:state'),
    // A notification: { title, body, url, icon, tag }
    onToast: listen('overlay:toast'),
    // { type: 'size', width, height } | 'lock' | 'toggleMute' | 'toggleDeafen' | 'disconnect'
    // | { type: 'position', position } | { type: 'open', url }
    send: (message) => ipcRenderer.send('overlay:message', message),
});
