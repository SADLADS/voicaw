const crypto = require('crypto');
const db = require('./db');

// Two-factor authentication (optional, off until someone turns it on in Settings → My Account):
// an authenticator app's six-digit codes (TOTP, RFC 6238: HMAC-SHA1, 30 s steps, which every
// app speaks) and ten single-use backup codes. With it on, a right password alone gets a
// ticket, not a session or the key backup: `/login/two-factor` swaps the ticket and a code for
// them. Resetting the password with the recovery code needs a code too.
//
// The server has to know the secret to check codes, so `users.two_factor_secret` is kept as is
// (it's a second factor for logging in to this server, not part of the encryption). Backup
// codes are kept only as SHA-256 hashes (40 random bits each, and checking is rate limited).

const STEP_SECONDS = 30;
const DIGITS = 6;
// A code from the step before or after counts too (clocks drift, typing takes time).
const DRIFT_STEPS = 1;
const SECRET_BYTES = 20;
const BACKUP_CODE_COUNT = 10;
// No 0/o, 1/l/i: backup codes are read off paper.
const BACKUP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const TICKET_SECONDS = 300;
const TICKET_ATTEMPTS = 5;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

// Bytes from base32 (any case, spaces and padding ignored), or null if it isn't base32.
function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// A secret as the client makes it (secretFromClient checks one): 20 random bytes in base32.
const newSecret = () => base32Encode(crypto.randomBytes(SECRET_BYTES));

// The secret in a request, normalised, or null: base32 of exactly 20 bytes.
function secretFromClient(text) {
  if (typeof text !== 'string' || text.length > 64) return null;
  const bytes = base32Decode(text);
  return bytes?.length === SECRET_BYTES ? base32Encode(bytes) : null;
}

// The code for `step` (30-second steps since 1970).
function totp(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const number = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(number).padStart(DIGITS, '0');
}

const currentStep = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / STEP_SECONDS);

// The step `code` is right for (now, give or take DRIFT_STEPS), if it's later than
// `lastStep` (each code works once), else null.
function matchTotp(secret, code, lastStep = null, nowMs = Date.now()) {
  const digits = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const now = currentStep(nowMs);
  for (let step = now - DRIFT_STEPS; step <= now + DRIFT_STEPS; step++) {
    if (lastStep != null && step <= lastStep) continue;
    const expected = Buffer.from(totp(secret, step));
    if (crypto.timingSafeEqual(expected, Buffer.from(digits))) return step;
  }
  return null;
}

// Backup codes as people see them ("abcd-efgh"), and the hashes kept.
const normaliseBackupCode = (code) => String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hashBackupCode = (code) => crypto.createHash('sha256').update(`voicaw/backup-code/v1\n${normaliseBackupCode(code)}`).digest('hex');

function newBackupCodes() {
  const codes = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    let code = '';
    for (let j = 0; j < 8; j++) code += BACKUP_ALPHABET[crypto.randomInt(BACKUP_ALPHABET.length)];
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
  }
  return codes;
}

const parseHashes = (json) => {
  try {
    const hashes = JSON.parse(json || '[]');
    return Array.isArray(hashes) ? hashes : [];
  } catch {
    return [];
  }
};

// Whether two-factor is on for `userId`, and how many backup codes are left.
async function status(userId) {
  const user = await db.get('SELECT two_factor_secret, two_factor_backup_codes FROM users WHERE id = ?', [userId]);
  const enabled = Boolean(user?.two_factor_secret);
  return { enabled, backupCodesLeft: enabled ? parseHashes(user.two_factor_backup_codes).length : 0 };
}

const isEnabled = async (userId) => (await status(userId)).enabled;

// Turns two-factor on with `secret` (checked by the caller) and new backup codes, which it
// resolves to (shown once).
async function enable(userId, secret, step) {
  const codes = newBackupCodes();
  await db.run(
    'UPDATE users SET two_factor_secret = ?, two_factor_backup_codes = ?, two_factor_last_step = ? WHERE id = ?',
    [secret, JSON.stringify(codes.map(hashBackupCode)), step, userId]
  );
  return codes;
}

async function disable(userId) {
  await db.run(
    'UPDATE users SET two_factor_secret = NULL, two_factor_backup_codes = NULL, two_factor_last_step = NULL WHERE id = ?',
    [userId]
  );
}

// New backup codes in place of the old ones (which stop working). Resolves to them.
async function replaceBackupCodes(userId) {
  const codes = newBackupCodes();
  await db.run('UPDATE users SET two_factor_backup_codes = ? WHERE id = ?', [JSON.stringify(codes.map(hashBackupCode)), userId]);
  return codes;
}

// Checks `code` (the app's six digits, or a backup code, which is then used up) for a user
// with two-factor on. Resolves to 'totp', 'backup' or null (wrong, or a code already used).
async function checkCode(userId, code) {
  if (typeof code !== 'string' || code.length > 32) return null;
  return db.transaction(async () => {
    const user = await db.get(
      'SELECT two_factor_secret, two_factor_backup_codes, two_factor_last_step FROM users WHERE id = ?', [userId]
    );
    if (!user?.two_factor_secret) return null;
    const step = matchTotp(user.two_factor_secret, code, user.two_factor_last_step);
    if (step != null) {
      await db.run('UPDATE users SET two_factor_last_step = ? WHERE id = ?', [step, userId]);
      return 'totp';
    }
    const normalised = normaliseBackupCode(code);
    if (normalised.length !== 8) return null;
    const hash = hashBackupCode(normalised);
    const hashes = parseHashes(user.two_factor_backup_codes);
    const index = hashes.findIndex((h) => h.length === hash.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash)));
    if (index < 0) return null;
    hashes.splice(index, 1);
    await db.run('UPDATE users SET two_factor_backup_codes = ? WHERE id = ?', [JSON.stringify(hashes), userId]);
    return 'backup';
  });
}

// Login tickets: a right password for an account with two-factor gets one of these instead of
// a session. Kept in memory (a restart only means typing the password again), by hash.
const tickets = new Map(); // sha256(ticket) -> { userId, expiresAt, attempts }
const ticketKey = (ticket) => crypto.createHash('sha256').update(String(ticket)).digest('hex');

function pruneTickets(now = Date.now()) {
  for (const [key, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(key);
}

function createTicket(userId) {
  pruneTickets();
  const ticket = crypto.randomBytes(32).toString('base64url');
  tickets.set(ticketKey(ticket), { userId, expiresAt: Date.now() + TICKET_SECONDS * 1000, attempts: 0 });
  return ticket;
}

// The ticket's user id, counting an attempt (after TICKET_ATTEMPTS it's gone and the password
// has to be typed again), or null if it's unknown or expired.
function useTicket(ticket) {
  if (typeof ticket !== 'string') return null;
  const key = ticketKey(ticket);
  const entry = tickets.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    tickets.delete(key);
    return null;
  }
  entry.attempts += 1;
  if (entry.attempts >= TICKET_ATTEMPTS) tickets.delete(key);
  return entry.userId;
}

const endTicket = (ticket) => tickets.delete(ticketKey(ticket));

module.exports = {
  STEP_SECONDS, BACKUP_CODE_COUNT, TICKET_ATTEMPTS,
  base32Encode, base32Decode, newSecret, secretFromClient, totp, currentStep, matchTotp,
  status, isEnabled, enable, disable, replaceBackupCodes, checkCode,
  createTicket, useTicket, endTicket,
};
