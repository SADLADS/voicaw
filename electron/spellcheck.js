// Spellcheck in the desktop app. The page checks spelling itself (client/src/spellcheck/, the
// same as in a browser) and draws its own right-click menu, so Electron shows none. Electron's
// checker is still what underlines plain text boxes, and everything when the page has no
// dictionary for the language; for those the page asks it for suggestions (preload.js,
// webFrame) and keeps its custom dictionary the same as the account's (`syncSpellingWords`).
// The page turns checking on and off with the `spellcheck` attribute (Settings → Spellcheck).
const { app } = require('electron');

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

// Makes Electron's custom dictionary hold exactly `words` (the page's personal dictionary).
async function syncSpellingWords(session, words) {
    if (!Array.isArray(words)) return;
    const wanted = new Set(words.filter((w) => typeof w === 'string' && w.length > 0 && w.length <= 100));
    const current = new Set(await session.listWordsInSpellCheckerDictionary());
    for (const word of current) if (!wanted.has(word)) session.removeWordFromSpellCheckerDictionary(word);
    for (const word of wanted) if (!current.has(word)) session.addWordToSpellCheckerDictionary(word);
}

function setUpSpellcheck(win) {
    const { session } = win.webContents;
    // macOS always checks with the system's own languages.
    if (process.platform !== 'darwin') {
        session.setSpellCheckerLanguages(
            spellcheckLanguages(app.getPreferredSystemLanguages(), session.availableSpellCheckerLanguages),
        );
    }
}

module.exports = { setUpSpellcheck, spellcheckLanguages, syncSpellingWords };
