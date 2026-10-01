// Spellcheck in the desktop app. Electron underlines misspelled words by itself but shows no
// right-click menu, so this adds one: suggestions, "Add to dictionary" (Electron keeps its
// custom dictionary in the app's data folder, on this device) and the usual edit items. The
// page turns checking on and off with the `spellcheck` attribute (Settings → Spellcheck).
const { Menu, app } = require('electron');

// The system's languages that have a dictionary (the first with the same base language if
// there's no exact one), else British English.
function spellcheckLanguages(preferred, available) {
    const base = (locale) => locale.split('-')[0].toLowerCase();
    const chosen = [];
    for (const locale of preferred) {
        const match = available.find((a) => a.toLowerCase() === locale.toLowerCase())
            ?? available.find((a) => base(a) === base(locale));
        if (match && !chosen.includes(match)) chosen.push(match);
    }
    if (chosen.length) return chosen;
    return available.includes('en-GB') ? ['en-GB'] : [];
}

// The right-click menu for `params` (Electron's context-menu event), or [] for none.
function contextMenuTemplate(params, webContents) {
    const template = [];
    if (params.misspelledWord) {
        for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
            template.push({ label: suggestion, click: () => webContents.replaceMisspelling(suggestion) });
        }
        if (!params.dictionarySuggestions.length) template.push({ label: 'No suggestions', enabled: false });
        template.push(
            { type: 'separator' },
            {
                label: 'Add to dictionary',
                click: () => webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
            },
            { type: 'separator' },
        );
    }
    const { editFlags } = params;
    if (params.isEditable) {
        template.push(
            { label: 'Cut', role: 'cut', enabled: editFlags.canCut },
            { label: 'Copy', role: 'copy', enabled: editFlags.canCopy },
            { label: 'Paste', role: 'paste', enabled: editFlags.canPaste },
            { type: 'separator' },
            { label: 'Select all', role: 'selectAll', enabled: editFlags.canSelectAll },
        );
    } else if (params.selectionText) {
        template.push({ label: 'Copy', role: 'copy' });
    }
    return template;
}

function setUpSpellcheck(win) {
    const { session } = win.webContents;
    // macOS always checks with the system's own languages.
    if (process.platform !== 'darwin') {
        session.setSpellCheckerLanguages(
            spellcheckLanguages(app.getPreferredSystemLanguages(), session.availableSpellCheckerLanguages),
        );
    }
    win.webContents.on('context-menu', (event, params) => {
        const template = contextMenuTemplate(params, win.webContents);
        if (template.length) Menu.buildFromTemplate(template).popup({ window: win });
    });
}

module.exports = { setUpSpellcheck, spellcheckLanguages, contextMenuTemplate };
