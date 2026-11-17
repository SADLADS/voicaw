// Taking tracking parameters out of links (Settings → Privacy → Remove tracking from pasted
// links; services/linkRules.js decides which rules and when). Rules come from the server's copy
// of AdGuard's URL Tracking filter (server/linkRules.js, which writes this format) and our own
// list (linkRulesBuiltIn.js). A rule is { p, h?, x?, u?, e? }:
// - `p`: the parameter: its name, `/regex/` or `/regex/i` (tested against `name=value`), or
//   `*` for every one;
// - `h`: only on these hosts and their subdomains (`google.*` is google with any ending);
//   `x`: not on these;
// - `u`: only on links matching this regex (case-insensitive);
// - `e`: an exception: parameters it matches are kept, whatever the other rules say.
// Only what's removed changes: the rest of the link keeps its exact text (encoding, order,
// `#fragment`), and a link with nothing to remove is left exactly as it was.

function hostMatches(host, domain) {
  if (domain.endsWith('.*')) {
    // `base` then an ending of one or two labels (com, co.uk...), with any subdomains before.
    const labels = host.split('.');
    const base = domain.slice(0, -2);
    for (let ending = 1; ending <= 2 && ending < labels.length; ending++) {
      const rest = labels.slice(0, -ending).join('.');
      if (rest === base || rest.endsWith(`.${base}`)) return true;
    }
    return false;
  }
  return host === domain || host.endsWith(`.${domain}`);
}

function compileParam(p) {
  if (p === '*') return () => true;
  const regex = /^\/(.+)\/(i?)$/.exec(p);
  if (regex) {
    let re;
    try {
      re = new RegExp(regex[1], regex[2]);
    } catch {
      return null;
    }
    return (name, value) => re.test(`${name}=${value}`);
  }
  return (name) => name === p;
}

function compileRule(rule) {
  if (!rule || typeof rule.p !== 'string') return null;
  const param = compileParam(rule.p);
  if (!param) return null;
  let url = null;
  if (typeof rule.u === 'string') {
    try {
      url = new RegExp(rule.u, 'i');
    } catch {
      return null;
    }
  }
  const hosts = Array.isArray(rule.h) ? rule.h : null;
  const excluded = Array.isArray(rule.x) ? rule.x : null;
  return {
    exception: !!rule.e,
    param,
    appliesTo(link) {
      if (hosts && !hosts.some((d) => hostMatches(link.host, d))) return false;
      if (excluded && excluded.some((d) => hostMatches(link.host, d))) return false;
      return !url || url.test(link.href);
    },
  };
}

// Lists of rules as one ruleset (`cleanLink` and `cleanLinksInText` take it). Rules that
// don't make sense are skipped.
export function compileRules(...lists) {
  const remove = [];
  const keep = [];
  for (const list of lists) {
    for (const rule of Array.isArray(list) ? list : []) {
      const compiled = compileRule(rule);
      if (compiled) (compiled.exception ? keep : remove).push(compiled);
    }
  }
  return { remove, keep };
}

function decode(text) {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

// The link without its tracking parameters (unchanged if it has none, or isn't a link).
export function cleanLink(text, rules) {
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return text;
  }
  if (!/^https?:$/.test(parsed.protocol)) return text;
  const hash = text.indexOf('#');
  const beforeHash = hash === -1 ? text : text.slice(0, hash);
  const fragment = hash === -1 ? '' : text.slice(hash);
  const question = beforeHash.indexOf('?');
  if (question === -1) return text;
  const link = { host: parsed.hostname.toLowerCase(), href: parsed.href };
  const remove = rules.remove.filter((rule) => rule.appliesTo(link));
  if (!remove.length) return text;
  const keep = rules.keep.filter((rule) => rule.appliesTo(link));
  const parts = beforeHash.slice(question + 1).split('&');
  const kept = parts.filter((part) => {
    if (!part) return false;
    const equals = part.indexOf('=');
    const name = decode(equals === -1 ? part : part.slice(0, equals));
    const value = equals === -1 ? '' : decode(part.slice(equals + 1));
    if (!remove.some((rule) => rule.param(name, value))) return true;
    return keep.some((rule) => rule.param(name, value));
  });
  if (kept.length === parts.filter(Boolean).length) return text;
  const base = beforeHash.slice(0, question);
  return `${base}${kept.length ? `?${kept.join('&')}` : ''}${fragment}`;
}

const LINK_RE = /https?:\/\/[^\s<>"'`|]+/gi;
// Code (```blocks``` and `spans`) is left as written: a command or an example may need its
// parameters.
const CODE_RE = /```[\s\S]*?```|`[^`\n]*`/g;

function cleanLinksInPlain(text, rules) {
  return text.replace(LINK_RE, (match) => {
    // Punctuation after a link (and a closing bracket it didn't open) isn't part of it, as in
    // utils/linkPreviews.js linksIn.
    let link = match.replace(/[.,!?:;*_~]+$/, '');
    while (link.endsWith(')') && (link.match(/\(/g)?.length ?? 0) < (link.match(/\)/g)?.length ?? 0)) {
      link = link.slice(0, -1).replace(/[.,!?:;*_~]+$/, '');
    }
    return cleanLink(link, rules) + match.slice(link.length);
  });
}

// The text with every link in it cleaned (but those in code).
export function cleanLinksInText(text, rules) {
  if (typeof text !== 'string' || !/https?:\/\//i.test(text)) return text;
  let out = '';
  let at = 0;
  for (const code of text.matchAll(CODE_RE)) {
    out += cleanLinksInPlain(text.slice(at, code.index), rules) + code[0];
    at = code.index + code[0].length;
  }
  return out + cleanLinksInPlain(text.slice(at), rules);
}
