const db = require('./db');

// Profiles: what people choose to show about themselves, beyond their username (which stays
// their unique handle). All optional; null when not set. Shown to everyone logged in (like
// usernames), so nothing here is private.
// - display_name: shown instead of the username wherever a name is shown
// - custom_status: a short line under their name ("Working from home 🏠")
// - bio: a few lines on their profile card
const LIMITS = { display_name: 32, custom_status: 128, bio: 190 };
const PROFILE_COLUMNS = 'display_name, custom_status, bio';

// A trimmed value within its limit (null when empty), or undefined if it's not valid.
function clean(field, value) {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = field === 'bio' ? value.trim().replace(/\n{3,}/g, '\n\n') : value.trim().replace(/\s+/g, ' ');
  if (trimmed.length > LIMITS[field]) return undefined;
  return trimmed || null;
}

// The name to show for someone: their display name, else their username.
const nameOf = (user) => user?.display_name || user?.username || '';

// The name to show for user `id` (looked up), or `fallback`.
async function displayNameOf(id, fallback = '') {
  const row = await db.get('SELECT username, display_name FROM users WHERE id = ?', [id]);
  return row ? nameOf(row) : fallback;
}

module.exports = { LIMITS, PROFILE_COLUMNS, clean, nameOf, displayNameOf };
