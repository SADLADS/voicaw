import { describe, expect, it } from 'vitest';
import { inviteCodeFromUrl } from './inviteLinks';

describe('inviteCodeFromUrl', () => {
  it('reads codes from voicaw links', () => {
    expect(inviteCodeFromUrl('https://voicaw.com/invite/Ab3dEf7h')).toBe('Ab3dEf7h');
    expect(inviteCodeFromUrl('https://test.voicaw.com/invite/Ab3dEf7h/')).toBe('Ab3dEf7h');
    expect(inviteCodeFromUrl('http://www.voicaw.com/invite/xyz12345')).toBe('xyz12345');
    expect(inviteCodeFromUrl('https://voicaw.com/invite/cool-guild')).toBe('cool-guild');
  });

  it('ignores other links', () => {
    expect(inviteCodeFromUrl('https://example.com/invite/Ab3dEf7h')).toBeNull();
    expect(inviteCodeFromUrl('https://notvoicaw.com/invite/Ab3dEf7h')).toBeNull();
    expect(inviteCodeFromUrl('https://voicaw.com/invite/Ab3dEf7h/extra')).toBeNull();
    expect(inviteCodeFromUrl('https://voicaw.com/guild/1')).toBeNull();
    expect(inviteCodeFromUrl('ftp://voicaw.com/invite/Ab3dEf7h')).toBeNull();
    expect(inviteCodeFromUrl('not a link')).toBeNull();
  });
});
