const { envelopeStore } = require('./ownEnvelopes');

// Each person's emoji usage (the picker's Frequently Used, the quick reactions, their skin
// tone), following their account to every device. Encrypted on the device (client
// emoji/emojiUsage.js), since which emoji someone uses says something about what they write in
// encrypted chats: the server keeps one opaque `v1.` envelope per account (ownEnvelopes.js),
// always the same size.

// The client pads to exactly 8 KiB.
const MAX_LENGTH = 12000;

const store = envelopeStore({ field: 'emojiUsage', column: 'emoji_usage', versionColumn: 'emoji_usage_version', maxLength: MAX_LENGTH });

module.exports = { MAX_LENGTH, getEmojiUsage: store.get, saveEmojiUsage: store.save };
