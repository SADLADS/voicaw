const { envelopeStore } = require('./ownEnvelopes');

// Each person's spellcheck dictionary (the words they've added with "Add to Dictionary"),
// following their account to every device. Encrypted on the device (client
// spellcheck/personalDictionary.js): the server keeps one opaque `v1.` envelope per account
// and never sees the words (ownEnvelopes.js). Padded on the device, so its length only says
// roughly how many.

// Room for a few thousand words (the client pads to 1 KiB steps and stops at 48 KiB).
const MAX_LENGTH = 70000;

const store = envelopeStore({ field: 'dictionary', column: 'dictionary', versionColumn: 'dictionary_version', maxLength: MAX_LENGTH });

module.exports = { MAX_LENGTH, getDictionary: store.get, saveDictionary: store.save };
