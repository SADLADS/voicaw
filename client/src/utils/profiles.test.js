import { describe, it, expect, beforeEach } from 'vitest';
import { clearProfiles, displayName, getProfile, mergeProfiles, nameOf } from './profiles';

beforeEach(() => clearProfiles());

describe('profiles', () => {
  it('shows the display name, else the username, else the fallback', () => {
    mergeProfiles([{ id: 1, username: 'alice', display_name: 'Alice' }, { id: 2, username: 'bob' }]);
    expect(displayName(1)).toBe('Alice');
    expect(displayName(2)).toBe('bob');
    expect(displayName(3, 'carol')).toBe('carol');
  });

  it('keeps fields a later list leaves out, and the newest wins over an object passed in', () => {
    mergeProfiles([{ id: 1, username: 'alice', display_name: 'Alice', bio: 'Hi' }]);
    mergeProfiles([{ id: 1, username: 'alice' }]); // a list without profile fields
    expect(getProfile(1)).toMatchObject({ display_name: 'Alice', bio: 'Hi' });
    mergeProfiles([{ id: 1, username: 'alice', display_name: null }]); // cleared
    expect(nameOf({ id: 1, username: 'alice', display_name: 'Alice (old copy)' })).toBe('alice');
  });
});
