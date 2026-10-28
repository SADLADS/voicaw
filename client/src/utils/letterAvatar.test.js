import { describe, expect, it } from 'vitest';
import { letterAvatar, letterAvatarColour } from './letterAvatar';

const svgOf = (url) => decodeURIComponent(url.replace('data:image/svg+xml,', ''));

describe('letterAvatar', () => {
  it('draws the username\'s first character, upper-cased', () => {
    expect(svgOf(letterAvatar(7, 'alice'))).toContain('>A</text>');
  });

  it('keeps a character outside the BMP whole', () => {
    expect(svgOf(letterAvatar(7, '😀bob'))).toContain('>😀</text>');
  });

  it('escapes markup', () => {
    expect(svgOf(letterAvatar(7, '<b>'))).toContain('>&lt;</text>');
  });

  it('draws only the colour without a username', () => {
    expect(svgOf(letterAvatar(7, undefined))).toContain('></text>');
  });

  it('picks the colour from the id alone', () => {
    expect(letterAvatarColour(7)).toBe(letterAvatarColour('7'));
    expect(svgOf(letterAvatar(7, 'alice'))).toContain(letterAvatarColour(7));
    expect(svgOf(letterAvatar(7, 'zed'))).toContain(letterAvatarColour(7));
    const colours = new Set(Array.from({ length: 50 }, (_, i) => letterAvatarColour(i)));
    expect(colours.size).toBeGreaterThan(6);
  });
});
