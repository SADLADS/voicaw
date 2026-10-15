import { describe, it, expect } from 'vitest';
import { sameLogin, tokenClaims } from './loginToken';

const tokenFor = (claims, signature = 'sig') => `h.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.${signature}`;

describe('login tokens', () => {
  it('reads the claims, or null', () => {
    expect(tokenClaims(tokenFor({ id: 3, sid: 'abc' }))).toEqual({ id: 3, sid: 'abc' });
    expect(tokenClaims('not a token')).toBeNull();
    expect(tokenClaims(null)).toBeNull();
  });

  it('counts a renewed token as the same login, another session as not', () => {
    expect(sameLogin(tokenFor({ sid: 'a' }, 'one'), tokenFor({ sid: 'a' }, 'two'))).toBe(true);
    expect(sameLogin(tokenFor({ sid: 'a' }), tokenFor({ sid: 'b' }))).toBe(false);
    // Tokens from before login sessions: only the same token.
    expect(sameLogin(tokenFor({ id: 1 }, 'one'), tokenFor({ id: 1 }, 'two'))).toBe(false);
    expect(sameLogin('x', 'x')).toBe(true);
    expect(sameLogin('x', null)).toBe(false);
  });
});
