import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BOT_PERMISSIONS, toBitfield, fromBitfield, canGrant } from './botPermissions';
import { PERMISSIONS as P } from './permissions';

// server/discord.js needs the server's database to load, so its table is read as text:
// `[P.NAME, [bit, implied...]]` per permission.
const serverSource = readFileSync(new URL('../../../server/discord.js', import.meta.url), 'utf8');
const serverBits = Object.fromEntries([...serverSource.matchAll(/\[P\.(\w+), \[(\d+)/g)].map((m) => [m[1], Number(m[2])]));

describe('bot permissions', () => {
  it("offer exactly the server's mapping of our permissions to Discord's bits", () => {
    expect(Object.keys(serverBits).length).toBeGreaterThan(10);
    expect(Object.fromEntries(BOT_PERMISSIONS.map((p) => [p.ours, p.bit]))).toEqual(serverBits);
    for (const p of BOT_PERMISSIONS) expect(P[p.ours]).toBeTypeOf('number');
  });

  it('turn names into a bitfield and back', () => {
    const names = new Set(['VIEW_CHANNEL', 'SEND_MESSAGES', 'PIN_MESSAGES']);
    const bits = toBitfield(names);
    expect(bits).toBe(String((1n << 10n) | (1n << 11n) | (1n << 51n)));
    expect(fromBitfield(bits)).toEqual(names);
    // Bits we don't offer (Embed Links) and nonsense are left out.
    expect(fromBitfield(String(1n << 14n))).toEqual(new Set());
    expect(fromBitfield('abc')).toEqual(new Set());
  });

  it('only lets people grant what they have', () => {
    const kick = BOT_PERMISSIONS.find((p) => p.name === 'KICK_MEMBERS');
    expect(canGrant(P.KICK_MEMBERS | P.SEND_MESSAGES, kick)).toBe(true);
    expect(canGrant(P.SEND_MESSAGES, kick)).toBe(false);
  });
});
