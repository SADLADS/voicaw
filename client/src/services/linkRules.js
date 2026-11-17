import { compileRules, cleanLinksInText } from '../utils/linkCleaner';
import { BUILT_IN_RULES, KEEP_RULES } from '../utils/linkRulesBuiltIn';
import { getPrivacyPrefs } from '../utils/privacy';

// Remove tracking from pasted links (Settings → Privacy `cleanLinks`, off by default): which
// rules, and keeping them up to date. Ours (utils/linkRulesBuiltIn.js) always apply; the
// server's copy of AdGuard's list (GET /link-rules, server/linkRules.js) adds to them, kept
// in localStorage `linkRules` ({ etag, rules, checkedAt }; public data, so logging out keeps it)
// and asked for again at most every 12 hours while the setting is on (`have` saves sending it
// again when unchanged). The device never contacts AdGuard.

const STORAGE_KEY = 'linkRules';
const CHECK_MS = 12 * 60 * 60 * 1000;

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

let saved = load();
let compiled = null;
let refreshing = null;

function save(next) {
  saved = next;
  compiled = null;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Kept for this visit only.
  }
}

function currentRules() {
  compiled ??= compileRules(BUILT_IN_RULES, saved.rules, KEEP_RULES);
  return compiled;
}

// Asks the server for its list when the last check is over 12 hours old (or `force`).
// Failing, or a server without one, leaves the built-in rules (and any earlier copy).
export function refreshLinkRules({ force = false } = {}) {
  if (refreshing) return refreshing;
  if (!force && Date.now() - (saved.checkedAt ?? 0) < CHECK_MS) return Promise.resolve();
  refreshing = (async () => {
    try {
      // Imported here so the editor doesn't load the API client until it's needed.
      const { default: api } = await import('../utils/api');
      const { data } = await api.get('/link-rules', { params: saved.etag ? { have: saved.etag } : {} });
      if (data?.enabled === false) {
        save({ checkedAt: Date.now() });
      } else if (data?.unchanged) {
        save({ ...saved, checkedAt: Date.now() });
      } else if (Array.isArray(data?.list?.rules)) {
        save({ etag: data.etag, rules: data.list.rules, checkedAt: Date.now() });
      } else {
        // The server hasn't downloaded it yet: ask again next time.
      }
    } catch {
      // Older servers don't have it; offline, the copy we have does.
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// Pasted text with its links cleaned, when the setting is on (and a check for newer rules).
export function cleanPastedLinks(text) {
  if (!getPrivacyPrefs().cleanLinks) return text;
  refreshLinkRules();
  return cleanLinksInText(text, currentRules());
}

export function resetLinkRulesForTests() {
  saved = load();
  compiled = null;
  refreshing = null;
}
