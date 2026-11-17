// The list of tracking parameters that "Remove tracking from pasted links" (Settings → Privacy,
// off by default) takes out of links pasted into the message box: AdGuard's URL Tracking filter
// (GPL-3.0, github.com/AdguardTeam/AdguardFilters, TrackParamFilter), downloaded by this server
// once a day so nobody has to update it and people's devices never contact AdGuard. Only the
// rules that apply to opening a link are kept, converted to a small JSON list that the client's
// utils/linkCleaner.js reads (GET /link-rules, routes/linkRules.js). The client always adds its
// own short list (utils/linkRulesBuiltIn.js) and uses that alone when this has nothing.
// A download that looks wrong (unparsable, far smaller than the last one) is ignored and the
// last good copy kept; it lives in memory only and is downloaded again when the API starts.
// Settings → Admin's "Tracking parameter list" (appSettings linkRules) stops the downloading.
const crypto = require('crypto');

const FILTER_URL = 'https://filters.adtidy.org/extension/chromium/filters/17.txt';
const MAX_BYTES = 5 * 1024 * 1024;
const MIN_RULES = 200;
const MAX_RULES = 50000;
const REFRESH_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;

// Options a kept rule may carry. Request types other than a page (document) mean the rule is
// about a site's own scripts or pictures, never a link someone opens, so those rules are left out.
const REQUEST_TYPES = new Set(['script', 'image', 'stylesheet', 'xmlhttprequest', 'xhr', 'subdocument', 'frame', 'font',
  'media', 'object', 'other', 'ping', 'websocket', 'webrtc', 'popup', 'css']);
const HARMLESS = new Set(['important', 'match-case', 'third-party', '3p', '~third-party', '~3p', 'first-party', '1p',
  '~first-party', '~1p']);

// Splits on commas that aren't escaped (a regex's `\,`).
function splitOptions(text) {
  const parts = [];
  let part = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === ',') {
      part += ',';
      i++;
    } else if (text[i] === ',') {
      parts.push(part);
      part = '';
    } else {
      part += text[i];
    }
  }
  parts.push(part);
  return parts;
}

// `name`, `/regex/flags` (matched against `name=value`) or `*` (every parameter); null to skip.
function paramSpec(value) {
  if (value === '') return '*';
  if (value.startsWith('~')) return null;
  const regex = /^\/(.+)\/(i?)$/.exec(value);
  if (regex) {
    try {
      new RegExp(regex[1], regex[2]);
    } catch {
      return null;
    }
    return value;
  }
  return /^[^\s=&/]+$/.test(value) ? value : null;
}

// The options after a rule's `$`, or null when the rule isn't one we keep.
function parseOptions(text) {
  let param = null;
  let domains = null;
  let types = false;
  let document = false;
  for (const option of splitOptions(text)) {
    const [name, ...rest] = option.split('=');
    const value = rest.join('=');
    if (name === 'removeparam') {
      param = paramSpec(value);
      if (param === null) return null;
    } else if (name === 'domain' && value) {
      domains = value.split('|');
      if (domains.some((d) => !/^~?[a-z0-9*.-]+$/i.test(d))) return null;
    } else if (name === 'document' || name === 'doc') {
      document = true;
    } else if (REQUEST_TYPES.has(name)) {
      types = true;
    } else if (name.startsWith('~') && REQUEST_TYPES.has(name.slice(1))) {
      // "Not scripts" still includes pages.
    } else if (!HARMLESS.has(name)) {
      return null;
    }
  }
  if (param === null || (types && !document)) return null;
  return { param, domains };
}

function escapeRegex(text) {
  return text.replace(/[.+?${}()[\]\\/]/g, '\\$&');
}

// An adblock address pattern as a regex over the whole link (`||` the host and its subdomains,
// `|` an end, `^` a separator, `*` anything).
function patternRegex(pattern) {
  let source = '';
  let rest = pattern;
  if (rest.startsWith('||')) {
    source = '^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#]*\\.)?';
    rest = rest.slice(2);
  } else if (rest.startsWith('|')) {
    source = '^';
    rest = rest.slice(1);
  }
  const end = rest.endsWith('|');
  if (end) rest = rest.slice(0, -1);
  for (const ch of rest) {
    if (ch === '*') source += '.*';
    else if (ch === '^') source += '(?:[^\\w.%-]|$)';
    else source += escapeRegex(ch);
  }
  return end ? `${source}$` : source;
}

// One line of the filter as a rule ({ p, h?, x?, u?, e? }: the parameter, the hosts it's
// limited to and those it isn't for, an address pattern, an exception), or null.
function parseLine(raw) {
  let line = raw.trim();
  if (!line || line.startsWith('!') || line.startsWith('[') || /#[@$%?]?#/.test(line)) return null;
  const exception = line.startsWith('@@');
  if (exception) line = line.slice(2);
  // The options start at the first `$` after which they all make sense (a regex value can
  // hold a `$` of its own).
  let options = null;
  let pattern = '';
  for (let i = line.indexOf('$'); i !== -1; i = line.indexOf('$', i + 1)) {
    if (line[i - 1] === '\\') continue;
    options = /(^|,)removeparam(=|,|$)/.test(line.slice(i + 1)) ? parseOptions(line.slice(i + 1)) : null;
    if (options) {
      pattern = line.slice(0, i);
      break;
    }
  }
  if (!options) return null;
  const rule = { p: options.param };
  if (options.domains) {
    const hosts = options.domains.filter((d) => !d.startsWith('~')).map((d) => d.toLowerCase());
    const excluded = options.domains.filter((d) => d.startsWith('~')).map((d) => d.slice(1).toLowerCase());
    if (hosts.length) rule.h = hosts;
    if (excluded.length) rule.x = excluded;
  }
  if (pattern && pattern !== '*') {
    if (/^\/.*\/$/.test(pattern)) return null;
    const host = /^\|\|([a-z0-9.-]+)\^?$/i.exec(pattern);
    if (host && !rule.h) {
      rule.h = [host[1].toLowerCase()];
    } else {
      rule.u = patternRegex(pattern);
      try {
        new RegExp(rule.u, 'i');
      } catch {
        return null;
      }
    }
  }
  if (exception) rule.e = 1;
  return rule;
}

// The filter's text as { version, updated, rules }.
function parseFilter(text) {
  const header = (name) => new RegExp(`^! ${name}: *(.+)$`, 'm').exec(text)?.[1].trim() ?? null;
  const seen = new Set();
  const rules = [];
  for (const line of text.split(/\r?\n/)) {
    const rule = parseLine(line);
    if (!rule) continue;
    const key = JSON.stringify(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push(rule);
  }
  return { title: header('Title'), version: header('Version'), updated: header('TimeUpdated'), rules };
}

// Why a parsed download isn't used, or null when it's fine.
function problemWith(parsed, previous) {
  if (!/URL Tracking/i.test(parsed.title ?? '')) return 'not the URL Tracking filter';
  if (parsed.rules.length < MIN_RULES) return `only ${parsed.rules.length} rules`;
  if (parsed.rules.length > MAX_RULES) return `${parsed.rules.length} rules`;
  if (previous && parsed.rules.length < previous.rules.length / 2) {
    return `${parsed.rules.length} rules, down from ${previous.rules.length}`;
  }
  return null;
}

async function readCapped(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('too big');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      reader.cancel().catch(() => {});
      throw new Error('too big');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// The list being served: { etag, list: { v, version, updated, source, licence, rules } }.
let current = null;
let lastAttempt = 0;
let lastSuccess = 0;

async function enabled() {
  // Required here: appSettings loads the database, which parseFilter doesn't need.
  return (await require('./appSettings').getSetting('linkRules')) !== 'off';
}

// Downloads and converts the filter; keeps the last good copy when anything goes wrong.
async function refreshLinkRules({ fetch: fetchImpl = fetch } = {}) {
  lastAttempt = Date.now();
  try {
    const response = await fetchImpl(FILTER_URL, { signal: AbortSignal.timeout(30000), headers: { 'user-agent': 'Voicaw' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = parseFilter(await readCapped(response));
    const problem = problemWith(parsed, current?.list);
    if (problem) throw new Error(problem);
    const list = {
      v: 1,
      version: parsed.version,
      updated: parsed.updated,
      source: 'https://github.com/AdguardTeam/AdguardFilters',
      licence: 'GPL-3.0',
      rules: parsed.rules,
    };
    const etag = crypto.createHash('sha256').update(JSON.stringify(list)).digest('hex').slice(0, 16);
    current = { etag, list };
    lastSuccess = Date.now();
    return true;
  } catch (err) {
    console.error('Tracking parameter list not updated:', err.message);
    return false;
  }
}

async function getLinkRules() {
  return (await enabled()) ? current : null;
}

// Downloads now, then checks hourly: again a day after the last good download, or an hour
// after a failed one.
function startLinkRules() {
  const tick = async () => {
    if (!(await enabled())) return;
    const now = Date.now();
    if (now - lastSuccess >= REFRESH_MS && now - lastAttempt >= RETRY_MS) await refreshLinkRules();
  };
  tick().catch((err) => console.error('Tracking parameter list check failed:', err.message));
  return setInterval(() => tick().catch((err) => console.error('Tracking parameter list check failed:', err.message)), RETRY_MS).unref();
}

function resetLinkRulesForTests() {
  current = null;
  lastAttempt = 0;
  lastSuccess = 0;
}

module.exports = { FILTER_URL, parseFilter, parseLine, refreshLinkRules, getLinkRules, startLinkRules, resetLinkRulesForTests };
