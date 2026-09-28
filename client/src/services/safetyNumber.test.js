import { describe, it, expect } from 'vitest';
import { generateUserKeys } from './encryptionService';
import { computeSafetyNumber } from './safetyNumber';

describe('safety numbers', () => {
  it('are 60 digits in 12 groups, identical for both people', async () => {
    const alice = { id: 1, identityKey: (await generateUserKeys()).public.identityKey };
    const bob = { id: 2, identityKey: (await generateUserKeys()).public.identityKey };

    const fromAlice = await computeSafetyNumber(alice, bob);
    const fromBob = await computeSafetyNumber(bob, alice);

    expect(fromAlice).toMatch(/^(\d{5} ){11}\d{5}$/);
    expect(fromAlice).toBe(fromBob);
  });

  it('change if either key is swapped', async () => {
    const alice = { id: 1, identityKey: (await generateUserKeys()).public.identityKey };
    const bob = { id: 2, identityKey: (await generateUserKeys()).public.identityKey };
    const mallory = { id: 2, identityKey: (await generateUserKeys()).public.identityKey };

    const real = await computeSafetyNumber(alice, bob);
    const swapped = await computeSafetyNumber(alice, mallory);
    expect(swapped).not.toBe(real);
    // Only Bob's half differs.
    expect(swapped.slice(0, 35)).toBe(real.slice(0, 35));
  });
});
