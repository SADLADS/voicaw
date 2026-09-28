import { fromBase64 } from './encryptionService';

// Safety numbers, in the style of Signal's: two people compare them (in person or on a call)
// to confirm neither of them is talking to a key the server swapped in. Each person's half
// is 30 digits derived from their identity key and user id with iterated SHA-512 (to make
// finding a colliding key expensive); the full number is both halves, lower user id first,
// so both people see the same 60 digits.

const VERSION = 0;
const ITERATIONS = 5200;
const te = new TextEncoder();

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function fingerprintDigits(userId, identityKey) {
  const key = fromBase64(identityKey);
  let hash = concat(new Uint8Array([0, VERSION]), key, te.encode(String(userId)));
  for (let i = 0; i < ITERATIONS; i++) {
    hash = new Uint8Array(await crypto.subtle.digest('SHA-512', concat(hash, key)));
  }
  // Six 5-byte chunks -> six 5-digit groups.
  let digits = '';
  for (let chunk = 0; chunk < 6; chunk++) {
    let value = 0n;
    for (let b = 0; b < 5; b++) value = (value << 8n) | BigInt(hash[chunk * 5 + b]);
    digits += (value % 100000n).toString().padStart(5, '0');
  }
  return digits;
}

// `a`/`b`: { id, identityKey }. Returns 60 digits as 12 space-separated groups of 5.
export async function computeSafetyNumber(a, b) {
  const [first, second] = [a, b].sort((x, y) => Number(x.id) - Number(y.id));
  const digits =
    (await fingerprintDigits(first.id, first.identityKey)) +
    (await fingerprintDigits(second.id, second.identityKey));
  return digits.match(/.{5}/g).join(' ');
}
