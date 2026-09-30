const path = require('path');
const { app, BrowserWindow } = require('electron');
const { setUpSpellcheck } = require('./spellcheck');

function createWindow() {
    const win = new BrowserWindow({
        icon: path.join(__dirname, 'assets', 'icon.png'),
        width: 1200,
        height: 800,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: false,
            spellcheck: true,
        },
    });
    setUpSpellcheck(win);

    win.loadFile(path.join(__dirname, '../build/index.html'));
    win.setMenuBarVisibility(false);  // Hide menu bar
    win.removeMenu();                 // Remove default "File/Edit/View"

    // open devtools
    win.webContents.openDevTools();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
