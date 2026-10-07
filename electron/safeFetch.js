const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');

// Fetching URLs that people posted (linkPreviews.js), without letting them reach anything
// that isn't on the public internet: this host's own API, LiveKit, the object store, the home
// network, a cloud's metadata address. The address checked is the one connected to (our own
// DNS lookup, handed to the request), so a name can't resolve to a public address for the
// check and a private one for the connection. Every redirect is checked again. Only ports 80
// and 443. LINK_PREVIEWS_ALLOW_PRIVATE=1 lifts both checks, for tests and the e2e harness only
// (never on a real server).

const PRIVATE = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) PRIVATE.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) PRIVATE.addSubnet(address, prefix, 'ipv6');

// The IPv4 address inside an IPv4-mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::/96) one.
function embeddedIpv4(address) {
  const match = /^(?:::ffff:|64:ff9b::)(?:0:)?([0-9a-f.:]+)$/i.exec(address);
  if (!match) return null;
  if (net.isIPv4(match[1])) return match[1];
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(match[1]);
  if (!hex) return null;
  const [high, low] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

const allowPrivate = () => process.env.LINK_PREVIEWS_ALLOW_PRIVATE === '1';

function isPublicAddress(address) {
  if (allowPrivate()) return true;
  const family = net.isIP(address);
  if (family === 4) return !PRIVATE.check(address, 'ipv4');
  if (family !== 6) return false;
  const inner = embeddedIpv4(address);
  if (inner) return !PRIVATE.check(inner, 'ipv4');
  return !PRIVATE.check(address, 'ipv6');
}

class FetchError extends Error {}

// dns.lookup, keeping only public addresses (in the shape the caller asked for).
function publicLookup(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'object' && options ? options : {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const allowed = addresses.filter((a) => isPublicAddress(a.address));
    if (!allowed.length) return cb(new FetchError(`${hostname} is not a public address`));
    if (opts.all) return cb(null, allowed);
    cb(null, allowed[0].address, allowed[0].family);
  });
}

// One request (no redirects followed). Resolves to { status, headers, body, truncated }.
function requestOnce(url, { maxBytes, timeoutMs, headers }) {
  return new Promise((resolveRequest, rejectRequest) => {
    // The whole request (not only a quiet socket) must be done in time.
    const timer = setTimeout(() => req.destroy(new FetchError('Timed out')), timeoutMs);
    const resolve = (value) => {
      clearTimeout(timer);
      resolveRequest(value);
    };
    const reject = (err) => {
      clearTimeout(timer);
      rejectRequest(err);
    };
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      headers: { 'Accept-Encoding': 'gzip, deflate, br', ...headers },
      lookup: publicLookup,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return resolve({ status: res.statusCode, headers: res.headers, body: Buffer.alloc(0), truncated: false });
      }
      const type = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      const limit = typeof maxBytes === 'function' ? maxBytes(type) : maxBytes;
      const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
      let stream = res;
      if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      let size = 0;
      let done = false;
      const finish = (truncated) => {
        if (done) return;
        done = true;
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).subarray(0, limit), truncated });
      };
      if (limit <= 0) {
        finish(true);
        req.destroy();
        return;
      }
      stream.on('data', (chunk) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= limit) {
          finish(true);
          req.destroy();
        }
      });
      stream.on('end', () => finish(false));
      stream.on('error', (err) => (done ? null : reject(err)));
    });
    req.on('error', reject);
  });
}

// GETs `href` (http or https, port 80 or 443), following up to 5 redirects, reading at most
// `maxBytes` (decompressed; or a function of the content type giving it) within `timeoutMs`
// altogether. Resolves to { url (the last one), status, contentType (lower case, no parameters), charset, body (a Buffer), truncated }.
async function safeFetch(href, { maxBytes = 1024 * 1024, timeoutMs = 5000, headers = {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  let url = new URL(href);
  for (let redirects = 0; ; redirects += 1) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchError('Not a web address');
    if (url.port && !['80', '443'].includes(url.port) && !allowPrivate()) throw new FetchError('Only ports 80 and 443');
    if (url.username || url.password) throw new FetchError('No credentials in URLs');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // An address written out isn't looked up, so it's checked here.
    if (net.isIP(host) && !isPublicAddress(host)) throw new FetchError(`${host} is not a public address`);
    const left = deadline - Date.now();
    if (left <= 0) throw new FetchError('Timed out');
    const res = await requestOnce(url, { maxBytes, timeoutMs: left, headers });
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (redirects >= 5) throw new FetchError('Too many redirects');
      url = new URL(res.headers.location, url);
      continue;
    }
    const [type, ...params] = String(res.headers['content-type'] ?? '').split(';');
    const charset = params.map((p) => /^\s*charset\s*=\s*"?([\w.:-]+)"?/i.exec(p)?.[1]).find(Boolean) ?? null;
    return {
      url: url.href,
      status: res.status,
      contentType: type.trim().toLowerCase(),
      charset: charset?.toLowerCase() ?? null,
      body: res.body,
      truncated: res.truncated,
    };
  }
}

module.exports = { safeFetch, isPublicAddress, FetchError };
