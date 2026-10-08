// The splash window's page (assets/splash.html, splash.js): what to show, and "Start anyway".
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (callback) => ipcRenderer.on(channel, (event, value) => callback(value));

contextBridge.exposeInMainWorld('splash', {
    onView: listen('splash:view'), // { ring: 'spin' | 'progress', text, detail }
    onProgress: listen('splash:progress'), // 0 to 1
    onOfferStart: listen('splash:offer-start'),
    startAnyway: () => ipcRenderer.send('splash:start-anyway'),
});
