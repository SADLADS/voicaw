const db = require('./db');

// The terms of use people accept (voicaw.com/terms/, website/src/legal/terms.html): when
// registering (a tick, the server refuses without it), and once more after they change (the
// app shows TermsGate until they agree or log out). TERMS_VERSION is the terms page's "last
// changed" date (website/build.mjs LEGAL; a test checks they match): change it when the terms
// change in substance, and everyone is asked again. Each account keeps the version it accepted
// and when (users.terms_version, terms_accepted_at). Bots never do: they're their owners'.
const TERMS_VERSION = '2026-10-05';

const hasAccepted = (user) => user?.terms_version === TERMS_VERSION;

// Whether `userId` has accepted the current terms (for /profile and the login responses).
async function acceptedTerms(userId) {
  return hasAccepted(await db.get('SELECT terms_version FROM users WHERE id = ?', [userId]));
}

async function acceptTerms(userId) {
  await db.run('UPDATE users SET terms_version = ?, terms_accepted_at = ? WHERE id = ?', [
    TERMS_VERSION, Math.floor(Date.now() / 1000), userId,
  ]);
}

module.exports = { TERMS_VERSION, hasAccepted, acceptedTerms, acceptTerms };
